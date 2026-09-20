// features/channel-full-metrics/run.ts — объединённый расчёт ВСЕХ метрик канала
// за один резолв, параллельно волнами по пулу агентов (channel-metrics-pipeline).
//
// Ядро измерения — то же, что features/channel-metrics/run.ts (subs_count,
// avg_views, comments_open, is_broadcast, niche за один резолв), расширенное
// активностью из channel-activity-update.ts (--input): при наличии группы
// обсуждения дочитывает посты за 30 дней и считает posts_30d/total_comments/
// comments_per_day по числу комментариев в самих постах (историю обсуждения не
// читаем — методика channel-activity-update). Волновой воркер (очередь,
// session-lock, FLOOD, резюмируемость) — дословный каркас channel-niche.ts.
//
// Прогон резюмируем: повторный запуск с тем же outputPath пропускает ссылки, уже
// присутствующие в файле. Прогресс отдаётся колбэком onProcessed (воркер пишет
// его в БД задачи для /status).

import * as fs from "fs";
import { z } from "zod";

import type { Logger } from "../../core/logger";
import type { LlmClient } from "../../llm/client";
import { TelegramService, computeAvgViews, ChannelPost } from "../../core/telegram/service";
import {
    FloodWaitError,
    ClientNotConnectedError,
    SessionRevokedError,
    AccountBannedError,
} from "../../core/telegram/errors";
import { acquireSession, releaseSession, SessionBusyError } from "../../core/telegram/session-lock";
import { normalizeChannelLink } from "../../core/db/discovery";
import {
    V5_MSG_MARK_DELAY_MIN_SEC,
    V5_MSG_MARK_DELAY_MAX_SEC,
    V5_DELAY_EMPTY_MIN_SEC,
    V5_DELAY_EMPTY_MAX_SEC,
} from "../../core/config";
import { classifyNiche } from "../../llm/prompts";

/** Колонки output-CSV — совпадают с метриками листа all-processed-channels (+ error). */
export const FULL_METRICS_COLUMNS = [
    "link", "title", "niche", "subs_count", "avg_views", "comments_open", "is_broadcast",
    "posts_30d", "total_comments", "comments_per_day", "error",
] as const;

const N_POSTS = 11; // getRecentPosts(11): computeAvgViews пропускает самый свежий (методика coverage), текст идёт в LLM-нишу
const POSTS_WINDOW_DAYS = 30; // окно активности (комментарии в день)

// Пейсинг monitor-v5 — тот же, что channel-niche/channel-metrics (см. комментарии там).
const INTRA_CHANNEL_MIN_SEC = V5_MSG_MARK_DELAY_MIN_SEC;
const INTRA_CHANNEL_MAX_SEC = V5_MSG_MARK_DELAY_MAX_SEC;
const INTER_CHANNEL_MIN_SEC = V5_DELAY_EMPTY_MIN_SEC;
const INTER_CHANNEL_MAX_SEC = V5_DELAY_EMPTY_MAX_SEC;
const PASS_PAUSE_MS = 5000;
const MAX_CONSECUTIVE_FLOOD = 2;
const MAX_FLOOD_WAIT_SEC = 600;
const MAX_CONSECUTIVE_NOT_FOUND = 6;
const MAX_CONSECUTIVE_SESSION_ERRORS = 3;
const AGENT_BATCH_SIZE = 55;
const DEFAULT_PARALLELISM = 10;

// Забор постов окна активности имитирует листание ленты (channel-activity-update).
const POSTS_BATCH_MIN = 2;
const POSTS_BATCH_MAX = 4;
const POSTS_BATCH_DELAY_MIN_SEC = 2;
const POSTS_BATCH_DELAY_MAX_SEC = 8;
const POSTS_MAX_REQUESTS = 400;
const POSTS_MAX_POSTS = 800;

const NICHE_SYSTEM = "Ты — классификатор ниши Telegram-каналов. Отвечай только JSON.";
const nicheSchema = z.object({ niche: z.string() });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sleepRandom = (minSec: number, maxSec: number): Promise<void> =>
    sleep((minSec + Math.random() * (maxSec - minSec)) * 1000);
const randomDelayMs = (minSec: number, maxSec: number): number => (minSec + Math.random() * (maxSec - minSec)) * 1000;

/** Внутренний сигнал остановки текущего воркера (не всей волны/прогона). */
class WorkerStop extends Error {
    constructor(public readonly reason: string) { super(reason); }
}

