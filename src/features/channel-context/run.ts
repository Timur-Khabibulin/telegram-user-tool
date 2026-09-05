// features/channel-context/run.ts — фоновый анализ содержания каналов агента.
//
// Для каждого отобранного канала (см. getChannelsForContextAnalysis, TTL 90 дней,
// без фильтра по status): about + закреп + посты за последние 90 дней (≤100 шт) +
// комментарии к ним, живой пересчёт subs_count/avg_views, один LLM-вызов на канал
// (completeObject, схема channelContextSchema) → JSON-профиль канала, сериализуется
// и пишется в channels.channel_context как текст. Общее ядро для
// обоих входов (периодическая задача диспетчера и ручной OpenClaw-тул) — вызывающий
// передаёт уже загруженный/подключённый `tg` для конкретного agentId, эта функция не
// управляет сессией (loadAccount/disconnect — забота вызывающего, design.md решение D7).
// Spec: openspec/changes/channel-context/.

import { z } from "zod";

import type { Logger } from "../../core/logger";
import type { LlmClient } from "../../llm/client";
import { analyzeChannelContext } from "../../llm/prompts";
import { TelegramService, computeAvgViews, type ChannelPost, type TgMessage } from "../../core/telegram/service";
import { FloodWaitError } from "../../core/telegram/errors";
import {
    initChannels,
    getChannelsForContextAnalysis,
    saveChannelContext,
    saveCoverage,
} from "../../core/db/channels";

/**
 * Схема JSON-профиля канала (analyzeChannelContext, v2) — валидирует структуру
 * ответа `llm.completeObject`. Ключи и допустимые значения строго повторяют
 * шаблон, заданный промптом (не выдумывать поля независимо от него — при
 * изменении промпта менять оба места синхронно).
 */
