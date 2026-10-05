// features/tg-agent-pool-provision/run.ts — фаза 1 (продюсер пула). Из списка ссылок
// на tdata делает обезличенные пул-аккаунты workspace-emptyAccount<K>: подбор прокси
// → bootstrap из tdata → гигиена без персоны (prepareEmptyPoolAccount) → регистрация
// агентской сессии. Персона/username/фото/канал НЕ применяются (это фаза 2).
//
// Переиспует машинерию автрегистрации (скачивание/прокси/bootstrap/агентская сессия),
// меняя только: prepareEmptyPoolAccount вместо prepareAccount и промоушен в пул.

import * as fs from "fs";
import * as path from "path";

import type { Logger } from "../../core/logger";
import type { DeviceConfig, PoolAccountConfig, ProxyConfig } from "../../core/config";
import { loadAccountDefaults } from "../../core/config";
import { pickDevice, usedComboCounts } from "../../core/device-pool";
import { connectBootstrap, readAccountPhone, prepareEmptyPoolAccount, TdataSetupError } from "../../core/tdata";
import { selectWorkingProxy, type ProxySelectionOutcome } from "../tg-agent-autoregistration/proxy-selection";
import { registerAgenticSession, type AgenticSessionOutcome } from "../tg-agent-autoregistration/agentic-session";
import { downloadTdataArchive } from "../tg-agent-autoregistration/run";
import {
    stagingTdataDir,
    stagingDir,
    stagingPasswordFilePath,
    writeStagingStatus,
    readStagingStatus,
    computeNextPoolNumber,
    promoteToPool,
    type PoolAccountStatus,
} from "./staging";

export interface PoolProvisionParams {
    /** Ссылки на tdata-архивы, по одной на аккаунт (Mega folder-share или Google Drive file-ссылка). */
    links: string[];
    /**
     * Текущий 2FA-пароль пачки (ввод оператора). Необязателен: если на аккаунтах пачки
     * 2FA не установлена — не передавать (пусто). change2FA авторизуется пустым паролем и
     * ставит целевой. Если пароль пропустить, а 2FA на аккаунте всё же есть — этот аккаунт
     * уйдёт в setup_failed (PASSWORD_HASH_INVALID), остальная пачка не пострадает.
     */
    twoFaPassword?: string;
    /**
     * Имя файла в скачанном архиве (рядом с tdata или вложенно), где лежит текущий
     * 2FA-пароль — например "password.txt". Пароль читается пер-аккаунт из своего
     * архива (в отличие от twoFaPassword, единого на пачку). Взаимоисключающ с
     * twoFaPassword. Файл не найден/пуст — этот аккаунт уйдёт в setup_failed.
     */
    twoFaPasswordFile?: string;
    proxyRegion: string;
    maxProxyAttempts: number;
}

export interface PoolAccountResult {
    poolId: string;
    status: PoolAccountStatus;
    error?: string;
}

export interface PoolProvisionReport {
    results: PoolAccountResult[];
    /** Заполнено, если прогон не начался вообще (pre-flight). */
    abortReason?: string;
}

// ── Устройство (реальная модель, не пересекающаяся с другими агентами) ──────

function stagingDevicePath(poolId: string): string {
    return path.join(stagingDir(poolId), "device.json");
}

