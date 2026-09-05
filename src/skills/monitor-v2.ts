// skills/monitor-v2.ts — runMonitorV2 (post-freshness-gate).
//
// Вторая, независимая версия мониторинга групп: переиспользует весь конвейер
// monitor.ts (синхронизация каналов, классификация сообщений, LLM-отбор ответа,
// DM-скоринг, отправка) и добавляет один новый шаг между классификацией и
// LLM-вызовом — гейт свежести поста (core/freshness-gate.ts). monitor.ts (v1) не
// меняется ни строкой — обе версии сосуществуют, выбор варианта на агента через
// таблицу tasks (TaskType "monitor" | "monitor-v2").
//
// Единственные отличия от monitor.ts:
//   1. getMessages вызывается с { includeChannelPosts: true } — служебные копии
//      постов не отбрасываются на сетевом уровне, участвуют в анализе как
//      обычное сообщение (requirements-v1.md, раздел 5, случай B).
//   2. После classifyMessages сообщения всех трёх бакетов проходят гейт
//      свежести (R1/R2/R3) — непрошедшие исключаются до какого-либо LLM-вызова.
//   3. Период обхода — MONITOR_V2_CHECK_PERIOD_SECONDS, отдельная от monitor.ts
//      константа (сейчас тоже 72ч, но не переиспользует CHANNEL_CHECK_PERIOD_SECONDS).
//   4. Локальный кеш дат публикации постов веток (thread_post_dates) с TTL 30
//      дней — вытесняется в начале каждого прогона.

import { z } from "zod";

import type { SkillContext, SkillStatus } from "./types";
import { sleep, FloodAbortError, withFloodRetry } from "./util";
import { parseFloodWait, classifyTelegramErrorTag, ClientNotConnectedError } from "../core/telegram/errors";
import {
    initChannels,
    syncChannels,
    getChannelsBatch,
    markChannelProcessed,
    classifyMessages,
    createGroupThread,
    updateGroupThread,
    expireGroupThreads,
    insertDmCandidate,
    recordChannelVisit,
    recordSendError,
    markChannelStatus,
    expireChannelStatuses,
    countRecentlyBannedChannels,
    type ClassifyInputMessage,
    type ClassifyResult,
    type NewThreadEntry,
    type ThreadReplyEntry,
} from "../core/db/channels";
import { saveReply, getThreadPostDate, saveThreadPostDate, expireOldThreadPostDates, getAgentSentMessageIds } from "../core/db/replies";
import { cacheChannelIdentities } from "../core/channel-sync";
import { upsertRestriction } from "../core/db/agent-restrictions";
import { recordAccountError } from "../core/db/error-log";
import {
    MONITOR_V2_CHECK_PERIOD_SECONDS,
    THREAD_POST_DATE_TTL_SECONDS,
    FUNNEL_ADMIN_AGENT_ID,
    MESSAGE_DELETION_CHECK_WINDOW_SECONDS,
    MESSAGE_DELETION_THRESHOLD,
    CHANNEL_SUSPEND_DURATION_SECONDS,
} from "../core/config";
import { evaluateFreshness, type FreshnessGateDeps, type FreshnessGateMessage } from "../core/freshness-gate";
import {
    generateThreadReply,
    generateThreadContinuation,
    generateReply,
    analyzeChannelMessages,
} from "../llm/prompts";

/**
 * Сигнал «пропустить текущий канал и продолжить прогон». Бросается обёрткой
 * sendReply при не-flood ошибке отправки ответа; внешний catch цикла ловит его,
 * помечает канал обработанным и переходит к следующему (не валит весь прогон).
 */
class ChannelSkipError extends Error {
    constructor() {
        super("Channel skipped after send error");
        this.name = "ChannelSkipError";
    }
}

/**
 * Сигнал «остановить весь прогон немедленно» при PEER_FLOOD на отправке ответа
 * (telegram-error-handling №29) — не ошибка конкретного канала, в отличие от
 * ChannelSkipError. Побочные эффекты (agent_restrictions/error_log) уже
 * выполнены в месте броска, до этого сигнала.
 */
