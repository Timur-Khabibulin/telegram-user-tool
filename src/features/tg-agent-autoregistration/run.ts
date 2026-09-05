// features/tg-agent-autoregistration/run.ts — Main (роль на диаграмме): единая точка
// входа всего прогона, детерминированный код без LLM-цикла (design.md D1).
// Аккаунты обрабатываются последовательно (constraint 2.2.1) — один за другим,
// ошибка одного не останавливает пачку.

import * as fs from "fs";
import * as path from "path";
import { File as MegaFile } from "megajs";
import type { Logger } from "../../core/logger";
import type { AccountConfig, DeviceConfig } from "../../core/config";
import { loadPersonaTemplate, PersonaTemplateError, type PersonaTemplate } from "./persona-template";
import { computeAgentIdRange, checkAgentIdRangeFree } from "./id-range";
import { stagingTdataDir, writeStagingStatus, readStagingStatus, promoteToWorkspace, type AccountStatus } from "./staging";
import { assignDeviceForAgent, clearStagedDevice } from "./device-assignment";
import type { ProxyConfig } from "../../core/config";
import { readTdataAccountInfo, connectBootstrap, prepareAccount, TdataSetupError } from "../../core/tdata";
import { assignUsernameForAgent, clearStagedUsername } from "./username";
import { selectWorkingProxy, type ProxySelectionOutcome } from "./proxy-selection";
import { registerAgenticSession, type AgenticSessionOutcome } from "./agentic-session";

export interface RunParams {
    megaLinks: string[];
    startAgentNumber: number;
    proxyRegion: string;
    maxProxyAttempts: number;
    personName: string;
}

export interface AccountResult {
    agentId: string;
    status: AccountStatus | "done";
    error?: string;
}

export interface RunReport {
    results: AccountResult[];
    /** Заполнено, если прогон не начался вообще (R-10/R-8) — иначе результат по аккаунтам не пуст. */
    abortReason?: string;
}

/**
 * Скачивание одного архива из Mega (R-D2) — публичная share-ссылка на папку
 * (`mega.nz/folder/<id>#<key>`, ключ дешифровки в фрагменте URL, аккаунт не
 * нужен). Структура подтверждена вживую (`megajs`, реальная ссылка): ссылка
 * ведёт на папку с номером аккаунта, внутри которой лежит папка `tdata` —
 * её и ищем по имени, не полагаясь на позицию/глубину. Один `loadAttributes()`
 * на корне уже отдаёт всё вложенное дерево (проверено — вложенные подпапки tdata
 * приходят с уже заполненными `.children`), рекурсивный обход ничего не дозапрашивает.
 */
async function downloadTdataArchive(link: string, destTdataDir: string, log: Logger): Promise<void> {
    const root = MegaFile.fromURL(link);
    await root.loadAttributes();

    const tdataNode = findTdataFolder(root);
    if (!tdataNode) {
        throw new Error(`в архиве ${link} не найдена папка tdata`);
    }
    await downloadMegaFolder(tdataNode, destTdataDir);
    log.info(`[tg-agent-autoregistration] downloadTdataArchive — скачано в ${destTdataDir}`);
}

function findTdataFolder(node: any): any | null {
    if (node.name === "tdata" && node.directory) return node;
    for (const child of node.children ?? []) {
        if (!child.directory) continue;
        if (child.name === "tdata") return child;
        const found = findTdataFolder(child);
        if (found) return found;
    }
    return null;
}

async function downloadMegaFolder(node: any, destDir: string): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });
    for (const child of node.children ?? []) {
        const destPath = path.join(destDir, child.name);
        if (child.directory) {
            await downloadMegaFolder(child, destPath);
        } else {
            await downloadMegaFile(child, destPath);
        }
    }
}

function downloadMegaFile(file: any, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const stream = file.download();
        const out = fs.createWriteStream(destPath);
        stream.on("error", reject);
        out.on("error", reject);
        out.on("finish", () => resolve());
        stream.pipe(out);
    });
}

