// features/channel-analysis/run.ts — оркестрация анализа контента топ-каналов агентов.
//
// По запросу оператора: для каждого агента из списка берём его broadcast-каналы (из
// кэша идентичности в channels.db — резолв сделан заранее на синхронизации, без внешних
// сервисов), берём размер живьём, сортируем по подписчикам, берём верхние m%, собираем
// последние n постов, считаем вовлечённость (ERR по охвату),
// тегируем тему поста через LLM и выгружаем единый CSV (строка = пост) на сервер и в
// Telegram. Последовательно по агентам на их сессиях (вариант B: раздел/строки на
// агента в одном файле). Изоляция сбоев: плохой канал/агент пропускается с записью,
// прогон не падает.
// Spec: openspec/changes/channel-content-analysis/.

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

import type { Logger } from "../../core/logger";
import type { LlmClient } from "../../llm/client";
import { analyzePosts } from "../../llm/prompts";
import { reportsDir } from "../../core/config";
import { TelegramService, type ChannelPost, type ChannelHandle } from "../../core/telegram/service";
import { FloodWaitError } from "../../core/telegram/errors";
import {
    initChannels,
    getAnalysisChannels,
    saveChannelIdentity,
    type AnalysisChannelRow,
} from "../../core/db/channels";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Пауза между MTProto-вызовами — бережём сессию (read-методы, но каналов может быть
// много). Тот же темп, что у обхода discovery-similar.
const pacingMs = () => 800 + Math.random() * 400; // 0.8–1.2 c
const MAX_CONSECUTIVE_FLOOD = 2; // 2 FLOOD_WAIT подряд → стоп текущего агента

const ANALYZE_SYSTEM = "Ты — аналитик контента Telegram-постов. Отвечай только JSON.";
const analyzeSchema = z.array(
    z.object({ i: z.number(), topic: z.string().optional(), summary: z.string().optional() }),
);

/** Внутренний сигнал «обработка агента остановлена по FLOOD_WAIT». */
class FloodStop extends Error {}

/**
 * Вызов с учётом FLOOD_WAIT: ждём и повторяем; счётчик подряд идущих FLOOD_WAIT
 * сбрасывается успехом, на 2-м подряд — FloodStop. Локален на сессию одного агента.
 */
function makeFloodAware(agentId: string, log: Logger) {
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
                    if (consecutive >= MAX_CONSECUTIVE_FLOOD) {
                        log.warn(`[content-analysis] ${agentId}: FLOOD_WAIT ${MAX_CONSECUTIVE_FLOOD} раза подряд — стоп агента`);
                        throw new FloodStop();
                    }
                    log.warn(`[content-analysis] ${agentId}: FLOOD_WAIT ${err.waitSeconds}s — ждём и повторяем`);
                    await sleep(err.waitSeconds * 1000);
                    continue;
                }
                throw err;
            }
        }
    };
}

// ─── Типы ─────────────────────────────────────────────────────────────

export interface AnalysisParams {
    agents: string[];     // у каких агентов брать каналы
    n: number;            // постов с каждого канала
    m: number;            // процент самых крупных каналов (0, 100]
    adminAgentId: string; // владелец каталога reports/
    llm: LlmClient;       // тег темы поста
}

/** Строка отчёта — один пост. */
export interface PostRow {
    agent: string;
    channel: string;     // @username или title
    channelSize: number;
    topic: string;       // тег темы (пусто при сбое LLM)
    summary: string;     // суммаризация поста (пусто при сбое LLM)
    err: number;         // ERR по охвату, %
    views: number;
    reactions: number;
    comments: number;
    forwards: number;
    ageDays: number;     // возраст поста в днях
    link: string;
}

/** Запись о пропущенном элементе для секции «проблемы» отчёта. */
export interface SkipNote {
    agent: string;
    channel?: string;
    reason: string;
}

export interface AnalysisResult {
    csvPath: string;
    rowCount: number;
    agentsProcessed: number;
    channelsAnalyzed: number;
    skipped: SkipNote[];
}

// ─── Хелперы ──────────────────────────────────────────────────────────

const channelLabel = (ch: ChannelHandle): string => (ch.username ? `@${ch.username}` : ch.title || "—");

/** Ссылка на пост: публичный канал — по username, приватный — по internal id. */
function postLink(ch: ChannelHandle, msgId: number): string {
    if (ch.username) return `https://t.me/${ch.username}/${msgId}`;
    return `https://t.me/c/${ch.inputChannel.channelId.toString()}/${msgId}`;
}

/**
 * Тема и суммаризация каждого поста (один LLM-вызов на канал). Fail-soft: при
 * сбое/таймауте возвращает пустые тему и суммаризацию — метрики не теряются. В LLM
 * уходят только посты с непустым текстом; результат выровнен по индексу исходного
 * массива постов.
 */