class PeerFloodError extends Error {
    constructor() {
        super("PEER_FLOOD — aborting run");
        this.name = "PeerFloodError";
    }
}

/** Окно правила «10 каналов banned за сутки» (agent-restrictions, суспенд-триггер 2). */
const RECENTLY_BANNED_WINDOW_SECONDS = 86400;
const RECENTLY_BANNED_THRESHOLD = 10;

const THREAD_EXPIRE_SECONDS = 345600; // 4 дня — экспирация тредов по последней активности (не связано с гейтом свежести)
const GET_MESSAGES_LIMIT = 1000;
const DM_SCORE_THRESHOLD = 0.6;
const PREFILTER_MIN_LEN = 15;        // короче — заведомо непроходное (реакции)

/**
 * Дешёвый эвристический префильтр general-сообщений до LLM (design.md §4):
 * отбрасывает слишком короткие, только эмодзи/пунктуация, без буквенных символов.
 * Консервативный порог — влияет лишь на отбор кандидата/ответа, не на чтение.
 */
function passesPrefilter(text: string): boolean {
    const t = text.trim();
    if (t.length < PREFILTER_MIN_LEN) return false;
    if (!/\p{L}/u.test(t)) return false; // нет ни одной буквы → эмодзи/пунктуация
    return true;
}

/** Счётчик исключений гейта свежести по причине (для статус-отчёта). */
interface GateMetrics {
    noThread: number;
    dateUnresolved: number;
    stale: number;
}

function recordExclusion(metrics: GateMetrics, reason: "no_thread" | "date_unresolved" | "stale"): void {
    if (reason === "no_thread") metrics.noThread += 1;
    else if (reason === "date_unresolved") metrics.dateUnresolved += 1;
    else metrics.stale += 1;
}

function toGateMessage(chatId: string, m: ClassifyInputMessage): FreshnessGateMessage {
    return { chatId, date: m.date, replyToTopId: m.replyToTopId, isChannelPost: m.isChannelPost };
}

/**
 * Применяет гейт свежести к трём бакетам classifyMessages последовательно
 * (for...of, без Promise.all — один запрос к Telegram на новую ветку за прогон,
 * design.md «Обработка одного батча — последовательно»). Записи
 * (NewThreadEntry/ThreadReplyEntry), лишившиеся всех сообщений, исключаются целиком.
 */
async function applyFreshnessGate(
    chatId: string,
    classified: ClassifyResult,
    deps: FreshnessGateDeps,
    nowSec: number,
    metrics: GateMetrics,
): Promise<ClassifyResult> {
    const generalMessages: ClassifyInputMessage[] = [];
    for (const m of classified.generalMessages) {
        const outcome = await evaluateFreshness(deps, toGateMessage(chatId, m), false, nowSec);
        if (outcome.pass) {
            generalMessages.push(m);
        } else {
            recordExclusion(metrics, outcome.reason);
        }
    }

    const newThreadMessages: NewThreadEntry[] = [];
    for (const entry of classified.newThreadMessages) {
        const messages: ClassifyInputMessage[] = [];
        for (const m of entry.messages) {
            const outcome = await evaluateFreshness(deps, toGateMessage(chatId, m), true, nowSec);
            if (outcome.pass) messages.push(m);
            else recordExclusion(metrics, outcome.reason);
        }
        if (messages.length > 0) newThreadMessages.push({ ...entry, messages });
    }

    const threadReplies: ThreadReplyEntry[] = [];
    for (const entry of classified.threadReplies) {
        const newMessages: ClassifyInputMessage[] = [];
        for (const m of entry.newMessages) {
            const outcome = await evaluateFreshness(deps, toGateMessage(chatId, m), true, nowSec);
            if (outcome.pass) newMessages.push(m);
            else recordExclusion(metrics, outcome.reason);
        }
        if (newMessages.length > 0) threadReplies.push({ ...entry, newMessages });
    }

    return { generalMessages, newThreadMessages, threadReplies };
}