export async function runAutoregistration(params: RunParams, log: Logger): Promise<RunReport> {
    const { megaLinks, startAgentNumber, proxyRegion, maxProxyAttempts, personName } = params;

    // R-10: шаблон персоны читается до всего остального; отсутствие/неполнота —
    // стоп без скачивания, не exception наружу этой функции.
    let template: PersonaTemplate;
    try {
        template = loadPersonaTemplate(personName);
    } catch (err: any) {
        if (err instanceof PersonaTemplateError) {
            log.error(`[tg-agent-autoregistration] ${err.message}`);
            return { results: [], abortReason: err.message };
        }
        throw err;
    }

    // R-8/R-11: диапазон ID — до скачивания чего-либо.
    const agentIds = computeAgentIdRange(startAgentNumber, megaLinks.length);
    const range = checkAgentIdRangeFree(agentIds);
    if (!range.ok) {
        const reason = `диапазон ID занят: ${range.conflicts.join(", ")} — прогон не начат`;
        log.error(`[tg-agent-autoregistration] ${reason}`);
        return { results: [], abortReason: reason };
    }

    // R-7/R-D2/R-D3/R-11: один архив на аккаунт, все сразу, до цикла обработки.
    for (let i = 0; i < megaLinks.length; i++) {
        const agentId = agentIds[i];
        const tdataDir = stagingTdataDir(agentId);
        fs.mkdirSync(tdataDir, { recursive: true });
        await downloadTdataArchive(megaLinks[i], tdataDir, log);
    }

    const results: AccountResult[] = [];
    for (const agentId of agentIds) {
        try {
            results.push(await processAccount(agentId, template, proxyRegion, maxProxyAttempts, log));
        } catch (err: any) {
            // Непредвиденная ошибка (не TdataConnectError/TdataSetupError,
            // пойманные ниже) — не роняем весь прогон, фиксируем и идём дальше.
            log.error(`[tg-agent-autoregistration] ${agentId} — непредвиденная ошибка: ${err.message ?? err}`);
            writeStagingStatus(agentId, "setup_failed", err.message ?? String(err));
            results.push({ agentId, status: "setup_failed", error: err.message ?? String(err) });
        }
    }

    return { results };
}

async function processAccount(
    agentId: string,
    template: PersonaTemplate,
    proxyRegion: string,
    maxProxyAttempts: number,
    log: Logger,
): Promise<AccountResult> {
    const tdataPath = stagingTdataDir(agentId);
    const { phoneNumber, currentPassword } = readTdataAccountInfo(tdataPath);
    const username = assignUsernameForAgent(agentId, template.profileData.nick);
    const { apiId, apiHash } = template.defaultAgentData;
    const device = assignDeviceForAgent(agentId);

    let outcome;
    try {
        outcome = await selectWorkingProxy(
            agentId,
            proxyRegion,
            maxProxyAttempts,
            async (proxy) => {
                const client = await connectBootstrap(tdataPath, proxy, apiId, apiHash, device, log);
                try {
                    await prepareAccount(client, template, currentPassword, username, log);
                    const agentic = await registerAgenticSession(
                        client,
                        apiId,
                        apiHash,
                        phoneNumber,
                        proxy,
                        template.defaultAgentData["2fa"],
                        log,
                    );
                    return { agentic, proxy };
                } catch (err: any) {
                    // Ошибка после успешного connect — подготовка/регистрация
                    // второй сессии, не сеть (та бросается раньше, из
                    // connectBootstrap, и сюда не долетает).
                    if (err instanceof TdataSetupError) throw err;
                    throw new TdataSetupError("UNKNOWN", `подготовка/регистрация: ${err.message ?? err}`, err);
                } finally {
                    // Локальный сокет закрываем всегда — это НЕ logout: сессия
                    // остаётся активной на стороне Telegram (design.md D3),
                    // просто наш процесс не держит соединение открытым дальше.
                    await client.disconnect().catch(() => {});
                }
            },
            log,
        );
    } catch (err: any) {
        if (err instanceof TdataSetupError) {
            writeStagingStatus(agentId, "setup_failed", `${err.telegramCode}: ${err.message}`);
            return { agentId, status: "setup_failed", error: err.message };
        }
        throw err;
    }

    return finalizeProxyOutcome(agentId, outcome, apiId, apiHash, device, template.personName, username);
}

/**
 * Общий хвост для `processAccount` и `retryManualCode`: proxy_failed при
 * исчерпании попыток, needs_manual_code при таймауте кода, иначе — атомарный
 * перенос в workspace (R-D4) и done.
 */
