// features/tg-agent-autoregistration/run.ts — Main (роль на диаграмме): единая точка
// входа всего прогона, детерминированный код без LLM-цикла (design.md D1).
// Аккаунты обрабатываются последовательно (constraint 2.2.1) — один за другим,
// ошибка одного не останавливает пачку.

import * as fs from "fs";
import * as path from "path";
import { File as MegaFile } from "megajs";
import AdmZip from "adm-zip";
import type { Logger } from "../../core/logger";
import type { AccountConfig, DeviceConfig } from "../../core/config";
import { loadPersonaTemplate, PersonaTemplateError, type PersonaTemplate } from "./persona-template";
import { computeAgentIdRange, checkAgentIdRangeFree } from "./id-range";
import { stagingTdataDir, writeStagingStatus, readStagingStatus, promoteToWorkspace, type AccountStatus } from "./staging";
import { assignDeviceForAgent, clearStagedDevice } from "./device-assignment";
import type { ProxyConfig } from "../../core/config";
import { loadAccountDefaults } from "../../core/config";
import { readAccountPhone, connectBootstrap, prepareAccount, TdataSetupError } from "../../core/tdata";
import { assignUsernameForAgent, clearStagedUsername } from "./username";
import { selectWorkingProxy, type ProxySelectionOutcome } from "./proxy-selection";
import { registerAgenticSession, type AgenticSessionOutcome } from "./agentic-session";

export interface RunParams {
    /** Ссылки на tdata-архивы, по одной на аккаунт. Источник — Mega folder-share
     *  или Google Drive file-ссылка; вид определяется по URL в download-слое (design D1). */
    links: string[];
    /** Текущий 2FA-пароль аккаунтов пачки (один на весь прогон, design D4). */
    twoFaPassword: string;
    /** Создавать ли публичный канал персоны при реге (mode B). false = mode A (без канала). */
    createPublicChannel: boolean;
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
 * Скачивание одного архива в `destTdataDir` — источник-агностично (design D1):
 * вид ссылки определяется по URL. Mega folder-share идёт прежним путём
 * (`megajs`), Google Drive file-ссылка — через скачивание ZIP и распаковку.
 * Нераспознанная ссылка — явная ошибка (вызывающий пометит аккаунт неуспехом
 * и продолжит пачку).
 */
/**
 * Дополнительный файл из архива (кроме папки tdata): ищется по имени во всём
 * распакованном дереве и копируется в destPath. Не найден — молча пропускается
 * (это не ошибка скачивания; отсутствие обрабатывает потребитель). Используется
 * для 2FA-пароля из файла архива (tg-agent-pool-provision).
 */
export interface ExtraFileRequest {
    /** Имя файла для поиска (например "password.txt"). */
    name: string;
    /** Абсолютный путь назначения для найденного файла. */
    destPath: string;
}

export async function downloadTdataArchive(
    link: string,
    destTdataDir: string,
    log: Logger,
    extraFile?: ExtraFileRequest,
): Promise<void> {
    if (isGoogleDriveLink(link)) return downloadTdataFromGDrive(link, destTdataDir, log, extraFile);
    if (/mega\.nz/i.test(link)) return downloadTdataFromMega(link, destTdataDir, log, extraFile);
    throw new Error(`нераспознанный вид ссылки (ни Google Drive, ни Mega): ${link}`);
}

/**
 * Mega (R-D2) — публичная share-ссылка на папку (`mega.nz/folder/<id>#<key>`,
 * ключ дешифровки в фрагменте URL, аккаунт не нужен). Ссылка ведёт на папку с
 * номером аккаунта, внутри которой лежит папка `tdata` — её ищем по имени.
 * Один `loadAttributes()` на корне отдаёт всё вложенное дерево.
 */
async function downloadTdataFromMega(
    link: string,
    destTdataDir: string,
    log: Logger,
    extraFile?: ExtraFileRequest,
): Promise<void> {
    const root = MegaFile.fromURL(link);
    await root.loadAttributes();

    const tdataNode = findTdataFolder(root);
    if (!tdataNode) {
        throw new Error(`в архиве ${link} не найдена папка tdata`);
    }
    await downloadMegaFolder(tdataNode, destTdataDir);
    if (extraFile) {
        const node = findFileNode(root, extraFile.name);
        if (node) {
            fs.mkdirSync(path.dirname(extraFile.destPath), { recursive: true });
            await downloadMegaFile(node, extraFile.destPath);
            log.info(`[tg-agent-autoregistration] downloadTdataFromMega — доп. файл ${extraFile.name} скачан`);
        } else {
            log.warn(`[tg-agent-autoregistration] downloadTdataFromMega — доп. файл ${extraFile.name} в архиве не найден`);
        }
    }
    log.info(`[tg-agent-autoregistration] downloadTdataFromMega — скачано в ${destTdataDir}`);
}

function isGoogleDriveLink(link: string): boolean {
    return /drive\.google\.com/i.test(link);
}

/** FILE_ID из `/file/d/<id>/...` или `?id=<id>` (design D2). */
function extractGDriveFileId(link: string): string | null {
    return link.match(/\/file\/d\/([^/?]+)/)?.[1] ?? link.match(/[?&]id=([^&]+)/)?.[1] ?? null;
}

/**
 * Google Drive (design D2): скачивает файл-ZIP, распаковывает, ищет внутри
 * папку `tdata` и копирует её содержимое в `destTdataDir`. Большие файлы Google
 * отдаёт через HTML-интерстишл подтверждения — обрабатывается в downloadGDriveFile.
 */
async function downloadTdataFromGDrive(
    link: string,
    destTdataDir: string,
    log: Logger,
    extraFile?: ExtraFileRequest,
): Promise<void> {
    const fileId = extractGDriveFileId(link);
    if (!fileId) throw new Error(`не удалось извлечь FILE_ID из Google Drive ссылки: ${link}`);

    const buf = await downloadGDriveFile(fileId);

    const extractDir = path.join(path.dirname(destTdataDir), "_extract");
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    try {
        new AdmZip(buf).extractAllTo(extractDir, true);
    } catch (err: any) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        throw new Error(`Google Drive: не удалось распаковать ZIP (${link}): ${err.message ?? err}`);
    }