function makeFloodAware(onStop: (reason: string) => never) {
    let consecutive = 0;
    return async function floodAware<T>(fn: () => Promise<T>): Promise<T> {
        for (;;) {
            try {
                const r = await fn();
                consecutive = 0;
                return r;
            } catch (err) {
                if (err instanceof FloodWaitError) {
                    consecutive += 1;
                    if (consecutive >= MAX_CONSECUTIVE_FLOOD) onStop(`FLOOD_WAIT ${MAX_CONSECUTIVE_FLOOD} раза подряд`);
                    if (err.waitSeconds > MAX_FLOOD_WAIT_SEC) {
                        onStop(`FLOOD_WAIT ${err.waitSeconds}s дольше потолка ${MAX_FLOOD_WAIT_SEC}s — аккаунт снят с прогона`);
                    }
                    await sleep(err.waitSeconds * 1000);
                    continue;
                }
                throw err;
            }
        }
    };
}

// ─── CSV-примитивы (те же, что channel-niche/channel-metrics) ──────────

function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
            } else cur += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") { cells.push(cur); cur = ""; }
        else cur += c;
    }
    cells.push(cur);
    return cells;
}

function readCsvRows(text: string): string[][] {
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.map(parseCsvLine);
}

function csvCell(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(values: readonly string[]): string {
    return values.map(csvCell).join(",") + "\n";
}

function readProcessedLinks(outputPath: string): Set<string> {
    if (!fs.existsSync(outputPath)) return new Set();
    const text = fs.readFileSync(outputPath, "utf8");
    if (text.trim().length === 0) return new Set();
    const rows = readCsvRows(text);
    if (rows.length <= 1) return new Set();
    const linkIdx = rows[0].indexOf("link");
    if (linkIdx === -1) return new Set();
    return new Set(rows.slice(1).map((r) => r[linkIdx] ?? "").filter((v) => v.length > 0));
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

interface LinkKey {
    key: string;
    username: string | null;
}

function resolveLinkKey(raw: string): LinkKey {
    const normalized = normalizeChannelLink(raw);
    const tail = normalized.replace(/^https:\/\/t\.me\//, "");
    const isPrivate = tail === "" || tail.startsWith("+") || tail === "joinchat";
    if (isPrivate) return { key: raw.trim().toLowerCase(), username: null };
    return { key: normalized, username: tail };
}

// ─── Измерение одного канала (все метрики за один резолв) ──────────────

interface ChannelFullMetrics {
    title: string;
    niche: string;
    subsCount: string;
    avgViews: string;
    commentsOpen: string;
    isBroadcast: string;
    posts30d: string;
    totalComments: string;
    commentsPerDay: string;
    error: string;
}

const EMPTY_METRICS: ChannelFullMetrics = {
    title: "", niche: "", subsCount: "", avgViews: "", commentsOpen: "", isBroadcast: "",
    posts30d: "", totalComments: "", commentsPerDay: "", error: "",
};

async function classifyChannelNiche(
    llm: LlmClient,
    title: string,
    about: string,
    posts: ChannelPost[],
): Promise<{ niche: string; error: string }> {
    const texts = posts.map((p) => p.text.trim()).filter((t) => t.length > 0);
    if (about.trim().length === 0 && texts.length === 0) {
        return { niche: "", error: "нет текста (about пуст, посты без текста)" };
    }
    try {
        const r = await llm.completeObject({ system: NICHE_SYSTEM, prompt: classifyNiche(title, about, texts) }, nicheSchema);
        return { niche: r.niche ?? "", error: "" };
    } catch (err: any) {
        return { niche: "", error: `LLM: ${err?.message ?? err}` };
    }
}

async function measureChannelFull(
    tg: TelegramService,
    llm: LlmClient,
    username: string,
    floodAware: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<ChannelFullMetrics> {
    const handle = await floodAware(() => tg.resolveChannelByUsername(username));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);
    if (!handle) return { ...EMPTY_METRICS, error: "канал не найден" };

    const isBroadcast = String(handle.isBroadcast === true);

    const gate = await floodAware(() => tg.getChannelGateInfo(handle.inputChannel));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);

    const recent = await floodAware(() => tg.getRecentPosts(handle.inputChannel, N_POSTS));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);
    const avgViews = computeAvgViews(recent);

    const { niche, error: nicheError } = await classifyChannelNiche(llm, handle.title, gate.about ?? "", recent);

    // Активность: только если есть привязанная группа обсуждения (комментарии
    // включены). Считаем по числу комментариев в самих постах окна — без чтения
    // истории обсуждения (методика channel-activity-update.ts --input).
    let posts30d = "";
    let totalComments = "";
    let commentsPerDay = "";
    if (gate.linkedChatId != null) {
        const sinceSec = Math.floor(Date.now() / 1000) - POSTS_WINDOW_DAYS * 86400;
        const windowPosts = await floodAware(() => tg.getPostsSince(handle.inputChannel, sinceSec, {
            maxRequests: POSTS_MAX_REQUESTS,
            maxPosts: POSTS_MAX_POSTS,
            pageSize: () => POSTS_BATCH_MIN + Math.floor(Math.random() * (POSTS_BATCH_MAX - POSTS_BATCH_MIN + 1)),
            pageDelayMs: () => randomDelayMs(POSTS_BATCH_DELAY_MIN_SEC, POSTS_BATCH_DELAY_MAX_SEC),
        }));
        await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);
        if (windowPosts.length > 0) {
            const sum = windowPosts.reduce((s, p) => s + p.comments, 0);
            posts30d = String(windowPosts.length);
            totalComments = String(sum);
            commentsPerDay = (sum / POSTS_WINDOW_DAYS).toFixed(1);
        }
    }

    return {
        title: handle.title,
        niche,
        subsCount: gate.subscribers != null ? String(gate.subscribers) : "",
        avgViews: avgViews != null ? String(Math.round(avgViews * 10) / 10) : "",
        commentsOpen: String(gate.linkedChatId != null),
        isBroadcast,
        posts30d,
        totalComments,
        commentsPerDay,
        error: nicheError,
    };
}

