// skills/monitor-v3.ts — runMonitorV3 (channel-post-watch).
//
// Гибридная (веб-превью + MTProto) проверка новых постов публичных каналов —
// поверх monitor-v2, не заменяя его. Каданс — раз в 5ч. Алгоритм и схема БД —
// openspec/changes/monitor-v3/design.md, docs/design/monitor-v3/design-v1.md
// (§0-§2) и algorithm-flow.puml. Везде, где шаг совпадает с monitor-v2
// (проверка удалённых сообщений, классификация ошибок отправки, ведение
// тредов), логика скопирована и адаптирована оттуда напрямую (design.md,
// решение 7) — не вынесена в общий модуль, тот же прецедент, каким
// monitor-v2 разошёлся с monitor.ts.

import { z } from "zod";

import type { SkillContext, SkillStatus } from "./types";
import { sleep, FloodAbortError, withFloodRetry } from "./util";
import { ClientNotConnectedError, FloodWaitError } from "../core/telegram/errors";
import {
    initChannels,
    syncChannels,
    getPostWatchChannels,
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
import { fetchLatestChannelPost } from "../features/channel-preview/preview";
import { applyApprovedComment, handlePostCommentSendError } from "../core/post-comment-send";
import { insertPendingReview } from "../core/db/pending-reviews";
import { sendReviewMessage } from "../core/review-bot-api";
import {
    MESSAGE_DELETION_CHECK_WINDOW_SECONDS,
    MESSAGE_DELETION_THRESHOLD,
    CHANNEL_SUSPEND_DURATION_SECONDS,
    POST_FRESHNESS_FIRST_COMMENT_MAX_AGE_SECONDS,
    CHANNEL_POST_WATCH_ONLY_COMMENT_SECONDS,
    CHANNEL_POST_WATCH_SLEEP_SECONDS,
    isReviewGateEnabled,
} from "../core/config";
import { generatePostCommentV3, generateThreadContinuation } from "../llm/prompts";

/**
 * Сигнал «пропустить текущий канал и продолжить прогон» — тот же приём, что
 * в monitor-v2.ts: бросается обёрткой sendReply при не-flood ошибке отправки,
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
 * что в monitor-v2.ts. Побочные эффекты (agent_restrictions/error_log) уже
 * выполнены в месте броска.
 */
class PeerFloodError extends Error {
    constructor() {
        super("PEER_FLOOD — aborting run");
        this.name = "PeerFloodError";
    }
}

const GET_MESSAGES_LIMIT = 1000;
const PREFILTER_MIN_LEN = 15; // короче — заведомо непроходное

/**
 * Текст сообщения ревью в чат ревьюеров — пост, тип поста (generatePostCommentV3),
 * комментарий, agentId/канал (post-comment-review spec, «Agent queues a
 * candidate comment for human review»). Транспорт (review-bot-api.ts) про
 * формат не знает.
 */
function formatReviewRequest(
    agentId: string,
    channelTitle: string,
    postText: string,
    type: string,
    comment: string,
): string {
    return [
        `Агент: ${agentId}`,
        `Канал: ${channelTitle}`,
        "",
        "Пост:",
        postText,
        "",
        `Тип (LLM): ${type}`,
        "",
        "Комментарий:",
        comment,
    ].join("\n");
}

/** Тот же эвристический префильтр, что passesPrefilter в monitor-v2.ts — применён к тексту поста. */
function passesPrefilter(text: string): boolean {
    const t = text.trim();
    if (t.length < PREFILTER_MIN_LEN) return false;
    if (!/\p{L}/u.test(t)) return false;
    return true;
}

export async function runMonitorV3(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, persona, tg, llm, log } = ctx;

    // §0.1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // §0.2 — Инициализация + синхронизация каналов (полный список диалогов) — тот же подход, что в monitor-v2.
    initChannels(agentId, log);
    const channelsMap = await tg.listGroupChannels();
    syncChannels(agentId, channelsMap, log);

    // §0.3 — Резолв идентичности привязанного канала для новых/непрорезолвленных чатов, инкрементально.
    try {
        await cacheChannelIdentities(agentId, tg, log);
    } catch (err: any) {
        if (err instanceof ClientNotConnectedError) throw err;
        log.warn(`[monitor-v3] шаг кэширования идентичности каналов пропущен: ${err?.message ?? err}`);
    }

    // §0.4 — Снять просроченные приостановки banned/suspend/format_error/sleep.
    // only_comment сюда не входит — переход в sleep делает сам monitor-v3 (§2a).
    expireChannelStatuses(agentId, log);

    // §0.5 — Выбрать активные каналы с публичным username (фильтр на уровне запроса).
    const channels = getPostWatchChannels(agentId, log);
    if (channels.length === 0) {
        return { status: "success", details: { reason: "no_active_channels_with_username" } };
    }

    // §0.6 — Заполнить peerCache для всей выборки одним проходом по диалогам.
    // Без этого markAsRead/replyToMessage падают с "No InputPeer cached" —
    // §0.2 (listGroupChannels) его не заполняет (использует client.getDialogs
    // напрямую, в обход того же кода, что заполняет кэш). Без потолка страниц
    // (в отличие от getDialogsForBatch, рассчитанного на батч из 40 у
    // monitor-v2) — нужен весь список активных каналов агента, который может
    // быть заметно больше; тот же метод, что использует channel-cleanup для
    // сопоставимой по числу каналов задачи.
    try {
        await withFloodRetry(() => tg.populatePeerCacheForIds(channels.map((c) => c.chatId)), log);
    } catch (err: any) {
        if (err instanceof FloodAbortError) {
            return { status: "error", details: { step: "populate_peer_cache", reason: "repeated_flood_wait" } };
        }
        if (err instanceof ClientNotConnectedError) throw err;
        log.warn(`[monitor-v3] populatePeerCacheForIds failed: ${err?.message ?? err}`);
    }

    // §0.6b — Персистить accessHash чата обсуждения, где peerCache его узнал
    // (post-comment-review, design.md решение 5) — без этого review-listener
    // не может собрать InputPeer на свежем соединении без похода в getDialogs.
    for (const channel of channels) {
        const accessHash = tg.getCachedChatAccessHash(channel.chatId);
        if (accessHash) saveChatAccessHash(agentId, channel.chatId, accessHash, log);
    }

    let channelsProcessed = 0;
    let channelsSkippedErrors = 0;
    let freshPostsFound = 0;
    let commentsPosted = 0;
    let onlyCommentTransitionedToSleep = 0;
    let threadRepliesSent = 0;

    // Отправка с обработкой FLOOD_WAIT/классификацией ошибок — скопировано и
    // адаптировано из monitor-v2.ts sendReply (design.md, решение 7).
    const sendReplyRaw = (chatId: string, replyToMessageId: number, text: string) =>
        withFloodRetry(() => tg.replyToMessage(chatId, replyToMessageId, text), log);

    const sendReply = async (chatId: string, replyToMessageId: number, text: string) => {
        try {
            return await sendReplyRaw(chatId, replyToMessageId, text);
        } catch (err: any) {
            if (err instanceof FloodAbortError) throw err;
            if (err instanceof ClientNotConnectedError) throw err;
            const tag = handlePostCommentSendError(agentId, chatId, err, log, "monitor_v3");
            if (tag === "peer_flood") throw new PeerFloodError();
            throw new ChannelSkipError();
        }
    };

    for (const channel of channels) {
        const { chatId } = channel;

        // §1 — Проверка удалённых сообщений агента (channel-suspend-on-deletion) —
        // скопировано и адаптировано из monitor-v2.ts (source: "monitor_v3").
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
                    recordSendError(agentId, { chatId, source: "monitor_v3", errorCode: "messages_deleted" }, log);
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
                log.warn(`[monitor-v3] deletion check failed for chatId=${chatId}: ${err.message ?? err}`);
            }
        }

        // §2a — status = only_comment
        if (channel.status === "only_comment") {
            const watchStartedAt = channel.statusUpdatedAt ?? 0;
            const now = Math.floor(Date.now() / 1000);

            if (now - watchStartedAt >= CHANNEL_POST_WATCH_ONLY_COMMENT_SECONDS) {
                // §2a.a — истёк срок слежения за комментариями → sleep, дальше в этом
                // прогоне для канала ничего не делаем.
                markChannelStatus(agentId, chatId, "sleep", log, CHANNEL_POST_WATCH_SLEEP_SECONDS);
                onlyCommentTransitionedToSleep += 1;
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            if (channel.channelId === null || channel.channelAccessHash === null || channel.lastSeenChannelPostId === null) {
                // Нечем проверять (данные не резолвлены/не заполнены) — пропустить канал.
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
                log.warn(`[monitor-v3] get_discussion_message failed for chatId=${chatId}: ${err.message ?? err}`);
                discussionCheckOk = false;
            }

            if (!discussionCheckOk || channel.watchedThreadRootMsgId === null) {
                // Проверка не удалась, либо нечем проверять — канал не считается
                // проверенным, визит в channel_visits не пишется.
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            // Проверка прошла успешно: нет новых сообщений в отслеживаемой ветке — "empty".
            if (!discussionCheck || discussionCheck.unreadCount === 0) {
                recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                await sleep(1000);
                continue;
            }

            // Есть новые сообщения в ветке — "active" фиксируется сразу по факту
            // успешной проверки, независимо от исхода дальнейшей обработки ниже.
            recordChannelVisit(agentId, { chatId, outcome: "active", messagesCount: 0 }, log);

            // §2a.d — есть новые сообщения: забрать всё после корня ветки, классифицировать.
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
                log.warn(`[monitor-v3] get_messages failed for chatId=${chatId}: ${err.message ?? err}`);
                recordSendError(agentId, { chatId, source: "monitor_v3", errorCode: "get_messages_error" }, log);
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
                log.warn(`[monitor-v3] mark_as_read failed for chatId=${chatId}: ${err.message ?? err}`);
            }

            const classified = classifyMessages(agentId, chatId, messages, log);
            // Отслеживаемая ветка среди threadReplies — та, чей корень совпадает с
            // watchedThreadRootMsgId (createGroupThread кладёт его первым сообщением,
            // роль "user"); другие треды в этом же чате (если есть) — не в скоупе.
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
                    log.warn(`[monitor-v3] saveReply failed: ${saveErr.message ?? saveErr}`);
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
                if (err instanceof ChannelSkipError) {
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

        // §2b — status = NULL / format_error ("Открыт")
        if (channel.channelUsername === null) {
            // Не должно случиться (выборка §0.5 уже фильтрует по channelUsername),
            // но без публичного username проверять нечего — пропустить.
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        const preview = await fetchLatestChannelPost(channel.channelUsername, log);
        if (!preview.ok) {
            // Проверка не удалась (сеть/парсинг) — канал не считается проверенным,
            // визит в channel_visits не пишется.
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        if (!preview.post) {
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }
        const latestPost = preview.post;

        // §2b.ii — тот же пост, что уже обработан (защита от повторной реакции).
        if (latestPost.id === channel.lastSeenChannelPostId) {
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        // §2b.iii — R1, freshness-gate: пост не свежий.
        const ageSeconds = Math.floor(Date.now() / 1000) - latestPost.date;
        if (ageSeconds >= POST_FRESHNESS_FIRST_COMMENT_MAX_AGE_SECONDS) {
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }
        freshPostsFound += 1;
        // Пост новый и свежий — "active" фиксируется сразу по факту успешной
        // проверки, независимо от исхода дальнейшего отсева/решения LLM/отправки.
        recordChannelVisit(agentId, { chatId, outcome: "active", messagesCount: 1 }, log);

        // §2b.iv — отсев + LLM-решение
        if (!passesPrefilter(latestPost.text)) {
            markPostSeen(agentId, chatId, latestPost.id, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        const decision = await llm.completeObject(
            { system: persona, prompt: generatePostCommentV3(latestPost.text) },
            z.object({
                тип: z.enum(["история", "мнение", "новость", "нет"]),
                комментарий: z.string().nullable(),
            }),
        );

        if (decision.тип === "нет" || !decision.комментарий) {
            markPostSeen(agentId, chatId, latestPost.id, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        if (channel.channelId === null || channel.channelAccessHash === null) {
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        // §2b.v — найти служебную копию поста в чате обсуждения
        const channelHandle = tg.buildChannelHandle(
            { channelId: channel.channelId, accessHash: channel.channelAccessHash, username: channel.channelUsername },
            channel.title,
        );

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
            log.warn(`[monitor-v3] get_discussion_message failed for chatId=${chatId}: ${err.message ?? err}`);
            discussion = null;
        }

        if (!discussion) {
            recordSendError(agentId, { chatId, source: "monitor_v3", errorCode: "discussion_message_not_found" }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            channelsSkippedErrors += 1;
            await sleep(1000);
            continue;
        }

        // §2b.vi-review — review-gate включён: не отправлять сразу, поставить
        // на подтверждение человеком (post-comment-review). Не блокирует
        // прогон — канал сразу помечается обработанным, monitor-v3 идёт
        // дальше (design.md решение 1).
        if (isReviewGateEnabled(agentId)) {
            const reviewId = insertPendingReview(
                agentId,
                {
                    chatId,
                    postId: latestPost.id,
                    postText: latestPost.text,
                    llmType: decision.тип,
                    comment: decision.комментарий,
                    rootMsgId: discussion.rootMsgId,
                },
                log,
            );
            try {
                await sendReviewMessage(
                    agentId,
                    reviewId,
                    formatReviewRequest(agentId, channel.title, latestPost.text, decision.тип, decision.комментарий),
                    log,
                );
            } catch (err: any) {
                log.warn(`[monitor-v3] sendReviewMessage failed for chatId=${chatId}, reviewId=${reviewId}: ${err?.message ?? err}`);
            }
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        try {
            const sent = await sendReply(chatId, discussion.rootMsgId, decision.комментарий);
            commentsPosted += 1;

            // §2b.vii — успех: пост-отправочная обвязка (тред, id/статус,
            // saveReply) — общая с review-listener (design.md решение 7),
            // визит уже зафиксирован выше, в момент обнаружения свежего поста.
            applyApprovedComment(
                agentId,
                chatId,
                { postId: latestPost.id, postText: latestPost.text, comment: decision.комментарий, rootMsgId: discussion.rootMsgId, sentMessageId: sent.messageId, channelUsername: channelsMap.get(chatId)?.username ?? null },
                log,
                "monitor_v3",
            );
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { step: "reply", reason: "repeated_flood_wait", chatId, commentsPosted } };
            }
            if (err instanceof PeerFloodError) {
                return { status: "error", details: { step: "reply", reason: "peer_flood", chatId, commentsPosted } };
            }
            if (err instanceof ChannelSkipError) {
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
            "каналов обработано": channelsProcessed,
            "каналов пропущено (ошибки)": channelsSkippedErrors,
            "свежих постов найдено": freshPostsFound,
            "комментариев отправлено": commentsPosted,
            "only_comment → sleep переходов": onlyCommentTransitionedToSleep,
            "ответов на комментарии отправлено": threadRepliesSent,
        },
    };
}