    const tdataSrc = findTdataDirOnDisk(extractDir);
    if (!tdataSrc) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        throw new Error(`в архиве ${link} не найдена папка tdata`);
    }
    fs.mkdirSync(destTdataDir, { recursive: true });
    fs.cpSync(tdataSrc, destTdataDir, { recursive: true });
    if (extraFile) {
        const src = findFileOnDisk(extractDir, extraFile.name);
        if (src) {
            fs.mkdirSync(path.dirname(extraFile.destPath), { recursive: true });
            fs.copyFileSync(src, extraFile.destPath);
            log.info(`[tg-agent-autoregistration] downloadTdataFromGDrive — доп. файл ${extraFile.name} скопирован`);
        } else {
            log.warn(`[tg-agent-autoregistration] downloadTdataFromGDrive — доп. файл ${extraFile.name} в архиве не найден`);
        }
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
    log.info(`[tg-agent-autoregistration] downloadTdataFromGDrive — скачано и распаковано в ${destTdataDir}`);
}

/**
 * Прямое скачивание публичного файла Google Drive. Для больших файлов Google
 * возвращает HTML-страницу «не удалось проверить на вирусы» с формой
 * подтверждения — парсим её скрытые поля и повторяем запрос. Если и после этого
 * приходит HTML (доступ не «всем по ссылке») — понятная ошибка (design D2).
 */