function finalizeProxyOutcome(
    agentId: string,
    outcome: ProxySelectionOutcome<{ agentic: AgenticSessionOutcome; proxy: ProxyConfig }>,
    apiId: number,
    apiHash: string,
    device: DeviceConfig,
    personName: string,
    username: string,
): AccountResult {
    if (outcome.kind === "exhausted") {
        writeStagingStatus(agentId, "proxy_failed");
        return { agentId, status: "proxy_failed" };
    }

    const { agentic, proxy } = outcome.value;

    if (agentic.kind === "code_timeout") {
        writeStagingStatus(agentId, "needs_manual_code");
        return { agentId, status: "needs_manual_code" };
    }

    const accountConfig: AccountConfig = {
        accountId: agentId,
        apiId,
        apiHash,
        sessionString: agentic.sessionString,
        persona: personName,
        username,
        proxy,
        device,
    };
    clearStagedDevice(agentId);
    clearStagedUsername(agentId);
    promoteToWorkspace(agentId, accountConfig);
    return { agentId, status: "done" };
}

/**
 * Ретрай второй (агентской) сессии для аккаунта, застрявшего в
 * `needs_manual_code` — без повторной подготовки аккаунта (2FA/сессии/профиль/
 * канал уже применены к реальному Telegram-аккаунту; повторный `change2FA` с
 * тем же currentPassword упадёт, потому что пароль уже сменён). Точечное
 * отступление от R-9 ("процесс не предоставляет отдельного автоматизма") —
 * добавлено по прямому запросу координатора для диагностики readIncomingCode
 * на уже подготовленном аккаунте, не тратя новый tdata-архив на каждую попытку.
 */
export async function retryManualCode(
    agentId: string,
    personName: string,
    proxyRegion: string,
    maxProxyAttempts: number,
    log: Logger,
): Promise<AccountResult> {
    const status = readStagingStatus(agentId);
    if (!status || status.status !== "needs_manual_code") {
        throw new Error(
            `agent ${agentId}: ожидался статус needs_manual_code в стейджинге, сейчас: ${status?.status ?? "запись отсутствует"}`,
        );
    }

    const template = loadPersonaTemplate(personName);
    const tdataPath = stagingTdataDir(agentId);
    const { phoneNumber } = readTdataAccountInfo(tdataPath);
    const { apiId, apiHash } = template.defaultAgentData;
    const device = assignDeviceForAgent(agentId);
    // Тот же username, что уже применён к Telegram-аккаунту в первой попытке
    // (UpdateUsername в prepareAccount, до таймаута кода) — не генерировать другой.
    const username = assignUsernameForAgent(agentId, template.profileData.nick);

    let outcome;
    try {
        outcome = await selectWorkingProxy(
            agentId,
            proxyRegion,
            maxProxyAttempts,
            async (proxy) => {
                const client = await connectBootstrap(tdataPath, proxy, apiId, apiHash, device, log);
                try {
                    const agentic = await registerAgenticSession(
                        client,
                        apiId,
                        apiHash,
                        phoneNumber,
                        proxy,
                        template.defaultAgentData["2fa"],
                        log,
                    );
                    return { agentic, proxy };
                } catch (err: any) {
                    if (err instanceof TdataSetupError) throw err;
                    throw new TdataSetupError("UNKNOWN", `повторная регистрация сессии: ${err.message ?? err}`, err);
                } finally {
                    await client.disconnect().catch(() => {});
                }
            },
            log,
        );
    } catch (err: any) {
        if (err instanceof TdataSetupError) {
            writeStagingStatus(agentId, "setup_failed", `${err.telegramCode}: ${err.message}`);
            return { agentId, status: "setup_failed", error: err.message };
        }
        throw err;
    }

    return finalizeProxyOutcome(agentId, outcome, apiId, apiHash, device, template.personName, username);
}

/** Итоговый отчёт по каждому аккаунту (9.5) — печатается CLI/возвращается тулом. */
export function renderReport(report: RunReport): string {
    if (report.abortReason) {
        return `tg-agent-autoregistration — прогон не начат: ${report.abortReason}`;
    }
    const lines = report.results.map((r) => `  ${r.agentId}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
    const summary = report.results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
    }, {});
    return [
        `tg-agent-autoregistration — ${report.results.length} account(s)`,
        `Summary: ${JSON.stringify(summary)}`,
        ...lines,
    ].join("\n");
}
