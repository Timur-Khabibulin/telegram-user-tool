// features/channel-metrics/run.ts — метрики произвольного списка Telegram-каналов.
//
// Общее ядро для CLI (scripts/channel-metrics.ts) и OpenClaw-инструмента
// (tg_channel_metrics, index.ts) — один и тот же прогон для обоих входов
// (architecture.md: «Оба входа используют одни и те же компоненты ядра»).
// Для каждой ссылки через MTProto одной сессии агента считает число
// подписчиков, средний охват последних постов, открыты ли комментарии
// (привязана ли группа обсуждения) и является ли канал broadcast-каналом.
// С withNiche=true дополнительно одним LLM-вызовом на канал определяет
// нишу/тематику — переиспользует уже полученные title/about/посты, второго
// похода в Telegram не требует.
//
// Результат дописывается в CSV (outputPath) по ходу прогона — резюмируем:
// повторный прогон с тем же outputPath пропускает ссылки, уже присутствующие
// в файле (успешные и завершившиеся ошибкой), обрабатывает только остаток.
// Spec: openspec/changes/channel-metrics/.

import * as fs from "fs";
import { z } from "zod";

import type { Logger } from "../../core/logger";
import type { LlmClient } from "../../llm/client";
import { TelegramService, computeAvgViews, ChannelPost } from "../../core/telegram/service";
import { FloodWaitError } from "../../core/telegram/errors";
import { normalizeChannelLink } from "../../core/db/discovery";
import { classifyNiche } from "../../llm/prompts";
import {
    V5_MSG_MARK_DELAY_MIN_SEC,
    V5_MSG_MARK_DELAY_MAX_SEC,
    V5_DELAY_EMPTY_MIN_SEC,
    V5_DELAY_EMPTY_MAX_SEC,
} from "../../core/config";

const BASE_COLUMNS = ["link", "subs_count", "avg_views", "comments_open", "is_broadcast"] as const;
const NICHE_COLUMNS = ["title", "niche"] as const;
/** С withNiche добавляются title/niche (нужны данные для LLM-промпта и сам результат). */
function outputColumns(withNiche: boolean): readonly string[] {
    return withNiche ? [...BASE_COLUMNS, ...NICHE_COLUMNS, "error"] : [...BASE_COLUMNS, "error"];
}
const POSTS_SAMPLE = 11; // getRecentPosts(11) → computeAvgViews пропускает самый свежий (методология coverage-update)
// 2026-08-26: заменили фиксированный джиттер 0.8-1.2с на пейсинг monitor-v5 (тот
// же фикс, что в channel-niche.ts, — см. комментарий там про 23-часовой FLOOD_WAIT
// у agent221 на фиксированных паузах). Плюс пауза МЕЖДУ каналами — её здесь не
// было вовсе, только внутри канала (resolve → gate → posts).
const INTRA_CHANNEL_MIN_SEC = V5_MSG_MARK_DELAY_MIN_SEC;
const INTRA_CHANNEL_MAX_SEC = V5_MSG_MARK_DELAY_MAX_SEC;
const INTER_CHANNEL_MIN_SEC = V5_DELAY_EMPTY_MIN_SEC;
const INTER_CHANNEL_MAX_SEC = V5_DELAY_EMPTY_MAX_SEC;
const MAX_CONSECUTIVE_FLOOD = 2; // 2 FLOOD_WAIT подряд → стоп всего прогона
/**
 * Потолок ожидания FLOOD_WAIT (см. тот же фикс в channel-niche.ts, 2026-08-26):
 * agent221 получил там FLOOD_WAIT на 83412s (23 часа), и прогон молча простоял
 * в sleep, пока его не сняли руками. Дольше потолка не ждём — прогон
 * останавливается тем же FloodStop, что и на MAX_CONSECUTIVE_FLOOD.
 */
const MAX_FLOOD_WAIT_SEC = 600;