function metricsToRow(key: string, m: ChannelFullMetrics): string[] {
    return [
        key, m.title, m.niche, m.subsCount, m.avgViews, m.commentsOpen, m.isBroadcast,
        m.posts30d, m.totalComments, m.commentsPerDay, m.error,
    ];
}

// ─── Волновой воркер (каркас channel-niche.ts) ─────────────────────────

interface SharedQueue {
    nextLink(): string | undefined;
    processed: Set<string>;
    outputPath: string;
    onProcessed(): void;
}

interface WorkerResult {
    agentId: string;
    done: number;
    stopReason: string;
}

async function runWorker(
    agentId: string,
    batchSize: number,
    llm: LlmClient,
    queue: SharedQueue,
    log: Logger,
): Promise<WorkerResult> {
    const tg = new TelegramService(log);
    let done = 0;
    let consecutiveNotFound = 0;
    let consecutiveSessionErrors = 0;
    let stopReason = "";

    const stop = (reason: string): never => { throw new WorkerStop(reason); };
    const floodAware = makeFloodAware(stop);
    let locked = false;

    try {
        acquireSession(agentId, "channel-full-metrics");
        locked = true;
        tg.loadAccount(agentId);

        for (;;) {
            if (done >= batchSize) { stopReason = `квота из ${batchSize} каналов выбрана`; break; }

            const raw = queue.nextLink();
            if (raw === undefined) { stopReason = "очередь пуста"; break; }

            const { key, username } = resolveLinkKey(raw);
            if (queue.processed.has(key)) continue;

            let result: ChannelFullMetrics;
            if (!username) {
                result = { ...EMPTY_METRICS, error: "приватная ссылка, резолв по username невозможен" };
            } else {
                try {
                    result = await measureChannelFull(tg, llm, username, floodAware);
                    consecutiveSessionErrors = 0;
                } catch (err) {
                    if (err instanceof WorkerStop) { stopReason = err.reason; break; }

                    if (err instanceof ClientNotConnectedError) {
                        if (err instanceof SessionRevokedError || err instanceof AccountBannedError) {
                            stopReason = `сессия непригодна (${err.message}) — аккаунту нужен перелогин`;
                            break;
                        }
                        consecutiveSessionErrors += 1;
                        log.warn(
                            `[channel-full-metrics:${agentId}] ${key} — ссылка возвращена в очередь, сбой сессии ` +
                            `(${consecutiveSessionErrors}/${MAX_CONSECUTIVE_SESSION_ERRORS}): ${err.message}`,
                        );
                        if (consecutiveSessionErrors >= MAX_CONSECUTIVE_SESSION_ERRORS) {
                            stopReason = `${MAX_CONSECUTIVE_SESSION_ERRORS} сбоя сессии подряд — аккаунт снят с прогона`;
                            break;
                        }
                        continue;
                    }

                    result = { ...EMPTY_METRICS, error: (err as any)?.message ?? String(err) };
                }
            }

            if (result.error === "канал не найден") {
                consecutiveNotFound += 1;
                if (consecutiveNotFound >= MAX_CONSECUTIVE_NOT_FOUND) {
                    fs.appendFileSync(queue.outputPath, csvRow(metricsToRow(key, result)));
                    queue.processed.add(key);
                    queue.onProcessed();
                    done++;
                    stopReason = `"канал не найден" ${MAX_CONSECUTIVE_NOT_FOUND} раз(а) подряд (деградация резолвинга)`;
                    break;
                }
            } else {
                consecutiveNotFound = 0;
            }

            fs.appendFileSync(queue.outputPath, csvRow(metricsToRow(key, result)));
            queue.processed.add(key);
            queue.onProcessed();
            done++;
            log.info(`[channel-full-metrics:${agentId}] ${key} — ${result.error ? `error: ${result.error}` : "ok"}`);

            await sleepRandom(INTER_CHANNEL_MIN_SEC, INTER_CHANNEL_MAX_SEC);
        }
    } catch (err: any) {
        stopReason = err instanceof SessionBusyError ? `пропущен — ${err.message}` : `fatal: ${err?.message ?? err}`;
    } finally {
        await tg.disconnect().catch(() => {});
        if (locked) releaseSession(agentId);
    }

    log.info(`[channel-full-metrics:${agentId}] воркер остановлен — обработано ${done}, причина: ${stopReason}`);
    return { agentId, done, stopReason };
}

