// skills/monitor-v4.ts — runMonitorV4 (channel-post-watch-v4).
//
// Копия-адаптация monitor-v3.ts (тот же приём, что уже развёл monitor-v3 с
// monitor-v2, см. шапку monitor-v3.ts) — §0 подготовка, §1 проверка удалённых
// сообщений, §2a (`only_comment`), классификация ошибок отправки скопированы
// без изменений. Меняется только §2b («Открыт»): вместо правила свежести
// («последний пост, если < 24ч от текущего момента», monitor-v3) —
// фиксированное, уже закрытое календарное окно [сегодня−2 суток,
// сегодня−1 суток) по Asia/Yekaterinburg — «последний пост позавчера».
// Алгоритм и обоснование — openspec/changes/monitor-v4/design.md.

import { z } from "zod";

import type { SkillContext, SkillStatus } from "./types";
import { LlmCallError } from "../llm/error-class";
import { sleep, FloodAbortError, withFloodRetry } from "./util";
import { ClientNotConnectedError, FloodWaitError } from "../core/telegram/errors";
import {
    initChannels,
    syncChannels,
    getPostWatchChannels,
    saveTargetDayCache,
    markPostSeen,
    markChannelStatus,
    expireChannelStatuses,
    markChannelProcessed,
    classifyMessages,
    updateGroupThread,
    recordChannelVisit,
    recordSendError,
    saveChatAccessHash,
    type PostWatchChannelRow,
} from "../core/db/channels";
import { getAgentSentMessageIds, saveReply } from "../core/db/replies";
import { cacheChannelIdentities } from "../core/channel-sync";
import { fetchLastPostInDateRange } from "../features/channel-preview/preview";
import { applyApprovedComment, handlePostCommentSendError } from "../core/post-comment-send";
import { sendNotifyMessage } from "../core/review-bot-api";
import {
    MESSAGE_DELETION_CHECK_WINDOW_SECONDS,
    MESSAGE_DELETION_THRESHOLD,
    CHANNEL_SUSPEND_DURATION_SECONDS,
    CHANNEL_POST_WATCH_ONLY_COMMENT_SECONDS,
    CHANNEL_POST_WATCH_SLEEP_SECONDS,
    MONITOR_V4_TARGET_DAY_TZ,
    isReviewGateEnabled,
} from "../core/config";
import { generatePostCommentV5, generateThreadContinuation } from "../llm/prompts";

/**
 * Сигнал «пропустить текущий канал и продолжить прогон» — тот же приём, что
 * в monitor-v3.ts: бросается обёрткой sendReply при не-flood ошибке отправки,
 * внешний catch пропускает канал, прогон продолжается.
 */
class ChannelSkipError extends Error {
    constructor() {
        super("Channel skipped after send error");
        this.name = "ChannelSkipError";
    }
}

/**
 * Сигнал «остановить весь прогон немедленно» при PEER_FLOOD — тот же приём,
 * что в monitor-v3.ts. Побочные эффекты (agent_restrictions/error_log) уже
 * выполнены в месте броска.
 */
class PeerFloodError extends Error {
    constructor() {
        super("PEER_FLOOD — aborting run");
        this.name = "PeerFloodError";
    }
}

const GET_MESSAGES_LIMIT = 1000;
/**
 * Минимальное число комментариев поста, при котором он вообще рассматривается
 * (monitor-v4-comment-signal, design.md Decision 1) — гейт до LLM, заменяет
 * прежний текстовый `passesPrefilter` (monitor-v3/исходная версия monitor-v4).
 */
const MIN_COMMENTS_TO_CONSIDER = 3;

/**
 * Текст постфактум-уведомления в чат ревьюеров об уже отправленном
 * комментарии (автоотправка без апрува) — поля соответствуют схеме
 * `generatePostCommentV5` (ценность_комментария/главное мнение), не прежней `тип`.
 * Описание канала в уведомление намеренно не выводится.
 */
function formatSentNotification(
    agentId: string,
    channelTitle: string,
    postText: string,
    score: number,
    mainOpinion: string,
    comment: string,
): string {
    return [
        `Агент: ${agentId}`,
        `Канал: ${channelTitle}`,
        "",
        "Пост:",
        postText,
        "",
        `Оценка сигнала (LLM): ${score}/4`,
        `Главное мнение: ${mainOpinion}`,
        "",
        "Комментарий:",
        comment,
    ].join("\n");
}