async function analyzePostsLlm(
    llm: LlmClient,
    posts: ChannelPost[],
    log: Logger,
): Promise<{ topic: string; summary: string }[]> {
    const out = posts.map(() => ({ topic: "", summary: "" }));
    const withText = posts
        .map((p, i) => ({ i, text: p.text.trim() }))
        .filter((p) => p.text.length > 0);
    if (withText.length === 0) return out;

    const block = withText.map((p) => `i=${p.i}: ${p.text.replace(/\s+/g, " ").slice(0, 800)}`).join("\n");
    try {
        const result = await llm.completeObject({ system: ANALYZE_SYSTEM, prompt: analyzePosts(block) }, analyzeSchema);
        for (const { i, topic, summary } of result) {
            if (i >= 0 && i < out.length) {
                out[i] = { topic: (topic ?? "").trim(), summary: (summary ?? "").trim() };
            }
        }
    } catch (err) {
        log.info(`[content-analysis] анализ постов не получен (деградация без темы/суммаризации): ${(err as any)?.message ?? err}`);
    }
    return out;
}

const isChannelInvalid = (err: unknown): boolean => /CHANNEL_INVALID/i.test((err as any)?.message ?? "");

/**
 * Размер канала из кэшированной идентичности. При `CHANNEL_INVALID` (устаревший
 * accessHash) — разовый пере-резолв по username, обновление кэша и повтор. Возвращает
 * `{ ch, size }` или null, если размер недоступен. FloodStop пробрасывается.
 */
async function measureCachedChannel(
    tg: TelegramService,
    agentId: string,
    c: AnalysisChannelRow,
    floodAware: <T>(fn: () => Promise<T>) => Promise<T>,
    log: Logger,
): Promise<{ ch: ChannelHandle; size: number } | null> {
    const handle = tg.buildChannelHandle(
        { channelId: c.channelId, accessHash: c.channelAccessHash, username: c.channelUsername },
        c.title,
    );
    try {
        const size = await floodAware(() => tg.getChannelSubsCount(handle.inputChannel));
        await sleep(pacingMs());
        return size == null ? null : { ch: handle, size };
    } catch (err) {
        if (err instanceof FloodStop) throw err;
        if (!isChannelInvalid(err) || !c.channelUsername) throw err;
        // accessHash в кэше протух → пере-резолв по username, обновить кэш, повторить.
        const fresh = await floodAware(() => tg.resolveChannelByUsername(c.channelUsername!));
        await sleep(pacingMs());
        if (!fresh) throw err;
        saveChannelIdentity(
            agentId,
            c.chatId,
            {
                channelId: fresh.inputChannel.channelId.toString(),
                accessHash: fresh.inputChannel.accessHash?.toString() ?? "0",
                username: fresh.username,
            },
            log,
        );
        const size = await floodAware(() => tg.getChannelSubsCount(fresh.inputChannel));
        await sleep(pacingMs());
        return size == null ? null : { ch: fresh, size };
    }
}

// ─── Прогон ───────────────────────────────────────────────────────────

