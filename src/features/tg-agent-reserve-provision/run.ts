// features/tg-agent-reserve-provision/run.ts — третий путь подготовки (provision-в-резерв,
// persona-account-reserve §5). Из списка ссылок на tdata делает ПОЛНОСТЬЮ настроенные под
// персону аккаунты (гигиена → профиль/фото → публичный канал персоны с постом и уже
// вставленной персональной инвайт-ссылкой → агентская сессия) и промоутит каждый в резерв
// workspace-reserve-<persona>-<K>, а не в рабочий контур.
//
// Структура повторяет tg-agent-pool-provision/run.ts (download-batch → цикл с human-pacing
// → финализация), логика настройки аккаунта (core/tdata/account-setup) НЕ меняется:
// используем prepareAccount(createPublicChannel=false) + отдельный createPersonaChannel(link).
// Единственные отличия от единого процесса autoregistration: (а) промоушен в резерв;
// (б) инвайт-ссылка экспортируется и вставляется в пост в самом скилле (R4/AC-11).

import * as fs from "fs";
import * as path from "path";

import type { Logger } from "../../core/logger";
import type { AccountConfig, DeviceConfig, ProxyConfig } from "../../core/config";
import { loadAccountDefaults, REPORT_AGENT_ID, FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { pickDevice, usedComboCounts } from "../../core/device-pool";
import { TelegramService } from "../../core/telegram/service";
import { connectBootstrap, readAccountPhone, prepareAccount, createPersonaChannel, TdataSetupError } from "../../core/tdata";
import { generateUsername } from "../../core/pool-accounts";
import { upsertPrivateInviteLink, markPostUpdated } from "../../core/db/private-invites";
import { loadPersonaTemplate, PersonaTemplateError, type PersonaTemplate } from "../tg-agent-autoregistration/persona-template";
import { selectWorkingProxy, type ProxySelectionOutcome } from "../tg-agent-autoregistration/proxy-selection";
import { registerAgenticSession, type AgenticSessionOutcome } from "../tg-agent-autoregistration/agentic-session";
import { downloadTdataArchive } from "../tg-agent-autoregistration/run";
import {
    stagingTdataDir,
    stagingDir,
    writeStagingStatus,
    readStagingStatus,
    computeNextReserveNumber,
    promoteToReserve,
    type ReserveAccountStatus,
} from "./staging";
import { reserveId as makeReserveId, parseReserveId } from "../../core/reserve-accounts";

export interface ReserveProvisionParams {
    personName: string;
    /** Ссылки на tdata-архивы, по одной на аккаунт (Mega folder-share или Google Drive file-ссылка). */
    links: string[];
    /**
     * Текущий 2FA-пароль пачки (ввод оператора). Необязателен: если на аккаунтах пачки
     * 2FA нет — не передавать (пусто). change2FA авторизуется пустым паролем и ставит
     * целевой; если 2FA всё же есть, а пароль пропущен — этот аккаунт уйдёт в setup_failed.
     */
    twoFaPassword?: string;
    proxyRegion: string;
    maxProxyAttempts: number;
}

export interface ReserveAccountResult {
    reserveId: string;
    status: ReserveAccountStatus;
    error?: string;
}

export interface ReserveProvisionReport {
    results: ReserveAccountResult[];
    /** Заполнено, если прогон не начался вообще (pre-flight). */
    abortReason?: string;
}

// ── Устройство (реальная модель, не пересекающаяся с другими агентами) ──────

function stagingDevicePath(reserveId: string): string {
    return path.join(stagingDir(reserveId), "device.json");
}

/** Устройство для аккаунта резерва — из стейджинга (ретрай) либо подбор+сохранение. Идемпотентно. */
function assignDevice(reserveId: string): DeviceConfig {
    try {
        return JSON.parse(fs.readFileSync(stagingDevicePath(reserveId), "utf-8")) as DeviceConfig;
    } catch {
        // не назначено — подобрать ниже
    }
    const device: DeviceConfig = { ...pickDevice(usedComboCounts()), langCode: "ru", systemLangCode: "ru" };
    fs.mkdirSync(stagingDir(reserveId), { recursive: true });
    const tmp = `${stagingDevicePath(reserveId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(device, null, 2), "utf-8");
    fs.renameSync(tmp, stagingDevicePath(reserveId));
    return device;
}

function clearStagedDevice(reserveId: string): void {
    fs.rmSync(stagingDevicePath(reserveId), { force: true });
}

// ── Username (персистится в стейджинге — ретрай переиспользует тот же, что уже применён) ──

function stagingUsernamePath(reserveId: string): string {
    return path.join(stagingDir(reserveId), "username.txt");
}

/**
 * Username аккаунта — из стейджинга, если уже сгенерирован (ретрай), иначе генерирует
 * новый и сохраняет. Идемпотентна: ретрай должен переиспользовать тот же username,
 * что уже применён к Telegram-аккаунту (UpdateUsername в prepareAccount), а не другой.
 */
function assignUsername(reserveId: string, nickPrefix: string): string {
    try {
        const existing = fs.readFileSync(stagingUsernamePath(reserveId), "utf-8").trim();
        if (existing) return existing;
    } catch {
        // не сгенерирован ранее — ниже
    }
    const username = generateUsername(nickPrefix);
    fs.mkdirSync(stagingDir(reserveId), { recursive: true });
    const tmp = `${stagingUsernamePath(reserveId)}.tmp`;
    fs.writeFileSync(tmp, username, "utf-8");
    fs.renameSync(tmp, stagingUsernamePath(reserveId));
    return username;
}

function clearStagedUsername(reserveId: string): void {
    fs.rmSync(stagingUsernamePath(reserveId), { force: true });
}

// Пауза между аккаунтами пачки (human-pacing, уровень B) — как в фазах 1/2.
const ACCOUNT_GAP_MIN_SEC = 90;
const ACCOUNT_GAP_MAX_SEC = 240;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function humanAccountDelay(): Promise<void> {
    return sleep((ACCOUNT_GAP_MIN_SEC + Math.random() * (ACCOUNT_GAP_MAX_SEC - ACCOUNT_GAP_MIN_SEC)) * 1000);
}

export async function runReserveProvision(params: ReserveProvisionParams, log: Logger): Promise<ReserveProvisionReport> {
    const { personName, links, twoFaPassword, proxyRegion, maxProxyAttempts } = params;

    // Pre-flight (до скачивания): шаблон персоны с канальными файлами (канал создаётся —
    // requireChannel=true), общая заготовка учётных данных, непустой links.
    let template: PersonaTemplate;
    try {
        template = loadPersonaTemplate(personName, true);
    } catch (err: any) {
        if (err instanceof PersonaTemplateError) {
            log.error(`[tg-agent-reserve-provision] ${err.message}`);
            return { results: [], abortReason: err.message };
        }
        throw err;
    }

    let defaults;
    try {
        defaults = loadAccountDefaults();
    } catch (err: any) {
        const reason = `account-defaults недоступен: ${err?.message ?? err} — прогон не начат`;
        log.error(`[tg-agent-reserve-provision] ${reason}`);
        return { results: [], abortReason: reason };
    }
    if (links.length === 0) {
        return { results: [], abortReason: "links пуст — прогон не начат" };
    }

    // Метки K: base..base+N-1 (пер-персонная нумерация по сырым именам, включая карантин/стейджинг).
    const base = computeNextReserveNumber(personName);
    const reserveIds = links.map((_, i) => makeReserveId(personName, base + i));

    // Batch-скачивание в стейджинг до обработки любого аккаунта.
    const downloadFailed = new Map<string, string>();
    for (let i = 0; i < links.length; i++) {
        const rid = reserveIds[i];
        const tdataDir = stagingTdataDir(rid);
        fs.mkdirSync(tdataDir, { recursive: true });
        try {
            await downloadTdataArchive(links[i], tdataDir, log);
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            log.error(`[tg-agent-reserve-provision] ${rid} — ошибка скачивания: ${msg}`);
            writeStagingStatus(rid, "setup_failed", `download: ${msg}`);
            downloadFailed.set(rid, msg);
        }
    }

    // Персональная инвайт-ссылка экспортируется от REPORT_AGENT_ID — единое соединение на
    // всю пачку (как в фазе 2). funnelPrivateChannelId берётся из персоны; без него —
    // канал создаётся с текстом post.txt как есть (реестр не трогаем), пост можно
    // достроить отдельным прогоном private-invite-links.
    const funnelChannelId = template.profileData.funnelPrivateChannelId;
    const inviteService = new TelegramService(log);
    if (funnelChannelId) inviteService.loadAccount(REPORT_AGENT_ID);

    const results: ReserveAccountResult[] = [];
    try {
        // Уровень B: пауза перед каждым реально обрабатываемым аккаунтом, кроме первого.
        let processedAny = false;
        for (const rid of reserveIds) {
            if (downloadFailed.has(rid)) {
                results.push({ reserveId: rid, status: "setup_failed", error: `download: ${downloadFailed.get(rid)}` });
                continue;
            }
            if (processedAny) {
                log.info(`[tg-agent-reserve-provision] пауза между аккаунтами (human-pacing) перед ${rid}`);
                await humanAccountDelay();
            }
            processedAny = true;
            try {
                results.push(await processReserveAccount(
                    rid, template, defaults, twoFaPassword ?? "", funnelChannelId, inviteService, proxyRegion, maxProxyAttempts, log,
                ));
            } catch (err: any) {
                log.error(`[tg-agent-reserve-provision] ${rid} — непредвиденная ошибка: ${err?.message ?? err}`);
                writeStagingStatus(rid, "setup_failed", err?.message ?? String(err));
                results.push({ reserveId: rid, status: "setup_failed", error: err?.message ?? String(err) });
            }
        }
    } finally {
        if (funnelChannelId) await inviteService.disconnectAgent(REPORT_AGENT_ID).catch(() => {});
    }

    return { results };
}

async function processReserveAccount(
    reserveId: string,
    template: PersonaTemplate,
    defaults: { apiId: number; apiHash: string; "2fa": string },
    currentPassword: string,
    funnelChannelId: string | undefined,
    inviteService: TelegramService,
    proxyRegion: string,
    maxProxyAttempts: number,
    log: Logger,
): Promise<ReserveAccountResult> {
    const tdataPath = stagingTdataDir(reserveId);
    const username = assignUsername(reserveId, template.profileData.nick);
    const device = assignDevice(reserveId);
    const { apiId, apiHash } = defaults;

    let outcome;
    try {
        outcome = await selectWorkingProxy(
            reserveId,
            proxyRegion,
            maxProxyAttempts,
            async (proxy) => {
                const client = await connectBootstrap(tdataPath, proxy, apiId, apiHash, device, log);
                try {
                    const phoneNumber = await readAccountPhone(client);
                    // Гигиена/2FA/сброс сессий/профиль/фото — БЕЗ создания канала (создаём ниже с инвайт-ссылкой).
                    await prepareAccount(client, template, currentPassword, username, log, /*createPublicChannel*/ false);

                    // Персональная инвайт-ссылка в приватный канал воронки — от REPORT_AGENT_ID,
                    // ДО создания поста (ключ реестра — reserveId, финальный agentId ещё не присвоен).
                    let inviteLink: string | undefined;
                    if (funnelChannelId) {
                        const { link } = await inviteService.exportChatInvite(funnelChannelId, { title: reserveId });
                        inviteLink = link;
                        upsertPrivateInviteLink(FUNNEL_ADMIN_AGENT_ID, reserveId, link, Math.floor(Date.now() / 1000));
                        log.info(`[tg-agent-reserve-provision] ${reserveId}: инвайт-ссылка создана`);
                    } else {
                        log.warn(`[tg-agent-reserve-provision] ${reserveId}: у персоны "${template.personName}" не задан funnelPrivateChannelId — пост с текстом post.txt как есть`);
                    }

                    // Публичный канал персоны с постом (ссылка уже вставлена в пост, если получена).
                    await createPersonaChannel(client, template, username, log, inviteLink);
                    if (inviteLink) {
                        markPostUpdated(FUNNEL_ADMIN_AGENT_ID, reserveId);
                        log.info(`[tg-agent-reserve-provision] ${reserveId}: ссылка вставлена в пост (post_updated=1)`);
                    }

                    const agentic = await registerAgenticSession(
                        client, apiId, apiHash, phoneNumber, proxy, defaults["2fa"], log,
                    );
                    return { agentic, proxy };
                } catch (err: any) {
                    if (err instanceof TdataSetupError) throw err;
                    throw new TdataSetupError("UNKNOWN", `подготовка/канал/сессия: ${err?.message ?? err}`, err);
                } finally {
                    await client.disconnect().catch(() => {});
                }
            },
            log,
        );
    } catch (err: any) {
        if (err instanceof TdataSetupError) {
            writeStagingStatus(reserveId, "setup_failed", `${err.telegramCode}: ${err.message}`);
            return { reserveId, status: "setup_failed", error: err.message };
        }
        throw err;
    }

    return finalize(reserveId, outcome, defaults, username, device);
}

function finalize(
    reserveId: string,
    outcome: ProxySelectionOutcome<{ agentic: AgenticSessionOutcome; proxy: ProxyConfig }>,
    defaults: { apiId: number; apiHash: string },
    username: string,
    device: DeviceConfig,
): ReserveAccountResult {
    if (outcome.kind === "exhausted") {
        writeStagingStatus(reserveId, "proxy_failed");
        return { reserveId, status: "proxy_failed" };
    }
    const { agentic, proxy } = outcome.value;
    if (agentic.kind === "code_timeout") {
        writeStagingStatus(reserveId, "needs_manual_code");
        return { reserveId, status: "needs_manual_code" };
    }

    const parsed = parseReserveId(reserveId);
    const accountConfig: AccountConfig = {
        accountId: reserveId,
        apiId: defaults.apiId,
        apiHash: defaults.apiHash,
        sessionString: agentic.sessionString,
        // Момент авторизации фиксируется вместе с sessionString (tg-peer-identity-model).
        sessionAuthorizedAt: Math.floor(Date.now() / 1000),
        persona: parsed ? parsed.persona : "",
        username,
        proxy,
        device,
    };
    clearStagedDevice(reserveId);
    clearStagedUsername(reserveId);
    promoteToReserve(reserveId, accountConfig);
    return { reserveId, status: "done" };
}

/**
 * Ретрай второй (агентской) сессии для аккаунта резерва в статусе needs_manual_code —
 * без повторной гигиены и без повторного создания канала/инвайт-ссылки (уже применены
 * к реальному Telegram-аккаунту в первой попытке). Калька retryPoolManualCode.
 */
export async function retryReserveManualCode(
    reserveId: string,
    proxyRegion: string,
    maxProxyAttempts: number,
    log: Logger,
): Promise<ReserveAccountResult> {
    const status = readStagingStatus(reserveId);
    if (!status || status.status !== "needs_manual_code") {
        throw new Error(
            `аккаунт резерва ${reserveId}: ожидался статус needs_manual_code в стейджинге, сейчас: ${status?.status ?? "запись отсутствует"}`,
        );
    }
    const defaults = loadAccountDefaults();
    const device = assignDevice(reserveId);
    const username = assignUsername(reserveId, parseReserveId(reserveId)?.persona ?? reserveId);
    const { apiId, apiHash } = defaults;

    let outcome;
    try {
        outcome = await selectWorkingProxy(
            reserveId,
            proxyRegion,
            maxProxyAttempts,
            async (proxy) => {
                const client = await connectBootstrap(stagingTdataDir(reserveId), proxy, apiId, apiHash, device, log);
                try {
                    const phoneNumber = await readAccountPhone(client);
                    const agentic = await registerAgenticSession(
                        client, apiId, apiHash, phoneNumber, proxy, defaults["2fa"], log,
                    );
                    return { agentic, proxy };
                } catch (err: any) {
                    if (err instanceof TdataSetupError) throw err;
                    throw new TdataSetupError("UNKNOWN", `повторная регистрация сессии: ${err?.message ?? err}`, err);
                } finally {
                    await client.disconnect().catch(() => {});
                }
            },
            log,
        );
    } catch (err: any) {
        if (err instanceof TdataSetupError) {
            writeStagingStatus(reserveId, "setup_failed", `${err.telegramCode}: ${err.message}`);
            return { reserveId, status: "setup_failed", error: err.message };
        }
        throw err;
    }

    return finalize(reserveId, outcome, defaults, username, device);
}

/** Итоговый отчёт по каждому аккаунту (R9/AC-10) — печатается CLI / доставляется в Saved Messages. */
export function renderReport(report: ReserveProvisionReport): string {
    if (report.abortReason) {
        return `tg-agent-reserve-provision — прогон не начат: ${report.abortReason}`;
    }
    const lines = report.results.map((r) => `  ${r.reserveId}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
    const summary = report.results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
    }, {});
    return [
        `tg-agent-reserve-provision — ${report.results.length} account(s)`,
        `Summary: ${JSON.stringify(summary)}`,
        ...lines,
    ].join("\n");
}