/** "YYYY-MM-DD" календарной даты `date` по таймзоне `tz`. */
function calendarDateKey(date: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Смещение таймзоны `tz` в момент `date`, в миллисекундах восточнее UTC. */
function tzOffsetMs(date: Date, tz: string): number {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        })
            .formatToParts(date)
            .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour) % 24,
        Number(parts.minute),
        Number(parts.second),
    );
    return asUtc - date.getTime();
}

/** Unix-секунды местной полуночи (00:00:00) календарной даты `dateKey` в `tz`. */
function zonedMidnightSec(dateKey: string, tz: string): number {
    const [y, m, d] = dateKey.split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    const offset = tzOffsetMs(new Date(guess), tz);
    return Math.floor((guess - offset) / 1000);
}

/** Сдвигает "YYYY-MM-DD" на `days` календарных дней (арифметика по Y/M/D, без tz). */
function shiftDateKey(dateKey: string, days: number): string {
    const [y, m, d] = dateKey.split("-").map(Number);
    const shifted = new Date(Date.UTC(y, m - 1, d + days));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * Границы целевого дня — "сегодня минус 2 суток" по календарю `tz` (design.md,
 * решение 1): `[startSec, endSec)` в unix-секундах и строка даты для кэша.
 */
function computeTargetDayWindow(now: Date, tz: string): { startSec: number; endSec: number; dateKey: string } {
    const todayKey = calendarDateKey(now, tz);
    const dateKey = shiftDateKey(todayKey, -2);
    const startSec = zonedMidnightSec(dateKey, tz);
    const endSec = zonedMidnightSec(shiftDateKey(dateKey, 1), tz);
    return { startSec, endSec, dateKey };
}

export async function runMonitorV4(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, persona, tg, llm, log } = ctx;

    // §0.1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // §0.2 — Инициализация + синхронизация каналов (полный список диалогов) — тот же подход, что в monitor-v3.
    initChannels(agentId, log);
    const channelsMap = await tg.listGroupChannels();
    syncChannels(agentId, channelsMap, log);

    // §0.3 — Резолв идентичности привязанного канала для новых/непрорезолвленных чатов, инкрементально.
    try {
        await cacheChannelIdentities(agentId, tg, log);
    } catch (err: any) {
        if (err instanceof ClientNotConnectedError) throw err;
        log.warn(`[monitor-v4] шаг кэширования идентичности каналов пропущен: ${err?.message ?? err}`);
    }

    // §0.4 — Снять просроченные приостановки banned/suspend/format_error/sleep.
    // only_comment сюда не входит — переход в sleep делает сам monitor-v4 (§2a).
    expireChannelStatuses(agentId, log);

    // §0.5 — Выбрать активные каналы с публичным username (фильтр на уровне запроса).
    // Та же выборка, что monitor-v3 (getPostWatchChannels) — общее поле status
    // на канал (design.md, решение 4).
    const channels = getPostWatchChannels(agentId, log);
    if (channels.length === 0) {
        return { status: "success", details: { reason: "no_active_channels_with_username" } };
    }

    // §0.6 — Заполнить peerCache для всей выборки одним проходом по диалогам.
    try {
        await withFloodRetry(() => tg.populatePeerCacheForIds(channels.map((c) => c.chatId)), log);
    } catch (err: any) {
        if (err instanceof FloodAbortError) {
            return { status: "error", details: { step: "populate_peer_cache", reason: "repeated_flood_wait" } };
        }
        if (err instanceof ClientNotConnectedError) throw err;
        log.warn(`[monitor-v4] populatePeerCacheForIds failed: ${err?.message ?? err}`);
    }

    // §0.6b — Персистить accessHash чата обсуждения, где peerCache его узнал.
    for (const channel of channels) {
        const accessHash = tg.getCachedChatAccessHash(channel.chatId);
        if (accessHash) saveChatAccessHash(agentId, channel.chatId, accessHash, log);
    }

    const targetDayWindow = computeTargetDayWindow(new Date(), MONITOR_V4_TARGET_DAY_TZ);

    let channelsProcessed = 0;
    let channelsSkippedErrors = 0;
    let dayPostsFound = 0;
    let commentsPosted = 0;
    let onlyCommentTransitionedToSleep = 0;
    let threadRepliesSent = 0;
    let dayResolvedFromCache = 0;
    let dayResolvedFromNetwork = 0;

    // Отправка с обработкой FLOOD_WAIT/классификацией ошибок — скопировано из monitor-v3.ts.
    const sendReplyRaw = (chatId: string, replyToMessageId: number, text: string) =>
        withFloodRetry(() => tg.replyToMessage(chatId, replyToMessageId, text), log);

    const sendReply = async (chatId: string, replyToMessageId: number, text: string) => {
        let sent;
        try {
            sent = await sendReplyRaw(chatId, replyToMessageId, text);
        } catch (err: any) {
            if (err instanceof FloodAbortError) throw err;
            if (err instanceof ClientNotConnectedError) throw err;
            const tag = handlePostCommentSendError(agentId, chatId, err, log, "monitor_v4");
            if (tag === "peer_flood") throw new PeerFloodError();
            throw new ChannelSkipError();
        }
        // read_inbox_max_id не продвигается по своим сообщениям — без явного
        // markAsRead курсор чтения остаётся позади собственного ответа, и в
        // следующем прогоне getMessages() снова вернёт его в диапазоне "новых"
        // (уже отфильтруется по m.out, но лишний вызов GetHistory ни к чему,
        // telegram-self-reply-fix). Некритично — если не удалось, просто лог.
        try {
            await tg.markAsRead(chatId, sent.messageId);
        } catch (err: any) {
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[monitor-v4] markAsRead(own reply) failed for chatId=${chatId}: ${err.message ?? err}`);
        }
        return sent;
    };

    for (const channel of channels) {
        const { chatId } = channel;

        // §1 — Проверка удалённых сообщений агента (channel-suspend-on-deletion) —
        // скопировано из monitor-v3.ts (source: "monitor_v4").
        const deletionCheckSentIds = getAgentSentMessageIds(
            agentId,
            chatId,
            Math.floor(Date.now() / 1000) - MESSAGE_DELETION_CHECK_WINDOW_SECONDS,
        );
        if (deletionCheckSentIds.length > 0) {
            try {
                const existingIds = await withFloodRetry(() => tg.getMessagesExistence(chatId, deletionCheckSentIds), log);
                const deletedCount = deletionCheckSentIds.length - existingIds.size;
                if (deletedCount > MESSAGE_DELETION_THRESHOLD) {
                    const description = `messages_deleted: ${deletedCount} за ${Math.floor(MESSAGE_DELETION_CHECK_WINDOW_SECONDS / 86400)} дней`;
                    markChannelStatus(agentId, chatId, "suspend", log, CHANNEL_SUSPEND_DURATION_SECONDS, description);
                    recordSendError(agentId, { chatId, source: "monitor_v4", errorCode: "messages_deleted" }, log);
                    markChannelProcessed(agentId, chatId, log);
                    channelsProcessed += 1;
                    await sleep(1000);
                    continue;
                }
            } catch (err: any) {
                if (err instanceof FloodAbortError) {
                    return { status: "error", details: { step: "get_messages_existence", reason: "repeated_flood_wait", chatId } };
                }
                if (err instanceof ClientNotConnectedError) throw err;
                log.warn(`[monitor-v4] deletion check failed for chatId=${chatId}: ${err.message ?? err}`);
            }
        }

        // §2a — status = only_comment (не меняется относительно monitor-v3).
        if (channel.status === "only_comment") {
            const watchStartedAt = channel.statusUpdatedAt ?? 0;
            const now = Math.floor(Date.now() / 1000);

            if (now - watchStartedAt >= CHANNEL_POST_WATCH_ONLY_COMMENT_SECONDS) {
                markChannelStatus(agentId, chatId, "sleep", log, CHANNEL_POST_WATCH_SLEEP_SECONDS);
                onlyCommentTransitionedToSleep += 1;
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            if (channel.channelId === null || channel.channelAccessHash === null || channel.lastSeenChannelPostId === null) {
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            const channelHandle = tg.buildChannelHandle(
                { channelId: channel.channelId, accessHash: channel.channelAccessHash, username: channel.channelUsername },
                channel.title,
            );

            let discussionCheck: { unreadCount: number } | null = null;
            let discussionCheckOk = true;
            try {
                discussionCheck = await withFloodRetry(
                    () => tg.getDiscussionMessage(channelHandle.inputChannel, channel.lastSeenChannelPostId!),
                    log,
                );
            } catch (err: any) {
                if (err instanceof FloodAbortError) {
                    return { status: "error", details: { step: "get_discussion_message", reason: "repeated_flood_wait", chatId } };
                }
                if (err instanceof ClientNotConnectedError) throw err;
                log.warn(`[monitor-v4] get_discussion_message failed for chatId=${chatId}: ${err.message ?? err}`);
                discussionCheckOk = false;
            }

            if (!discussionCheckOk || channel.watchedThreadRootMsgId === null) {
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            if (!discussionCheck || discussionCheck.unreadCount === 0) {
                recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            recordChannelVisit(agentId, { chatId, outcome: "active", messagesCount: 0 }, log);

            let messages;
            try {
                const res = await withFloodRetry(
                    () => tg.getMessages(chatId, channel.watchedThreadRootMsgId!, GET_MESSAGES_LIMIT),
                    log,
                );
                messages = res.messages;
            } catch (err: any) {
                if (err instanceof FloodAbortError) {
                    return { status: "error", details: { step: "get_messages", reason: "repeated_flood_wait", chatId } };
                }
                if (err instanceof ClientNotConnectedError) throw err;
                log.warn(`[monitor-v4] get_messages failed for chatId=${chatId}: ${err.message ?? err}`);
                recordSendError(agentId, { chatId, source: "monitor_v4", errorCode: "get_messages_error" }, log);
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                channelsSkippedErrors += 1;
                await sleep(1000);
                continue;
            }

            if (messages.length === 0) {
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            const maxId = Math.max(...messages.map((m) => m.id));
            try {
                await tg.markAsRead(chatId, maxId);
            } catch (err: any) {
                if (err instanceof ClientNotConnectedError) throw err;
                log.warn(`[monitor-v4] mark_as_read failed for chatId=${chatId}: ${err.message ?? err}`);
            }

            const classified = classifyMessages(agentId, chatId, messages, log);
            const myEntry = classified.threadReplies.find(
                (e) => e.threadMessages[0]?.msgId === channel.watchedThreadRootMsgId,
            );

            if (!myEntry || myEntry.newMessages.length === 0) {
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            try {
                const historyLines = myEntry.threadMessages
                    .map((m) => (m.role === "agent" ? `- Ты: ${m.text}` : `- ${m.fromName ?? "Пользователь"}: ${m.text}`))
                    .join("\n");
                const newLines = myEntry.newMessages.map((m) => `- ${m.fromName}: ${m.text}`).join("\n");
                const prompt = generateThreadContinuation(historyLines, newLines);
                const replyText = await llm.complete({ system: persona, prompt });

                const last = myEntry.newMessages[myEntry.newMessages.length - 1];
                const sent = await sendReply(chatId, last.id, replyText);
                threadRepliesSent += 1;

                try {
                    saveReply(agentId, { chatId, msgId: last.id, msgText: last.text, replyMsgId: sent.messageId, replyText, channelUsername: channelsMap.get(chatId)?.username ?? null });
                } catch (saveErr: any) {
                    log.warn(`[monitor-v4] saveReply failed: ${saveErr.message ?? saveErr}`);
                }

                const newMsgs = [
                    ...myEntry.newMessages.map((m) => ({ role: "user", msgId: m.id, fromName: m.fromName, fromId: m.fromId, text: m.text })),
                    { role: "agent", msgId: sent.messageId, text: replyText },
                ];
                updateGroupThread(agentId, myEntry.threadId, JSON.stringify(newMsgs), sent.messageId, log);
            } catch (err: any) {
                if (err instanceof FloodAbortError) {
                    return { status: "error", details: { step: "reply", reason: "repeated_flood_wait", chatId } };
                }
                if (err instanceof PeerFloodError) {
                    return { status: "error", details: { step: "reply", reason: "peer_flood", chatId } };
                }
                if (err instanceof ChannelSkipError || err instanceof LlmCallError) {
                    channelsSkippedErrors += 1;
                } else {
                    throw err;
                }
            }

            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        // §2b — status = NULL / format_error («Открыт») — обнаружение поста
        // фиксированного целевого дня (design.md, решения 1-3), вместо правила
        // свежести monitor-v3.
        if (channel.channelUsername === null) {
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        // resolveDay пишется ТОЛЬКО там, где lastSeenChannelPostId уже обновлён
        // (markPostSeen/applyApprovedComment) в этом же прогоне — так кэш дня
        // никогда не расходится с реальным исходом (design.md, решение 3).
        // Ветки, где lastSeenChannelPostId не трогается (не резолвлена
        // идентичность канала, служебная копия не найдена, отправка не удалась,
        // поставлено на ревью) — намеренно не кэшируются, тем же способом, каким
        // monitor-v3 в этих случаях тоже не вызывает markPostSeen: следующий
        // прогон повторит попытку с начала.
        const resolveDay = (postId: number | null) =>
            saveTargetDayCache(agentId, chatId, { dateKey: targetDayWindow.dateKey, postId }, log);

        // Кэш дня актуален для этого прогона — не обращаемся к веб-превью.
        if (channel.lastCheckedTargetDate === targetDayWindow.dateKey) {
            if (channel.lastCheckedTargetPostId === null) {
                // День резолвлен как пустой — не путать с ошибкой проверки.
                dayResolvedFromCache += 1;
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }
            if (channel.lastCheckedTargetPostId === channel.lastSeenChannelPostId) {
                // Уже полностью обработан (принят или отклонён) в этом же дне.
                dayResolvedFromCache += 1;
                recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }
            // Кэш указывает на пост, ещё не отражённый в lastSeenChannelPostId —
            // рассинхронизация (обрыв прогона между резолвом и обработкой поста
            // в прошлый раз). Самовосстановление: не доверяем кэшу, идём за
            // свежими данными по сети ниже, как при промахе кэша.
        }

        // Сетевой резолв (кэш не покрывает этот прогон — день сменился, кэша
        // ещё не было, либо обнаружена рассинхронизация выше).
        const preview = await fetchLastPostInDateRange(
            channel.channelUsername,
            targetDayWindow.startSec,
            targetDayWindow.endSec,
            log,
        );
        if (!preview.ok) {
            // Проверка не удалась — канал не считается проверенным, кэш не
            // трогаем (design.md, Risks — не путать «не удалось» с «пусто»).
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        if (!preview.post) {
            dayResolvedFromNetwork += 1;
            resolveDay(null);
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }
        const latestPost = preview.post;
        dayResolvedFromNetwork += 1;

        if (latestPost.id === channel.lastSeenChannelPostId) {
            resolveDay(latestPost.id);
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        dayPostsFound += 1;
        recordChannelVisit(agentId, { chatId, outcome: "active", messagesCount: 1 }, log);

        if (channel.channelId === null || channel.channelAccessHash === null) {
            // Идентичность канала не резолвлена — нечем ни проверить комментарии
            // (getPostComments), ни (при положительном решении) найти rootMsgId
            // для ответа. Не кэшируем (см. комментарий выше resolveDay) —
            // следующий прогон попробует снова, когда идентичность резолвится
            // (§0.3 cacheChannelIdentities).
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        const channelHandle = tg.buildChannelHandle(
            { channelId: channel.channelId, accessHash: channel.channelAccessHash, username: channel.channelUsername },
            channel.title,
        );

        // §2b.iv — гейт по числу комментариев ДО обращения к LLM
        // (monitor-v4-comment-signal, design.md Decision 1) — заменяет прежний
        // текстовый passesPrefilter(post.text).
        let postComments;
        try {
            postComments = await withFloodRetry(
                () => tg.getPostComments(channelHandle.inputChannel, latestPost.id),
                log,
            );
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { step: "get_post_comments", reason: "repeated_flood_wait", chatId } };
            }
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[monitor-v4] getPostComments failed for chatId=${chatId}: ${err.message ?? err}`);
            // Проверка не удалась (не «мало комментариев») — не кэшируем, тем же
            // принципом, что и отказ fetchLastPostInDateRange выше.
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        if (postComments.total < MIN_COMMENTS_TO_CONSIDER) {
            markPostSeen(agentId, chatId, latestPost.id, log);
            resolveDay(latestPost.id);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        // Решение строится на тексте поста И на всех его комментариях
        // (monitor-v4-comment-signal, design.md Decision 3-4) — не только на
        // тексте поста, как в monitor-v3/исходной версии monitor-v4. Персона
        // (system, SOUL.md) снова передаётся — задаёт голос итогового
        // комментария (лексика/тон/уместная резкость персонажа), поверх отбора
        // сигнала из generatePostCommentV5 (тот сам решает, стоит ли вообще
        // писать, и на основе чего). Описание канала (channel_context,
        // пишется отдельной фоновой задачей channel-context) — опциональный
        // контекст, берётся, только если поле не NULL и не пустое; локальный
        // сигнал (пост+комменты) приоритетнее.
        const commentsText = postComments.comments.map((c) => `- ${c.fromName}: ${c.text}`).join("\n");
        const channelContext = channel.channel_context?.trim() ? channel.channel_context : "";
        const decision = await llm.completeObject(
            { system: persona, prompt: generatePostCommentV5(latestPost.text, commentsText, channelContext) },
            z.object({
                ценность_комментария: z.number().min(0).max(4),
                решение: z.enum(["пропустить", "комментировать"]),
                главное_мнение: z.string().nullable(),
                комментарий: z.string().nullable(),
            }),
        );

        if (decision.решение === "пропустить" || !decision.комментарий) {
            markPostSeen(agentId, chatId, latestPost.id, log);
            resolveDay(latestPost.id);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        // §2b.v — найти служебную копию поста в чате обсуждения (rootMsgId для ответа).
        let discussion;
        try {
            discussion = await withFloodRetry(
                () => tg.getDiscussionMessage(channelHandle.inputChannel, latestPost.id),
                log,
            );
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { step: "get_discussion_message", reason: "repeated_flood_wait", chatId } };
            }
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[monitor-v4] get_discussion_message failed for chatId=${chatId}: ${err.message ?? err}`);
            discussion = null;
        }

        if (!discussion) {
            recordSendError(agentId, { chatId, source: "monitor_v4", errorCode: "discussion_message_not_found" }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            channelsSkippedErrors += 1;
            await sleep(1000);
            continue;
        }

        // Ревью-гейт (post-comment-review) больше не блокирует отправку —
        // комментарий уходит сразу, без ожидания решения человека. Флаг
        // `reviewGateEnabled` сохраняет прежний смысл «нужна видимость в чате
        // ревьюеров», но теперь это постфактум-уведомление (без кнопок,
        // formatSentNotification строит тот же набор полей, что раньше уходил
        // в запрос на ревью), не блокирующий запрос. `insertPendingReview`/
        // `sendReviewMessage` (ожидание «Да»/«Нет») здесь больше не используются.
        try {
            const sent = await sendReply(chatId, discussion.rootMsgId, decision.комментарий);
            commentsPosted += 1;

            applyApprovedComment(
                agentId,
                chatId,
                { postId: latestPost.id, postText: latestPost.text, comment: decision.комментарий, rootMsgId: discussion.rootMsgId, sentMessageId: sent.messageId },
                log,
                "monitor_v4",
            );
            resolveDay(latestPost.id);

            if (isReviewGateEnabled(agentId)) {
                try {
                    await sendNotifyMessage(
                        formatSentNotification(agentId, channel.title, latestPost.text, decision.ценность_комментария, decision.главное_мнение ?? "", decision.комментарий),
                        log,
                    );
                } catch (notifyErr: any) {
                    log.warn(`[monitor-v4] sendNotifyMessage failed for chatId=${chatId}: ${notifyErr?.message ?? notifyErr}`);
                }
            }
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { step: "reply", reason: "repeated_flood_wait", chatId, commentsPosted } };
            }
            if (err instanceof PeerFloodError) {
                return { status: "error", details: { step: "reply", reason: "peer_flood", chatId, commentsPosted } };
            }
            if (err instanceof ChannelSkipError || err instanceof LlmCallError) {
                channelsSkippedErrors += 1;
            } else {
                throw err;
            }
        }

        markChannelProcessed(agentId, chatId, log);
        channelsProcessed += 1;
        await sleep(1000);
    }

    return {
        status: "success",
        details: {
            "целевой день": targetDayWindow.dateKey,
            "каналов обработано": channelsProcessed,
            "каналов пропущено (ошибки)": channelsSkippedErrors,
            "постов дня найдено": dayPostsFound,
            "комментариев отправлено": commentsPosted,
            "only_comment → sleep переходов": onlyCommentTransitionedToSleep,
            "ответов на комментарии отправлено": threadRepliesSent,
            "резолв дня из кэша": dayResolvedFromCache,
            "резолв дня по сети": dayResolvedFromNetwork,
        },
    };
}