// ─── withNiche: та же LLM-классификация, что у channel-niche.ts ───────────
const NICHE_SYSTEM = "Ты — классификатор ниши Telegram-каналов. Отвечай только JSON.";
const nicheSchema = z.object({ niche: z.string() });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Случайная пауза в диапазоне [minSec, maxSec] — тот же приём, что sleepRandom в скиллах (monitor-v5). */
const sleepRandom = (minSec: number, maxSec: number): Promise<void> =>
    sleep((minSec + Math.random() * (maxSec - minSec)) * 1000);

/** Внутренний сигнал «прогон остановлен по FLOOD_WAIT» — не ошибка отдельной ссылки. */
class FloodStop extends Error {}

/**
 * Вызов с учётом FLOOD_WAIT: ждём и повторяем; счётчик подряд идущих FLOOD_WAIT
 * сбрасывается любым успехом, на 2-м подряд — FloodStop. Один общий счётчик на весь
 * прогон (не на ссылку) — образец features/channel-analysis/run.ts.
 */
function makeFloodAware() {
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
                    if (consecutive >= MAX_CONSECUTIVE_FLOOD || err.waitSeconds > MAX_FLOOD_WAIT_SEC) {
                        throw new FloodStop();
                    }
                    await sleep(err.waitSeconds * 1000);
                    continue;
                }
                throw err;
            }
        }
    };
}

// ─── CSV: разбор строки с учётом кавычек (RFC4180-подобно, без многострочных полей) ──

function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cur += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            cells.push(cur);
            cur = "";
        } else {
            cur += c;
        }
    }
    cells.push(cur);
    return cells;
}

/** Экспортируется — переиспользуется CLI-обёрткой (scripts/channel-metrics.ts) для разбора --input. */
export function readCsvRows(text: string): string[][] {
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

/** Уже записанные ссылки в существующем outputPath (по значению колонки link "как есть"). */
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

// ─── Резолв ссылки: публичная (username) vs приватная (без username) ─────

interface LinkKey {
    /** Каноническая форма ссылки, записывается в колонку link и используется для резюмируемости. */
    key: string;
    /** username для resolveChannelByUsername; null — ссылка приватная, MTProto не вызываем. */
    username: string | null;
}

/**
 * `normalizeChannelLink` схлопывает все `t.me/joinchat/<hash>` в один и тот же
 * `https://t.me/joinchat`, теряя различающий хэш (её парсинг берёт только первый
 * сегмент пути). Для резюмируемости это дало бы коллизию — второй и последующий
 * joinchat-ссылки в одном списке молча считались бы «уже обработанными». Поэтому
 * для приватных ссылок используем как ключ исходную (нормализованную по регистру)
 * строку, а не лоссовый вывод normalizeChannelLink; для публичных — как обычно,
 * normalizeChannelLink (см. design.md D7, D9 change channel-metrics).
 */
function resolveLinkKey(raw: string): LinkKey {
    const normalized = normalizeChannelLink(raw);
    const tail = normalized.replace(/^https:\/\/t\.me\//, "");
    const isPrivate = tail === "" || tail.startsWith("+") || tail === "joinchat";
    if (isPrivate) {
        return { key: raw.trim().toLowerCase(), username: null };
    }
    return { key: normalized, username: tail };
}

// ─── Метрики канала ───────────────────────────────────────────────────

interface ChannelMetrics {
    subsCount: string;
    avgViews: string;
    commentsOpen: string;
    isBroadcast: string;
    title: string;
    niche: string;
    error: string;
}

/**
 * withNiche: один LLM-вызов на канал, переиспользует title/about/posts, уже
 * полученные для метрик — второго похода в Telegram не требует. Ошибка LLM не
 * роняет уже посчитанные метрики — попадает в error отдельно (как в
 * channel-niche.ts: пустые about+посты — тоже не вызываем LLM, сразу error).
 */
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

async function measureChannel(
    tg: TelegramService,
    username: string,
    floodAware: <T>(fn: () => Promise<T>) => Promise<T>,
    llm: LlmClient | undefined,
): Promise<ChannelMetrics> {
    const empty: ChannelMetrics = { subsCount: "", avgViews: "", commentsOpen: "", isBroadcast: "", title: "", niche: "", error: "" };

    const handle = await floodAware(() => tg.resolveChannelByUsername(username));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);
    if (!handle) return { ...empty, error: "канал не найден" };

    const isBroadcast = String(handle.isBroadcast === true);

    const gate = await floodAware(() => tg.getChannelGateInfo(handle.inputChannel));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);

    const posts = await floodAware(() => tg.getRecentPosts(handle.inputChannel, POSTS_SAMPLE));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);
    const avgViews = computeAvgViews(posts);

    let niche = "";
    let nicheError = "";
    if (llm) {
        const result = await classifyChannelNiche(llm, handle.title, gate.about ?? "", posts);
        niche = result.niche;
        nicheError = result.error;
    }

    return {
        subsCount: gate.subscribers != null ? String(gate.subscribers) : "",
        avgViews: avgViews != null ? String(Math.round(avgViews * 10) / 10) : "",
        commentsOpen: String(gate.linkedChatId != null),
        isBroadcast,
        title: llm ? handle.title : "",
        niche,
        error: nicheError,
    };
}