export async function runMonitorV2(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, persona, tg, llm, log } = ctx;

    // Шаг 1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // Шаг 2 — Инициализация таблицы
    initChannels(agentId, log);

    // Шаг 3 — Синхронизация каналов (полный список диалогов)
    const channelsMap = await tg.listGroupChannels();
    syncChannels(agentId, channelsMap, log);

    // Шаг 3b — Кэшировать идентичность привязанного канала для новых/непрорезолвленных
    // чатов (channel-content-analysis). Инкрементально, безопасно к сбоям — монитор не
    // должен падать из-за резолва.
    try {
        await cacheChannelIdentities(agentId, tg, log);
    } catch (err: any) {
        if (err instanceof ClientNotConnectedError) throw err;
        log.warn(`[monitor-v2] шаг кэширования идентичности каналов пропущен: ${err?.message ?? err}`);
    }

    // Шаг 4 — Получить батч назревших каналов (период monitor-v2 — 24ч, R5)
    const { channels } = getChannelsBatch(agentId, log, undefined, MONITOR_V2_CHECK_PERIOD_SECONDS);
    if (channels.length === 0) {
        return { status: "success", details: { reason: "no_due_channels" } };
    }

    // Шаг 4.5 — Экспирировать устаревшие треды (по последней активности — не связано
    // с гейтом свежести поста) и вытеснить кеш дат публикации постов старше TTL.
    expireGroupThreads(agentId, log, THREAD_EXPIRE_SECONDS);
    expireOldThreadPostDates(agentId, THREAD_POST_DATE_TTL_SECONDS, log);
    expireChannelStatuses(agentId, log);

    // Детерминизация: get_dialogs_for_batch заполняет peerCache и даёт
    // readInboxMaxId/unreadCount по каждому каналу батча — дозапрашивая страницы
    // диалогов, пока весь батч не покрыт (а не один вызов с окном в топ-N, см.
    // шапку файла, monitor-dialogs-pagination). Канал, не попавший в карту —
    // статус не определён, НЕ значит «пусто».
    let dialogStatusByChat: Map<string, { unreadCount: number; readInboxMaxId: number }>;
    try {
        dialogStatusByChat = await withFloodRetry(
            () => tg.getDialogsForBatch(channels.map((c) => c.chatId)),
            log,
        );
    } catch (err: any) {
        if (err instanceof FloodAbortError) {
            return { status: "error", details: { step: "get_dialogs_for_batch", reason: "repeated_flood_wait" } };
        }
        throw err;
    }

    let candidatesAdded = 0;
    let channelsProcessed = 0;
    let channelsWithActivity = 0;   // были непрочитанные сообщения
    let channelsSkippedErrors = 0;  // упал telegram_get_messages
    // Ответы по типам (2.2)
    let repliesNewThreads = 0;
    let repliesThreadContinuations = 0;
    let repliesGeneral = 0;
    // Метрики гейта свежести (post-freshness-gate)
    const gateMetrics: GateMetrics = { noThread: 0, dateUnresolved: 0, stale: 0 };

    // Реализация FreshnessGateDeps поверх локального кеша thread_post_dates и
    // точечного запроса TelegramService.getMessageById (случай A алгоритма).
    const gateDeps: FreshnessGateDeps = {
        getCachedPostDate: (chatId, topMsgId) => getThreadPostDate(agentId, chatId, topMsgId),
        fetchAndCachePostDate: async (chatId, topMsgId) => {
            const res = await tg.getMessageById(chatId, topMsgId);
            if (!res) return null;
            saveThreadPostDate(agentId, chatId, topMsgId, res.date, log);
            return res.date;
        },
    };

    // Отправка ответа с обработкой FLOOD_WAIT. Бросает FloodAbortError при
    // повторном FLOOD_WAIT (вызывающий завершает весь прогон).
    const sendReplyRaw = (chatId: string, replyToMessageId: number, text: string) =>
        withFloodRetry(() => tg.replyToMessage(chatId, replyToMessageId, text), log);

    // Обёртка отправки ответа: не-flood ошибка отправки → записать в send_errors
    // и бросить ChannelSkipError (внешний catch пропустит канал, прогон
    // продолжится). FloodAbortError пробрасывается как есть — повторный
    // FLOOD_WAIT прерывает весь прогон, это поведение не меняется.
    const sendReply = async (chatId: string, replyToMessageId: number, text: string) => {
        try {
            return await sendReplyRaw(chatId, replyToMessageId, text);
        } catch (err: any) {
            if (err instanceof FloodAbortError) throw err;
            if (err instanceof ClientNotConnectedError) throw err;
            const msg = err?.message ?? String(err);
            log.warn(`[monitor-v2] reply failed for chatId=${chatId}, skipping channel: ${msg}`);
            const tag = classifyTelegramErrorTag(err);

            if (tag === "peer_flood") {
                // PEER_FLOOD — временный бан на рассылку, не ошибка конкретного
                // канала (telegram-error-handling №29): остановить весь прогон.
                upsertRestriction(FUNNEL_ADMIN_AGENT_ID, agentId, "suspend", msg, 86400);
                recordAccountError(agentId, "monitor-v2", msg);
                throw new PeerFloodError();
            }

            if (tag === "chat_write_forbidden" || tag === "user_banned_in_channel") {
                // CHAT_WRITE_FORBIDDEN и USER_BANNED_IN_CHANNEL (в контексте
                // отправки) — то же поведение (№23/№24): status='banned' одновременно
                // ставит канал в очередь на выход (leave-banned-channels читает
                // channels.status) и останавливает обработку monitor-v2 со следующего
                // же батча, не дожидаясь физического выхода.
                recordSendError(agentId, { chatId, source: "monitor_v2", errorCode: "chat_write_forbidden" }, log);
                markChannelStatus(agentId, chatId, "banned", log);

                const recentlyBanned = countRecentlyBannedChannels(agentId, RECENTLY_BANNED_WINDOW_SECONDS);
                if (recentlyBanned >= RECENTLY_BANNED_THRESHOLD) {
                    upsertRestriction(FUNNEL_ADMIN_AGENT_ID, agentId, "suspend", "channels_banned", 259200);
                    recordAccountError(agentId, "monitor-v2", "channels_banned");
                }
            } else if (tag === "chat_send_plain_forbidden" || tag === "chat_send_media_forbidden" || tag === "allow_payment_required") {
                // Запрет формата контента/платные сообщения (№25-27) — канал сам
                // не забанен, только отклоняет способ отправки. Выход не выполняется.
                markChannelStatus(agentId, chatId, "format_error", log);
            } else if (parseFloodWait(err) !== null) {
                recordSendError(agentId, { chatId, source: "monitor_v2", errorCode: "flood_deferred" }, log);
            } else {
                recordSendError(agentId, { chatId, source: "monitor_v2", errorCode: "reply_failed" }, log);
            }
            throw new ChannelSkipError();
        }
    };

    // Шаг 5 — Обработать каждый канал
    for (const channel of channels) {
        const chatId = channel.chatId;

        // 5.0 — channels.status = 'banned'/'suspend' останавливает обработку канала
        // (telegram-error-handling, channel-suspend-on-deletion); 'format_error' не
        // влияет, обрабатывается как обычно. getChannelsBatch уже исключает
        // banned/suspend из выборки (защита от «забивания» батча) — эта проверка
        // остаётся как дополнительный уровень защиты.
        if (channel.status === "banned" || channel.status === "suspend") {
            log.info(`[monitor-v2] chatId=${chatId} status=${channel.status} — skipping channel`);
            continue;
        }

        // 5.0b — Проверка удалённых сообщений агента в канале (channel-suspend-on-deletion):
        // не зависит от наличия непрочитанных сообщений, выполняется при каждом визите.
        // Пропускается, если агент не отправлял сообщений в канал за окно проверки.
        const deletionCheckSentIds = getAgentSentMessageIds(agentId, chatId, Math.floor(Date.now() / 1000) - MESSAGE_DELETION_CHECK_WINDOW_SECONDS);
        if (deletionCheckSentIds.length > 0) {
            try {
                const existingIds = await withFloodRetry(() => tg.getMessagesExistence(chatId, deletionCheckSentIds), log);
                const deletedCount = deletionCheckSentIds.length - existingIds.size;
                if (deletedCount > MESSAGE_DELETION_THRESHOLD) {
                    const description = `messages_deleted: ${deletedCount} за ${Math.floor(MESSAGE_DELETION_CHECK_WINDOW_SECONDS / 86400)} дней`;
                    markChannelStatus(agentId, chatId, "suspend", log, CHANNEL_SUSPEND_DURATION_SECONDS, description);
                    recordSendError(agentId, { chatId, source: "monitor_v2", errorCode: "messages_deleted" }, log);
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
                // Проверка удаления — вспомогательная, сбой не должен блокировать обычную
                // обработку канала.
                log.warn(`[monitor-v2] deletion check failed for chatId=${chatId}: ${err.message ?? err}`);
            }
        }

        // 5.1 — Получить непрочитанные сообщения
        const dialogStatus = dialogStatusByChat.get(chatId);
        if (dialogStatus === undefined) {
            // Статус канала не определён (Telegram не ответил по нему даже после
            // дозапроса страниц) — НЕ значит «пусто», обрабатываем как ошибку,
            // getMessages не вызываем (monitor-dialogs-pagination).
            log.warn(`[monitor-v2] dialog status undetermined for chatId=${chatId}, skipping channel`);
            recordChannelVisit(agentId, { chatId, outcome: "error", messagesCount: 0 }, log);
            recordSendError(agentId, { chatId, source: "monitor_v2", errorCode: "dialog_status_unknown" }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            channelsSkippedErrors += 1;
            continue;
        }
        if (dialogStatus.unreadCount === 0) {
            // Подтверждённо пусто — канал встретился в диалогах, непрочитанного нет.
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            continue;
        }
        const readInboxMaxId = dialogStatus.readInboxMaxId;

        let messages;
        try {
            // includeChannelPosts: true — служебные копии постов не отбрасываются,
            // участвуют в гейте свежести как обычное сообщение (случай B алгоритма).
            const res = await withFloodRetry(
                () => tg.getMessages(chatId, readInboxMaxId, GET_MESSAGES_LIMIT, { includeChannelPosts: true }),
                log,
            );
            messages = res.messages;
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { step: "get_messages", reason: "repeated_flood_wait", chatId } };
            }
            if (err instanceof ClientNotConnectedError) throw err;
            // Другая ошибка — пропустить канал (к 5.7)
            log.warn(`[monitor-v2] get_messages failed for chatId=${chatId}, skipping channel: ${err.message ?? err}`);
            recordChannelVisit(agentId, { chatId, outcome: "error", messagesCount: 0 }, log);
            recordSendError(agentId, { chatId, source: "monitor_v2", errorCode: "get_messages_error" }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            channelsSkippedErrors += 1;
            await sleep(1000);
            continue;
        }

        if (messages.length === 0) {
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleep(1000);
            continue;
        }

        // Канал с активностью (были непрочитанные сообщения).
        recordChannelVisit(agentId, { chatId, outcome: "active", messagesCount: messages.length }, log);
        channelsWithActivity += 1;

        // 5.2 — Пометить прочитанными (немедленно, независимо от исхода гейта — R4)
        const maxId = Math.max(...messages.map((m) => m.id));
        try {
            await tg.markAsRead(chatId, maxId);
        } catch (err: any) {
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[monitor-v2] mark_as_read failed for chatId=${chatId}: ${err.message ?? err}`);
        }

        // 5.3 — Классифицировать сообщения (без изменений — переиспользуется как есть)
        const classified = classifyMessages(agentId, chatId, messages, log);

        // 5.3b — Гейт свежести (новый шаг, post-freshness-gate): R1/R2/R3 по каждому
        // сообщению трёх бакетов, до какого-либо LLM-вызова.
        const { generalMessages, newThreadMessages, threadReplies } = await applyFreshnessGate(
            chatId,
            classified,
            gateDeps,
            Math.floor(Date.now() / 1000),
            gateMetrics,
        );

        // Карта id → сообщение для маппинга DM-кандидатов из ответа LLM обратно к
        // полям (userAccessHash/fromId/text).
        const generalById = new Map(generalMessages.map((m) => [m.id, m]));
        // Результат консолидированного анализа канала (отбор ответа + скоринг DM).
        // Заполняется внутри try; DM-кандидаты пишутся после (5.8).
        let analysis: { ответитьНа: { id: number; текст: string } | null; dmКандидаты: { id: number; score: number; reason?: string }[] } | null = null;

        try {
            // 5.4 — newThreadMessages (первый ответ пользователя)
            for (const entry of newThreadMessages) {
                const rec = entry.agentReplyRecord;
                const { threadId } = createGroupThread(
                    agentId,
                    { chatId, startMsgId: rec.msgId, startMsgText: rec.msgText, agentMsgId: rec.replyMsgId, agentMsgText: rec.replyText },
                    log,
                );

                const dialogLines = entry.messages.map((m) => `- ${m.fromName}: ${m.text}`).join("\n");
                const prompt = generateThreadReply(rec.msgText, rec.replyText, dialogLines);
                const replyText = await llm.complete({ system: persona, prompt });

                const last = entry.messages[entry.messages.length - 1];
                const sent = await sendReply(chatId, last.id, replyText);
                repliesNewThreads += 1;

                const newMsgs = [
                    ...entry.messages.map((m) => ({ role: "user", msgId: m.id, fromName: m.fromName, fromId: m.fromId, text: m.text })),
                    { role: "agent", msgId: sent.messageId, text: replyText },
                ];
                updateGroupThread(agentId, threadId, JSON.stringify(newMsgs), sent.messageId, log);
            }

            // 5.5 — threadReplies (продолжение существующего треда)
            for (const entry of threadReplies) {
                const historyLines = entry.threadMessages
                    .map((m) => (m.role === "agent" ? `- Ты: ${m.text}` : `- ${m.fromName ?? "Пользователь"}: ${m.text}`))
                    .join("\n");
                const newLines = entry.newMessages.map((m) => `- ${m.fromName}: ${m.text}`).join("\n");
                const prompt = generateThreadContinuation(historyLines, newLines);
                const replyText = await llm.complete({ system: persona, prompt });

                const last = entry.newMessages[entry.newMessages.length - 1];
                const sent = await sendReply(chatId, last.id, replyText);
                repliesThreadContinuations += 1;

                const newMsgs = [
                    ...entry.newMessages.map((m) => ({ role: "user", msgId: m.id, fromName: m.fromName, fromId: m.fromId, text: m.text })),
                    { role: "agent", msgId: sent.messageId, text: replyText },
                ];
                updateGroupThread(agentId, entry.threadId, JSON.stringify(newMsgs), sent.messageId, log);
            }

            // 5.6 — generalMessages: один структурированный вызов на канал
            // (отбор ≤1 сообщения для ответа + скоринг DM-кандидатов). Префильтр
            // отбрасывает заведомо непроходные сообщения до LLM (3.1). Сообщения,
            // не прошедшие гейт свежести, сюда уже не попадают (5.3b).
            const filtered = generalMessages.filter((m) => passesPrefilter(m.text));
            if (filtered.length > 0) {
                const analyzePrompt = analyzeChannelMessages(filtered.map((m) => `id=${m.id} ${m.fromName}: ${m.text}`).join("\n"));
                analysis = await llm.completeObject(
                    { system: persona, prompt: analyzePrompt },
                    z.object({
                        ответитьНа: z.object({ id: z.number(), текст: z.string() }).nullable(),
                        dmКандидаты: z.array(z.object({ id: z.number(), score: z.number(), reason: z.string().optional() })),
                    }),
                );

                // Не более одного ответа на канал (3.4).
                if (analysis.ответитьНа) {
                    const sel = analysis.ответитьНа;
                    // Текст берём по id из реальных сообщений (general-reply-text-grounding) —
                    // sel.текст это восстановленный LLM текст, не обязательно совпадающий с оригиналом.
                    const selMsg = generalById.get(sel.id);
                    if (!selMsg) {
                        log.warn(`[monitor-v2] analyzeChannelMessages вернул несуществующий id=${sel.id}, ответ на общие сообщения пропущен`);
                    } else {
                        const replyPrompt = generateReply(selMsg.text);
                        const replyText = await llm.complete({ system: persona, prompt: replyPrompt });

                        const sent = await sendReply(chatId, sel.id, replyText);
                        repliesGeneral += 1;

                        // Записать ответ в БД (сидирует replies для детекта новых тредов)
                        try {
                            saveReply(agentId, { chatId, msgId: sel.id, msgText: selMsg.text, replyMsgId: sent.messageId, replyText, channelUsername: channelsMap.get(chatId)?.username ?? null });
                        } catch (saveErr: any) {
                            log.warn(`[monitor-v2] saveReply failed: ${saveErr.message ?? saveErr}`);
                        }
                    }
                }
            }
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                // Повторный FLOOD_WAIT при отправке — завершить весь прогон
                const repliesSent = repliesNewThreads + repliesThreadContinuations + repliesGeneral;
                return { status: "error", details: { step: "reply", reason: "repeated_flood_wait", chatId, repliesSent, candidatesAdded } };
            }
            if (err instanceof PeerFloodError) {
                // PEER_FLOOD — завершить весь прогон немедленно (telegram-error-handling
                // №29); agent_restrictions/error_log уже записаны в sendReply.
                const repliesSent = repliesNewThreads + repliesThreadContinuations + repliesGeneral;
                return { status: "error", details: { step: "reply", reason: "peer_flood", chatId, repliesSent, candidatesAdded } };
            }
            if (err instanceof ChannelSkipError) {
                // Не-flood ошибка отправки ответа — пропустить канал, продолжить прогон.
                // Ошибка уже записана в send_errors внутри обёртки sendReply.
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                channelsSkippedErrors += 1;
                await sleep(1000);
                continue;
            }
            throw err;
        }

        // 5.7 — Сохранить прогресс (сразу после канала)
        markChannelProcessed(agentId, chatId, log);
        channelsProcessed += 1;

        // 5.8 — Записать DM-кандидатов из консолидированного анализа (порог 0.6,
        // прежний набор полей insertDmCandidate). Скоринг уже сделан тем же
        // LLM-вызовом (5.6), отдельных запросов нет.
        if (analysis) {
            for (const cand of analysis.dmКандидаты) {
                if (cand.score < DM_SCORE_THRESHOLD) continue;
                const m = generalById.get(cand.id);
                if (!m || !m.userAccessHash) continue;
                insertDmCandidate(
                    agentId,
                    {
                        userId: m.fromId,
                        userAccessHash: m.userAccessHash,
                        sourceChatId: chatId,
                        msgId: m.id,
                        msgText: m.text,
                        score: cand.score,
                        scoreReason: cand.reason,
                    },
                    log,
                );
                candidatesAdded += 1;
            }
        }

        // 5.1 — Пауза 1 секунда перед следующим каналом
        await sleep(1000);
    }

    // Итоговая статус-модель (русские ключи, 2.3 + метрики гейта свежести)
    return {
        status: "success",
        details: {
            "каналов обработано": channelsProcessed,
            "каналов с активностью": channelsWithActivity,
            "каналов пропущено (ошибки)": channelsSkippedErrors,
            "ответов отправлено": {
                "всего": repliesNewThreads + repliesThreadContinuations + repliesGeneral,
                "новые треды": repliesNewThreads,
                "продолжения тредов": repliesThreadContinuations,
                "общие сообщения": repliesGeneral,
            },
            "dm-кандидатов добавлено": candidatesAdded,
            "гейт свежести — исключено": {
                "нет привязки к ветке (no_thread)": gateMetrics.noThread,
                "дата не определена (date_unresolved)": gateMetrics.dateUnresolved,
                "устарело (stale)": gateMetrics.stale,
            },
        },
    };
}