// ─── Прогон ───────────────────────────────────────────────────────────

export interface FullMetricsParams {
    links: string[];
    agentIds: string[];
    outputPath: string;
    llm: LlmClient;
    parallelism?: number;
    batchSize?: number;
    /** Колбэк после каждой обработанной ссылки — для прогресса задачи (/status). */
    onProcessed?: (processed: number) => void;
}

export interface FullMetricsResult {
    outputPath: string;
    done: number;
    remaining: number;
}

/**
 * Считает все метрики для списка ссылок волнами по agentIds, дописывая output-CSV.
 * Проходы повторяются, пока очередь не разобрана или очередной проход не обработал
 * ни одного канала (все агенты заняты/деградировали) — как channel-niche --until-done.
 */
export async function runFullMetrics(p: FullMetricsParams, log: Logger): Promise<FullMetricsResult> {
    const agentIds = [...new Set(p.agentIds)];
    const parallelism = p.parallelism ?? DEFAULT_PARALLELISM;
    const batchSize = p.batchSize ?? AGENT_BATCH_SIZE;
    const processed = readProcessedLinks(p.outputPath);
    const waves = chunk(agentIds, parallelism);

    log.info(
        `[channel-full-metrics] агенты=${agentIds.length} (волнами по ${parallelism}), батч ${batchSize}/аккаунт, ` +
        `вход: ${p.links.length} ссылок, уже обработано: ${processed.size}`,
    );

    if (!fs.existsSync(p.outputPath) || fs.readFileSync(p.outputPath, "utf8").trim().length === 0) {
        fs.writeFileSync(p.outputPath, csvRow(FULL_METRICS_COLUMNS));
    }

    let cursor = 0;
    let totalProcessed = processed.size;
    const queue: SharedQueue = {
        nextLink: () => (cursor < p.links.length ? p.links[cursor++] : undefined),
        processed,
        outputPath: p.outputPath,
        onProcessed: () => { totalProcessed++; p.onProcessed?.(totalProcessed); },
    };

    for (let pass = 1; ; pass++) {
        cursor = 0;
        let passDone = 0;

        for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
            if (cursor >= p.links.length) break;
            const waveAgents = waves[waveIdx];
            log.info(`[channel-full-metrics] проход ${pass}, волна ${waveIdx + 1}/${waves.length}: агенты=${waveAgents.join(",")}`);
            const results = await Promise.all(waveAgents.map((agentId) => runWorker(agentId, batchSize, p.llm, queue, log)));
            for (const r of results) passDone += r.done;
            const summary = results.map((r) => `${r.agentId}=${r.done} (${r.stopReason})`).join("; ");
            log.info(`[channel-full-metrics] проход ${pass}, волна ${waveIdx + 1}/${waves.length} завершена: ${summary}`);
        }

        const left = p.links.length - processed.size;
        if (left <= 0) break;
        if (passDone === 0) {
            log.warn(`[channel-full-metrics] проход ${pass} не обработал ни одного канала — останавливаюсь, остаток ${left}`);
            break;
        }
        log.info(`[channel-full-metrics] проход ${pass} завершён: +${passDone}, остаток ${left} — продолжаю`);
        await sleep(PASS_PAUSE_MS);
    }

    const remaining = p.links.length - processed.size;
    log.info(`[channel-full-metrics] done — обработано всего: ${processed.size}, остаток: ${remaining}`);
    return { outputPath: p.outputPath, done: processed.size, remaining };
}