// ─── Прогон ───────────────────────────────────────────────────────────

export interface ChannelMetricsParams {
    links: string[];
    agentId: string;
    /** Путь к CSV-результату — append по ходу прогона, резюмируем при повторном запуске с тем же путём. */
    outputPath: string;
    withNiche: boolean;
    /** Обязателен при withNiche=true; вызывающий сам решает, когда создавать LLM-клиент. */
    llm?: LlmClient;
}

export interface ChannelMetricsResult {
    outputPath: string;
    done: number;
    skipped: number;
    stoppedByFlood: boolean;
}

export async function runChannelMetrics(p: ChannelMetricsParams, log: Logger): Promise<ChannelMetricsResult> {
    const processed = readProcessedLinks(p.outputPath);
    log.info(`[channel-metrics] agentId=${p.agentId} вход: ${p.links.length} ссылок, уже обработано: ${processed.size}${p.withNiche ? ", с классификацией ниши" : ""}`);

    if (!fs.existsSync(p.outputPath) || fs.readFileSync(p.outputPath, "utf8").trim().length === 0) {
        fs.writeFileSync(p.outputPath, csvRow(outputColumns(p.withNiche)));
    }

    const tg = new TelegramService(log);
    const floodAware = makeFloodAware();
    let done = 0;
    let skipped = 0;
    let stoppedByFlood = false;

    try {
        tg.loadAccount(p.agentId);

        for (const raw of p.links) {
            const { key, username } = resolveLinkKey(raw);
            if (processed.has(key)) {
                skipped++;
                continue;
            }

            let metrics: ChannelMetrics;
            if (!username) {
                metrics = {
                    subsCount: "",
                    avgViews: "",
                    commentsOpen: "",
                    isBroadcast: "",
                    title: "",
                    niche: "",
                    error: "приватная ссылка, резолв по username невозможен",
                };
            } else {
                try {
                    metrics = await measureChannel(tg, username, floodAware, p.llm);
                } catch (err) {
                    if (err instanceof FloodStop) {
                        stoppedByFlood = true;
                        break;
                    }
                    metrics = {
                        subsCount: "",
                        avgViews: "",
                        commentsOpen: "",
                        isBroadcast: "",
                        title: "",
                        niche: "",
                        error: (err as any)?.message ?? String(err),
                    };
                }
            }

            const row = p.withNiche
                ? [key, metrics.subsCount, metrics.avgViews, metrics.commentsOpen, metrics.isBroadcast, metrics.title, metrics.niche, metrics.error]
                : [key, metrics.subsCount, metrics.avgViews, metrics.commentsOpen, metrics.isBroadcast, metrics.error];
            fs.appendFileSync(p.outputPath, csvRow(row));
            processed.add(key);
            done++;
            log.info(`[channel-metrics] ${key} — ${metrics.error ? `error: ${metrics.error}` : "ok"}`);
            await sleepRandom(INTER_CHANNEL_MIN_SEC, INTER_CHANNEL_MAX_SEC);
        }
    } finally {
        await tg.disconnect().catch(() => {});
    }

    return { outputPath: p.outputPath, done, skipped, stoppedByFlood };
}