async function downloadGDriveFile(fileId: string): Promise<Buffer> {
    const base = "https://drive.usercontent.google.com/download";
    let res = await fetch(`${base}?id=${encodeURIComponent(fileId)}&export=download&confirm=t`);

    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
        const query = parseGDriveConfirmForm(await res.text(), fileId);
        if (!query) {
            throw new Error("Google Drive: файл не отдаётся по ссылке (проверь, что доступ открыт «всем, у кого есть ссылка»)");
        }
        res = await fetch(`${base}?${query}`);
        if ((res.headers.get("content-type") ?? "").includes("text/html")) {
            throw new Error("Google Drive: после подтверждения всё ещё HTML — файл недоступен для скачивания по ссылке");
        }
    }
    if (!res.ok) throw new Error(`Google Drive: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/** Скрытые поля формы подтверждения GDrive → query-строка для повторного запроса. */
function parseGDriveConfirmForm(html: string, fileId: string): string | null {
    const tags = html.match(/<input[^>]*>/g) ?? [];
    const sp = new URLSearchParams();
    for (const tag of tags) {
        if (!/type="hidden"/i.test(tag)) continue;
        const name = tag.match(/name="([^"]+)"/)?.[1];
        if (!name) continue;
        sp.set(name, tag.match(/value="([^"]*)"/)?.[1] ?? "");
    }
    if (sp.toString() === "") return null;
    if (!sp.has("id")) sp.set("id", fileId);
    if (!sp.has("export")) sp.set("export", "download");
    return sp.toString();
}

/** Рекурсивный поиск папки `tdata` в распакованном дереве на диске. */
function findTdataDirOnDisk(root: string): string | null {
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const full = path.join(dir, e.name);
            if (e.name === "tdata") return full;
            stack.push(full);
        }
    }
    return null;
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

/** Рекурсивный поиск файла по имени в распакованном дереве на диске (первое совпадение). */
function findFileOnDisk(root: string, name: string): string | null {
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.name === name) return full;
        }
    }
    return null;
}

/** Рекурсивный поиск файла-ноды по имени в дереве Mega (первое совпадение). */
function findFileNode(node: any, name: string): any | null {
    for (const child of node.children ?? []) {
        if (child.directory) {
            const found = findFileNode(child, name);
            if (found) return found;
        } else if (child.name === name) {
            return child;
        }
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
    const { links, twoFaPassword, createPublicChannel, startAgentNumber, proxyRegion, maxProxyAttempts, personName } = params;

    // R-10: шаблон персоны читается до всего остального; отсутствие/неполнота —
    // стоп без скачивания, не exception наружу этой функции.
    let template: PersonaTemplate;
    try {
        template = loadPersonaTemplate(personName, createPublicChannel);
    } catch (err: any) {
        if (err instanceof PersonaTemplateError) {
            log.error(`[tg-agent-autoregistration] ${err.message}`);
            return { results: [], abortReason: err.message };
        }
        throw err;
    }

    // Валидация 2FA-пароля — до скачивания чего-либо (design D4, pre-flight).
    if (!twoFaPassword || !twoFaPassword.trim()) {
        const reason = "twoFaPassword не задан — прогон не начат";
        log.error(`[tg-agent-autoregistration] ${reason}`);
        return { results: [], abortReason: reason };
    }

    // R-8/R-11: диапазон ID — до скачивания чего-либо.
    const agentIds = computeAgentIdRange(startAgentNumber, links.length);
    const range = checkAgentIdRangeFree(agentIds);
    if (!range.ok) {
        const reason = `диапазон ID занят: ${range.conflicts.join(", ")} — прогон не начат`;
        log.error(`[tg-agent-autoregistration] ${reason}`);
        return { results: [], abortReason: reason };
    }

    // R-7/R-D2/R-D3/R-11: один архив на аккаунт, все сразу, до цикла обработки.
    // Ошибка скачивания одного архива (например, приватная GDrive-ссылка) не
    // роняет пачку: аккаунт помечается setup_failed и пропускается (design D2).
    const downloadFailed = new Map<string, string>();
    for (let i = 0; i < links.length; i++) {
        const agentId = agentIds[i];
        const tdataDir = stagingTdataDir(agentId);
        fs.mkdirSync(tdataDir, { recursive: true });
        try {
            await downloadTdataArchive(links[i], tdataDir, log);
        } catch (err: any) {
            const msg = err.message ?? String(err);
            log.error(`[tg-agent-autoregistration] ${agentId} — ошибка скачивания: ${msg}`);
            writeStagingStatus(agentId, "setup_failed", `download: ${msg}`);
            downloadFailed.set(agentId, msg);
        }
    }

    const results: AccountResult[] = [];
    for (const agentId of agentIds) {
        if (downloadFailed.has(agentId)) {
            results.push({ agentId, status: "setup_failed", error: `download: ${downloadFailed.get(agentId)}` });
            continue;
        }
        try {
            results.push(await processAccount(agentId, template, twoFaPassword, createPublicChannel, proxyRegion, maxProxyAttempts, log));
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
    twoFaPassword: string,
    createPublicChannel: boolean,
    proxyRegion: string,
    maxProxyAttempts: number,
    log: Logger,
): Promise<AccountResult> {
    const tdataPath = stagingTdataDir(agentId);
    const username = assignUsernameForAgent(agentId, template.profileData.nick);
    const { apiId, apiHash } = loadAccountDefaults();
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
                    // Телефон — из самого аккаунта (design D5), 2FA — из параметра (design D4).
                    const phoneNumber = await readAccountPhone(client);
                    await prepareAccount(client, template, twoFaPassword, username, log, createPublicChannel);
                    const agentic = await registerAgenticSession(
                        client,
                        apiId,
                        apiHash,
                        phoneNumber,
                        proxy,
                        loadAccountDefaults()["2fa"],
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
        // Момент авторизации фиксируется вместе с новой sessionString
        // (tg-peer-identity-model) — точка отсчёта актуальности access_hash.
        sessionAuthorizedAt: Math.floor(Date.now() / 1000),
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

    // Ретрай второй сессии — канал не создаётся (уже создан или mode A), канальные файлы не нужны.
    const template = loadPersonaTemplate(personName, false);
    const tdataPath = stagingTdataDir(agentId);
    const { apiId, apiHash } = loadAccountDefaults();
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
                    // Телефон — из самого аккаунта (design D5), сайдкары не читаются.
                    const phoneNumber = await readAccountPhone(client);
                    const agentic = await registerAgenticSession(
                        client,
                        apiId,
                        apiHash,
                        phoneNumber,
                        proxy,
                        loadAccountDefaults()["2fa"],
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