const channelContextSchema = z.object({
    позиционирование: z.string(),
    автор: z.object({
        роль: z.string(),
        отношение_с_аудиторией: z.string(),
    }),
    аудитория: z.object({
        тип_взаимодействия: z.string(),
        поведенческие_особенности: z.array(z.string()),
    }),
    коммуникационный_код: z.object({
        типичная_длина: z.string(),
        формальность: z.string(),
        фамильярность: z.string(),
        ирония: z.string(),
        резкость: z.string(),
        мат: z.string(),
        эмодзи: z.string(),
    }),
    отличительные_черты: z.array(z.string()),
    контентные_паттерны: z.array(
        z.object({
            тип: z.string(),
            типичная_реакция: z.string(),
        }),
    ),
    устойчивые_мотивы: z.array(
        z.object({
            мотив: z.string(),
            поддержка: z.enum(["сильная", "умеренная", "слабая"]),
        }),
    ),
    триггеры_вовлечения: z.array(z.string()),
    слабые_для_комментирования_посты: z.array(z.string()),
    контекст_для_будущих_постов: z.array(z.string()),
    изменения_во_времени: z.string().nullable(),
    качество_данных: z.enum(["высокое", "среднее", "низкое"]),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Пауза между MTProto-вызовами — тот же темп, что у channel-analysis/channel-niche.
const pacingMs = () => 800 + Math.random() * 400; // 0.8-1.2с
const MAX_CONSECUTIVE_FLOOD = 2; // 2 FLOOD_WAIT подряд → стоп текущего агента

const POST_WINDOW_DAYS = 90; // окно сбора постов для LLM-анализа
const MAX_POSTS = 100; // потолок числа постов (и запроса, и окна)
/** TTL анализа контекста канала — та же величина, что и окно сбора постов (design.md). */
const CONTEXT_TTL_SECONDS = POST_WINDOW_DAYS * 86400;

/** Внутренний сигнал «обработка агента остановлена по FLOOD_WAIT» — не покидает модуль. */
class FloodStop extends Error {}

/**
 * Вызов с учётом FLOOD_WAIT: ждём и повторяем; счётчик подряд идущих FLOOD_WAIT
 * сбрасывается успехом, на 2-м подряд — FloodStop. Локальный враппер, а не импорт
 * `withFloodRetry` из `skills/util.ts` — `core/` не зависит от `skills/`
 * (design.md решение D8), тот же приём, что уже в `channel-analysis/run.ts`.
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
                        log.warn(`[channel-context] ${agentId}: FLOOD_WAIT ${MAX_CONSECUTIVE_FLOOD} раза подряд — стоп агента`);
                        throw new FloodStop();
                    }
                    log.warn(`[channel-context] ${agentId}: FLOOD_WAIT ${err.waitSeconds}s — ждём и повторяем`);
                    await sleep(err.waitSeconds * 1000);
                    continue;
                }
                throw err;
            }
        }
    };
}

// ─── Типы ─────────────────────────────────────────────────────────────

export interface ChannelContextParams {
    agentId: string;
    /** Сколько каналов обработать за вызов (20 у периодической задачи, `count` у ручного тула). */
    limit: number;
    tg: TelegramService; // уже загружен/подключён на agentId вызывающим
    llm: LlmClient;
}

/** Запись о пропущенном канале для сводки прогона. */
export interface SkipNote {
    agent: string;
    channel?: string;
    reason: string;
}

export interface ChannelContextResult {
    channelsSelected: number;
    channelsAnalyzed: number; // успешно получили и сохранили channel_context
    skipped: SkipNote[];
}

// ─── Хелперы ──────────────────────────────────────────────────────────

/** Блок «пост + комментарии» для промпта — по одному блоку на пост, новые сверху (как отдаёт getRecentPosts). */
function formatPostsBlock(entries: { post: ChannelPost; comments: TgMessage[] }[]): string {
    if (entries.length === 0) return "";
    return entries
        .map(({ post, comments }, i) => {
            const text = post.text.trim() || "(без текста)";
            const commentsLines = comments.length > 0
                ? comments.map((c) => `  - ${c.fromName}: ${c.text}`).join("\n")
                : "  (комментариев нет)";
            return `Пост ${i + 1}:\n${text}\nКомментарии:\n${commentsLines}`;
        })
        .join("\n\n");
}

// ─── Прогон одного агента ───────────────────────────────────────────────

/**
 * Анализирует до `p.limit` отобранных каналов агента `p.agentId`. Никогда не
 * бросает наружу (кроме по-настоящему неожиданных ошибок программирования) —
 * сбой канала пропускается с причиной, FLOOD_WAIT останавливает только текущего
 * агента и тоже отражается как запись в `skipped`, не как исключение
 * (design.md решение D9 — оба входа получают единообразный результат).
 */
export async function runChannelContextForAgent(p: ChannelContextParams, log: Logger): Promise<ChannelContextResult> {
    const floodAware = makeFloodAware(p.agentId, log);
    const skipped: SkipNote[] = [];
    let channelsAnalyzed = 0;

    initChannels(p.agentId, log); // гарантировать схему/миграцию channels.db
    const candidates = getChannelsForContextAnalysis(p.agentId, log, p.limit, CONTEXT_TTL_SECONDS);
    log.info(`[channel-context] ${p.agentId}: отобрано ${candidates.length} каналов на анализ`);

    for (const c of candidates) {
        const label = c.channelUsername ? `@${c.channelUsername}` : c.title || "—";
        try {
            const handle = p.tg.buildChannelHandle(
                { channelId: c.channelId, accessHash: c.channelAccessHash, username: c.channelUsername },
                c.title,
            );

            const gate = await floodAware(() => p.tg.getChannelGateInfo(handle.inputChannel));
            await sleep(pacingMs());

            let pinnedText = "";
            if (gate.pinnedMsgId != null) {
                try {
                    pinnedText = (await floodAware(() => p.tg.getChannelMessageText(handle.inputChannel, gate.pinnedMsgId!))) ?? "";
                } catch (err) {
                    if (err instanceof FloodStop) throw err;
                    log.warn(`[channel-context] ${p.agentId}: не удалось получить закреп ${label}: ${(err as any)?.message ?? err}`);
                }
                await sleep(pacingMs());
            }

            // До 100 последних постов (потолок и запроса, и окна) — из них же
            // считается avg_views (формула ожидает посты от новых к старым, как
            // их и отдаёт getRecentPosts). Для LLM берётся только подмножество за
            // последние 90 дней — комментарии не собираются на посты старше окна.
            const posts = await floodAware(() => p.tg.getRecentPosts(handle.inputChannel, MAX_POSTS));
            await sleep(pacingMs());

            const cutoffSec = Math.floor(Date.now() / 1000) - POST_WINDOW_DAYS * 86400;
            const recentPosts = posts.filter((post) => post.date >= cutoffSec);

            const postsWithComments: { post: ChannelPost; comments: TgMessage[] }[] = [];
            for (const post of recentPosts) {
                try {
                    const { comments } = await floodAware(() => p.tg.getPostComments(handle.inputChannel, post.id));
                    postsWithComments.push({ post, comments });
                } catch (err) {
                    if (err instanceof FloodStop) throw err;
                    log.warn(`[channel-context] ${p.agentId}: не удалось получить комментарии поста ${post.id} канала ${label}: ${(err as any)?.message ?? err}`);
                    postsWithComments.push({ post, comments: [] });
                }
                await sleep(pacingMs());
            }

            // Подписчики/охват — живой пересчёт, общий кэш с channel-coverage-report
            // (design.md решение D3): сохраняются через saveCoverage независимо от
            // исхода LLM-анализа ниже, coverage_updated_at этой фичей не трогается.
            const subsCount = await floodAware(() => p.tg.getChannelSubsCount(handle.inputChannel));
            await sleep(pacingMs());
            const avgViews = computeAvgViews(posts);
            saveCoverage(p.agentId, c.chatId, avgViews, subsCount);

            try {
                const profile = await p.llm.completeObject(
                    { prompt: analyzeChannelContext(c.title, gate.about ?? "", pinnedText, formatPostsBlock(postsWithComments)) },
                    channelContextSchema,
                );
                saveChannelContext(p.agentId, c.chatId, JSON.stringify(profile), log);
                channelsAnalyzed += 1;
            } catch (err: any) {
                // Fail-soft для LLM (design.md, задача 2.3): channel_context/
                // channel_context_updated_at не трогаем — канал останется в отборе
                // на следующий прогон, subs_count/avg_views выше уже сохранены.
                skipped.push({ agent: p.agentId, channel: label, reason: `LLM: ${err?.message ?? err}` });
            }
        } catch (err: any) {
            if (err instanceof FloodStop) {
                skipped.push({ agent: p.agentId, reason: "прерван FLOOD_WAIT" });
                break;
            }
            skipped.push({ agent: p.agentId, channel: label, reason: err?.message ?? String(err) });
            log.warn(`[channel-context] ${p.agentId}: канал ${label} пропущен — ${err?.message ?? err}`);
        }
    }

    return { channelsSelected: candidates.length, channelsAnalyzed, skipped };
}

/** Короткое сообщение-статистика прогона (для ответа ручного тула оператору). */
export function renderChannelContextStats(results: ChannelContextResult[]): string {
    const channelsSelected = results.reduce((sum, r) => sum + r.channelsSelected, 0);
    const channelsAnalyzed = results.reduce((sum, r) => sum + r.channelsAnalyzed, 0);
    const skipped = results.flatMap((r) => r.skipped);

    const lines: string[] = [];
    lines.push("📋 Анализ контекста каналов");
    lines.push(`• каналов отобрано: ${channelsSelected}`);
    lines.push(`• проанализировано: ${channelsAnalyzed}`);
    if (skipped.length > 0) {
        lines.push(`• пропущено: ${skipped.length}`);
        for (const s of skipped.slice(0, 10)) {
            lines.push(`  ⚠️ ${s.agent}${s.channel ? ` / ${s.channel}` : ""}: ${s.reason}`);
        }
        if (skipped.length > 10) lines.push(`  …и ещё ${skipped.length - 10}`);
    }
    return lines.join("\n");
}