export async function runChannelAnalysis(p: AnalysisParams, log: Logger): Promise<AnalysisResult> {
    const tg = new TelegramService(log);
    const rows: PostRow[] = [];
    const skipped: SkipNote[] = [];
    let agentsProcessed = 0;
    let channelsAnalyzed = 0;
    const nowSec = Math.floor(Date.now() / 1000);

    try {
        for (const agentId of p.agents) {
            const floodAware = makeFloodAware(agentId, log);
            try {
                tg.loadAccount(agentId);
                initChannels(agentId, log); // гарантировать схему/миграцию channels.db
                const cached = getAnalysisChannels(agentId, log);
                log.info(`[content-analysis] ${agentId}: каналов в кэше ${cached.length}, измеряю размеры…`);

                // Идентичность канала — из кэша (резолв сделан на синхронизации, см.
                // channel-sync). Размер берём живьём → сортировка по убыванию → верхние m%.
                const withSize: { ch: ChannelHandle; size: number }[] = [];
                for (const c of cached) {
                    const label = c.channelUsername ? `@${c.channelUsername}` : c.title || "—";
                    try {
                        const measured = await measureCachedChannel(tg, agentId, c, floodAware, log);
                        if (!measured) {
                            skipped.push({ agent: agentId, channel: label, reason: "размер неизвестен" });
                            continue;
                        }
                        withSize.push(measured);
                    } catch (err) {
                        if (err instanceof FloodStop) throw err;
                        skipped.push({ agent: agentId, channel: label, reason: `размер: ${(err as any)?.message ?? err}` });
                    }
                }

                withSize.sort((a, b) => b.size - a.size);
                const take = withSize.length === 0 ? 0 : Math.max(1, Math.ceil((withSize.length * p.m) / 100));
                const selected = withSize.slice(0, take);
                log.info(`[content-analysis] ${agentId}: отобрано ${selected.length}/${withSize.length} каналов (верхние ${p.m}%)`);

                for (const { ch, size } of selected) {
                    try {
                        const posts = await floodAware(() => tg.getRecentPosts(ch.inputChannel, p.n));
                        await sleep(pacingMs());
                        channelsAnalyzed += 1;
                        if (posts.length === 0) {
                            skipped.push({ agent: agentId, channel: channelLabel(ch), reason: "нет постов" });
                            continue;
                        }
                        const analysis = await analyzePostsLlm(p.llm, posts, log);
                        for (let idx = 0; idx < posts.length; idx++) {
                            const post = posts[idx];
                            if (post.views <= 0) continue; // нет охвата → ERR не считаем (деление на ноль)
                            const err = (post.forwards / post.views) * 100; // репосты / просмотры
                            rows.push({
                                agent: agentId,
                                channel: channelLabel(ch),
                                channelSize: size,
                                topic: analysis[idx].topic,
                                summary: analysis[idx].summary,
                                err: Math.round(err * 100) / 100,
                                views: post.views,
                                reactions: post.reactions,
                                comments: post.comments,
                                forwards: post.forwards,
                                ageDays: Math.round(((nowSec - post.date) / 86400) * 10) / 10,
                                link: postLink(ch, post.id),
                            });
                        }
                    } catch (err) {
                        if (err instanceof FloodStop) throw err;
                        skipped.push({ agent: agentId, channel: channelLabel(ch), reason: `посты: ${(err as any)?.message ?? err}` });
                    }
                }
                agentsProcessed += 1;
            } catch (err) {
                if (err instanceof FloodStop) {
                    skipped.push({ agent: agentId, reason: "прерван FLOOD_WAIT" });
                } else {
                    skipped.push({ agent: agentId, reason: `агент: ${(err as any)?.message ?? err}` });
                    log.error(`[content-analysis] ${agentId}: ошибка — ${(err as any)?.message ?? err}`);
                }
            } finally {
                await tg.disconnect().catch(() => {});
            }
        }

        // Строки идут группами без сортировки по ERR: порядок вставки уже даёт
        // агент (внешний цикл) → канал (по убыванию размера) → посты канала подряд.

        // Запись CSV в workspace админ-агента.
        const dir = reportsDir(p.adminAgentId);
        fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const csvPath = path.join(dir, `channel-analysis-${ts}.csv`);
        fs.writeFileSync(csvPath, buildCsv(rows), "utf-8");
        log.info(`[content-analysis] CSV записан: ${csvPath} (${rows.length} строк)`);

        const result: AnalysisResult = {
            csvPath,
            rowCount: rows.length,
            agentsProcessed,
            channelsAnalyzed,
            skipped,
        };

        // Доставка: сообщение-статистика + CSV в Saved Messages админ-агента.
        try {
            tg.loadAccount(p.adminAgentId);
            await tg.sendSavedDocument(csvPath, renderStats(result));
        } catch (err) {
            log.warn(`[content-analysis] не удалось отправить CSV в Telegram: ${(err as any)?.message ?? err}`);
        } finally {
            await tg.disconnect().catch(() => {});
        }

        return result;
    } finally {
        await tg.disconnect().catch(() => {});
    }
}

// ─── CSV и отчёт ──────────────────────────────────────────────────────

const CSV_COLUMNS = [
    "agent",
    "channel",
    "channel_size",
    "topic",
    "summary",
    "ERR",
    "views",
    "reactions",
    "comments",
    "forwards",
    "age_days",
    "link",
] as const;

/** Экранирование значения CSV: кавычки/запятые/переносы строк. */
function csvCell(value: string | number): string {
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(rows: PostRow[]): string {
    const lines = [CSV_COLUMNS.join(",")];
    for (const r of rows) {
        lines.push(
            [
                r.agent,
                r.channel,
                r.channelSize,
                r.topic,
                r.summary,
                r.err,
                r.views,
                r.reactions,
                r.comments,
                r.forwards,
                r.ageDays,
                r.link,
            ]
                .map(csvCell)
                .join(","),
        );
    }
    return lines.join("\n") + "\n";
}

/** Короткое сообщение-статистика прогона (подпись к CSV / ответ оператору). */
export function renderStats(r: AnalysisResult): string {
    const lines: string[] = [];
    lines.push("📊 Анализ контента топ-каналов");
    lines.push(`• агентов обработано: ${r.agentsProcessed}`);
    lines.push(`• каналов проанализировано: ${r.channelsAnalyzed}`);
    lines.push(`• постов в отчёте: ${r.rowCount}`);
    if (r.skipped.length > 0) {
        lines.push(`• пропущено: ${r.skipped.length}`);
        for (const s of r.skipped.slice(0, 10)) {
            lines.push(`  ⚠️ ${s.agent}${s.channel ? ` / ${s.channel}` : ""}: ${s.reason}`);
        }
        if (r.skipped.length > 10) lines.push(`  …и ещё ${r.skipped.length - 10}`);
    }
    lines.push("");
    lines.push("ERR = пересылки (репосты) / просмотры × 100%");
    lines.push("age_days — возраст поста в днях (у свежих постов ERR занижен: охват ещё не набран)");
    lines.push("");
    lines.push(`CSV: ${path.basename(r.csvPath)}`);
    return lines.join("\n");
}