/** Устройство для пул-аккаунта — из стейджинга (ретрай) либо подбор+сохранение. Идемпотентно. */
function assignDevice(poolId: string): DeviceConfig {
    try {
        return JSON.parse(fs.readFileSync(stagingDevicePath(poolId), "utf-8")) as DeviceConfig;
    } catch {
        // не назначено — подобрать ниже
    }
    const device: DeviceConfig = { ...pickDevice(usedComboCounts()), langCode: "ru", systemLangCode: "ru" };
    fs.mkdirSync(stagingDir(poolId), { recursive: true });
    const tmp = `${stagingDevicePath(poolId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(device, null, 2), "utf-8");
    fs.renameSync(tmp, stagingDevicePath(poolId));
    return device;
}

function clearStagedDevice(poolId: string): void {
    fs.rmSync(stagingDevicePath(poolId), { force: true });
}

// Пауза между аккаунтами пачки (human-pacing, уровень B): гигиена + регистрация второй
// сессии у N аккаунтов подряд из одного прокси-кластера — паттерн массовой подготовки,
// который ловит антиспам Telegram. Разносим обработку во времени. Значения — именованные
// константы для тюнинга.
const ACCOUNT_GAP_MIN_SEC = 90;
const ACCOUNT_GAP_MAX_SEC = 240;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function humanAccountDelay(): Promise<void> {
    return sleep((ACCOUNT_GAP_MIN_SEC + Math.random() * (ACCOUNT_GAP_MAX_SEC - ACCOUNT_GAP_MIN_SEC)) * 1000);
}

export async function runPoolProvision(params: PoolProvisionParams, log: Logger): Promise<PoolProvisionReport> {
    const { links, twoFaPassword, twoFaPasswordFile, proxyRegion, maxProxyAttempts } = params;

    // Pre-flight: заготовка учётных данных — до скачивания чего-либо. Источник 2FA
    // необязателен (аккаунты без 2FA): пустой текущий пароль change2FA обрабатывает штатно.
    let defaults;
    try {
        defaults = loadAccountDefaults();
    } catch (err: any) {
        const reason = `account-defaults недоступен: ${err?.message ?? err} — прогон не начат`;
        log.error(`[tg-agent-pool-provision] ${reason}`);
        return { results: [], abortReason: reason };
    }
    if (twoFaPassword && twoFaPassword.trim() && twoFaPasswordFile && twoFaPasswordFile.trim()) {
        const reason = "заданы одновременно twoFaPassword и twoFaPasswordFile — выбрать один источник; прогон не начат";
        log.error(`[tg-agent-pool-provision] ${reason}`);
        return { results: [], abortReason: reason };
    }
    if (links.length === 0) {
        return { results: [], abortReason: "links пуст — прогон не начат" };
    }

    // Метки K: base..base+N-1 (нумерация по сырым именам, включая карантин .invalid).
    const base = computeNextPoolNumber();
    const poolIds = links.map((_, i) => `emptyAccount${base + i}`);

    // Batch-скачивание в стейджинг до обработки любого аккаунта.
    const downloadFailed = new Map<string, string>();
    for (let i = 0; i < links.length; i++) {
        const poolId = poolIds[i];
        const tdataDir = stagingTdataDir(poolId);
        fs.mkdirSync(tdataDir, { recursive: true });
        const extraFile = twoFaPasswordFile && twoFaPasswordFile.trim()
            ? { name: twoFaPasswordFile.trim(), destPath: stagingPasswordFilePath(poolId, twoFaPasswordFile) }
            : undefined;
        try {
            await downloadTdataArchive(links[i], tdataDir, log, extraFile);
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            log.error(`[tg-agent-pool-provision] ${poolId} — ошибка скачивания: ${msg}`);
            writeStagingStatus(poolId, "setup_failed", `download: ${msg}`);
            downloadFailed.set(poolId, msg);
        }
    }

    const results: PoolAccountResult[] = [];
    // Уровень B: пауза ставится перед каждым реально обрабатываемым аккаунтом, кроме
    // первого (download-failed пропускаются до обработки и в ритм не входят).
    let processedAny = false;
    for (const poolId of poolIds) {
        if (downloadFailed.has(poolId)) {
            results.push({ poolId, status: "setup_failed", error: `download: ${downloadFailed.get(poolId)}` });
            continue;
        }
        if (processedAny) {
            log.info(`[tg-agent-pool-provision] пауза между аккаунтами (human-pacing) перед ${poolId}`);
            await humanAccountDelay();
        }
        processedAny = true;
        try {
            results.push(await processPoolAccount(poolId, defaults, twoFaPassword ?? "", twoFaPasswordFile, proxyRegion, maxProxyAttempts, log));
        } catch (err: any) {
            log.error(`[tg-agent-pool-provision] ${poolId} — непредвиденная ошибка: ${err?.message ?? err}`);
            writeStagingStatus(poolId, "setup_failed", err?.message ?? String(err));
            results.push({ poolId, status: "setup_failed", error: err?.message ?? String(err) });
        }
    }

    return { results };
}

/**
 * Текущий 2FA-пароль для аккаунта: из файла архива (пер-аккаунт), если задан
 * twoFaPasswordFile, иначе единый twoFaPassword пачки. Файл задан, но отсутствует
 * или пуст — ошибка (аккаунт уйдёт в setup_failed).
 */
function resolveCurrentPassword(poolId: string, twoFaPassword: string, twoFaPasswordFile: string | undefined): string {
    if (!twoFaPasswordFile || !twoFaPasswordFile.trim()) return twoFaPassword;
    const filePath = stagingPasswordFilePath(poolId, twoFaPasswordFile);
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, "utf-8");
    } catch {
        throw new TdataSetupError("PASSWORD_FILE_MISSING", `файл 2FA-пароля ${twoFaPasswordFile} в архиве не найден`);
    }
    const pass = raw.trim();
    if (!pass) throw new TdataSetupError("PASSWORD_FILE_EMPTY", `файл 2FA-пароля ${twoFaPasswordFile} пуст`);
    return pass;
}

async function processPoolAccount(
    poolId: string,
    defaults: { apiId: number; apiHash: string; "2fa": string },
    twoFaPassword: string,
    twoFaPasswordFile: string | undefined,
    proxyRegion: string,
    maxProxyAttempts: number,
    log: Logger,
): Promise<PoolAccountResult> {
    const tdataPath = stagingTdataDir(poolId);
    const device = assignDevice(poolId);
    const { apiId, apiHash } = defaults;

    let currentPassword: string;
    try {
        currentPassword = resolveCurrentPassword(poolId, twoFaPassword, twoFaPasswordFile);
    } catch (err: any) {
        if (err instanceof TdataSetupError) {
            writeStagingStatus(poolId, "setup_failed", `${err.telegramCode}: ${err.message}`);
            return { poolId, status: "setup_failed", error: err.message };
        }
        throw err;
    }

    let outcome;
    try {
        outcome = await selectWorkingProxy(
            poolId,
            proxyRegion,
            maxProxyAttempts,
            async (proxy) => {
                const client = await connectBootstrap(tdataPath, proxy, apiId, apiHash, device, log);
                try {
                    const phoneNumber = await readAccountPhone(client);
                    await prepareEmptyPoolAccount(client, currentPassword, defaults["2fa"], log);
                    const agentic = await registerAgenticSession(
                        client, apiId, apiHash, phoneNumber, proxy, defaults["2fa"], log,
                    );
                    return { agentic, proxy };
                } catch (err: any) {
                    if (err instanceof TdataSetupError) throw err;
                    throw new TdataSetupError("UNKNOWN", `подготовка/сессия: ${err?.message ?? err}`, err);
                } finally {
                    await client.disconnect().catch(() => {});
                }
            },
            log,
        );
    } catch (err: any) {
        if (err instanceof TdataSetupError) {
            writeStagingStatus(poolId, "setup_failed", `${err.telegramCode}: ${err.message}`);
            return { poolId, status: "setup_failed", error: err.message };
        }
        throw err;
    }

    return finalize(poolId, outcome, apiId, apiHash, device);
}

function finalize(
    poolId: string,
    outcome: ProxySelectionOutcome<{ agentic: AgenticSessionOutcome; proxy: ProxyConfig }>,
    apiId: number,
    apiHash: string,
    device: DeviceConfig,
): PoolAccountResult {
    if (outcome.kind === "exhausted") {
        writeStagingStatus(poolId, "proxy_failed");
        return { poolId, status: "proxy_failed" };
    }
    const { agentic, proxy } = outcome.value;
    if (agentic.kind === "code_timeout") {
        writeStagingStatus(poolId, "needs_manual_code");
        return { poolId, status: "needs_manual_code" };
    }
    const poolConfig: PoolAccountConfig = {
        accountId: poolId, apiId, apiHash, sessionString: agentic.sessionString,
        // Момент авторизации фиксируется вместе с sessionString (tg-peer-identity-model).
        sessionAuthorizedAt: Math.floor(Date.now() / 1000), proxy, device,
    };
    clearStagedDevice(poolId);
    promoteToPool(poolId, poolConfig);
    return { poolId, status: "done" };
}

/**
 * Ретрай второй (агентской) сессии для пул-аккаунта в статусе needs_manual_code —
 * без повторной гигиены (2FA/сессии/каналы уже применены). Для иного статуса — отказ.
 */
export async function retryPoolManualCode(
    poolId: string,
    proxyRegion: string,
    maxProxyAttempts: number,
    log: Logger,
): Promise<PoolAccountResult> {
    const status = readStagingStatus(poolId);
    if (!status || status.status !== "needs_manual_code") {
        throw new Error(
            `пул-аккаунт ${poolId}: ожидался статус needs_manual_code в стейджинге, сейчас: ${status?.status ?? "запись отсутствует"}`,
        );
    }
    const defaults = loadAccountDefaults();
    const device = assignDevice(poolId);
    const { apiId, apiHash } = defaults;

    let outcome;
    try {
        outcome = await selectWorkingProxy(
            poolId,
            proxyRegion,
            maxProxyAttempts,
            async (proxy) => {
                const client = await connectBootstrap(stagingTdataDir(poolId), proxy, apiId, apiHash, device, log);
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
            writeStagingStatus(poolId, "setup_failed", `${err.telegramCode}: ${err.message}`);
            return { poolId, status: "setup_failed", error: err.message };
        }
        throw err;
    }

    return finalize(poolId, outcome, apiId, apiHash, device);
}

/** Итоговый отчёт по каждому пул-аккаунту — печатается CLI / доставляется в Saved Messages. */
export function renderReport(report: PoolProvisionReport): string {
    if (report.abortReason) {
        return `tg-agent-pool-provision — прогон не начат: ${report.abortReason}`;
    }
    const lines = report.results.map((r) => `  ${r.poolId}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
    const summary = report.results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
    }, {});
    return [
        `tg-agent-pool-provision — ${report.results.length} account(s)`,
        `Summary: ${JSON.stringify(summary)}`,
        ...lines,
    ].join("\n");
}
