// skills/monitor.ts — runMonitor (портирование skills/telegram-group-monitor/SKILL.md).
//
// Мониторинг групп: инициализация и синхронизация БД каналов, чтение
// непрочитанных в назревших чатах, ведение тредов, ответы и скоринг
// DM-кандидатов. Логика и промпты перенесены один-в-один (R-B2).
//
// Две вынужденные детерминизации (SKILL.md писался под LLM-агента):
//   1. telegram_get_dialogs не указан в шагах, но необходим: только он заполняет
//      peerCache (нужен mark_as_read/reply) и даёт readInboxMaxId (в батче
//      каналов его нет). Для синхронизации нужен полный список каналов —
//      отдельный listGroupChannels() (getDialogs возвращает только непрочитанные).
//      Сам readInboxMaxId/unreadCount по батчу теперь берётся через
//      getDialogsForBatch — дозапрос страниц диалогов до покрытия всего батча,
//      а не один вызов с окном в топ-N (monitor-dialogs-pagination).
//   2. saveReply после общих ответов (5.6.4): в оригинале reply-инструмент
//      записывал ответ в БД при передаче agentId — это сидирует таблицу replies
//      для будущего детекта первых ответов пользователей в classify.

import { z } from "zod";

import type { SkillContext, SkillStatus } from "./types";
import { sleep, FloodAbortError, withFloodRetry } from "./util";
import { parseFloodWait, ClientNotConnectedError } from "../core/telegram/errors";
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
} from "../core/db/channels";
import { saveReply } from "../core/db/replies";
import { cacheChannelIdentities } from "../core/channel-sync";
import { CHANNEL_CHECK_PERIOD_SECONDS } from "../core/config";
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

const THREAD_EXPIRE_SECONDS = 345600; // 4 дня
const GET_MESSAGES_LIMIT = 1000;
const DM_SCORE_THRESHOLD = 0.6;
const PREFILTER_MIN_LEN = 15;        // короче — заведомо непроходное (реакции)

/**
 * Дешёвый эвристический префильтр general-сообщений до LLM (design.md §4):
 * отбрасывает слишком короткие, только эмодзи/пунктуацию, без буквенных символов.
 * Консервативный порог — влияет лишь на отбор кандидата/ответа, не на чтение.
 */
function passesPrefilter(text: string): boolean {
    const t = text.trim();
    if (t.length < PREFILTER_MIN_LEN) return false;
    if (!/\p{L}/u.test(t)) return false; // нет ни одной буквы → эмодзи/пунктуация
    return true;
}

export async function runMonitor(ctx: SkillContext): Promise<SkillStatus> {
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
        log.warn(`[monitor] шаг кэширования идентичности каналов пропущен: ${err?.message ?? err}`);
    }

    // Шаг 4 — Получить батч назревших каналов
    const { channels } = getChannelsBatch(agentId, log, undefined, CHANNEL_CHECK_PERIOD_SECONDS);
    if (channels.length === 0) {
        return { status: "success", details: { reason: "no_due_channels" } };
    }

    // Шаг 4.5 — Экспирировать устаревшие треды (один раз)
    expireGroupThreads(agentId, log, THREAD_EXPIRE_SECONDS);

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
            log.warn(`[monitor] reply failed for chatId=${chatId}, skipping channel: ${msg}`);
            // CHAT_WRITE_FORBIDDEN — аккаунт забанен на запись: ставим канал в
            // очередь на выход (leave-banned-channels). Флуд на пороге/выше (не
            // отретраен withFloodRetry инлайн, см. core/telegram/errors.ts) — это не
            // сбой канала, а отложенная попытка: отдельный errorCode, чтобы не
            // искажать «проблемные каналы» отчёта воронки. Прочие не-flood ошибки —
            // как раньше, reply_failed.
            if (/CHAT_WRITE_FORBIDDEN/i.test(msg)) {
                // v1 не активен ни у одного агента (monitor-v4/v5 — актуальные) и,
                // в отличие от них, никогда не помечал channels.status='banned' —
                // раньше полагался только на banned_channels (убрана,
                // leave-banned-human-pacing). Оставлено как есть: канал просто
                // логируется и пропускается, в очередь на выход не попадает.
                recordSendError(agentId, { chatId, source: "monitor", errorCode: "chat_write_forbidden" }, log);
            } else if (parseFloodWait(err) !== null) {
                recordSendError(agentId, { chatId, source: "monitor", errorCode: "flood_deferred" }, log);
            } else {
                recordSendError(agentId, { chatId, source: "monitor", errorCode: "reply_failed" }, log);
            }
            throw new ChannelSkipError();
        }
    };

    // Шаг 5 — Обработать каждый канал
    for (const channel of channels) {
        const chatId = channel.chatId;

        // 5.1 — Получить непрочитанные сообщения
        const dialogStatus = dialogStatusByChat.get(chatId);
        if (dialogStatus === undefined) {
            // Статус канала не определён (Telegram не ответил по нему даже после
            // дозапроса страниц) — НЕ значит «пусто», обрабатываем как ошибку,
            // getMessages не вызываем (monitor-dialogs-pagination).
            log.warn(`[monitor] dialog status undetermined for chatId=${chatId}, skipping channel`);
            recordChannelVisit(agentId, { chatId, outcome: "error", messagesCount: 0 }, log);
            recordSendError(agentId, { chatId, source: "monitor", errorCode: "dialog_status_unknown" }, log);
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
            const res = await withFloodRetry(() => tg.getMessages(chatId, readInboxMaxId, GET_MESSAGES_LIMIT), log);
            messages = res.messages;
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { step: "get_messages", reason: "repeated_flood_wait", chatId } };
            }
            if (err instanceof ClientNotConnectedError) throw err;
            // Другая ошибка — пропустить канал (к 5.7)
            log.warn(`[monitor] get_messages failed for chatId=${chatId}, skipping channel: ${err.message ?? err}`);
            recordChannelVisit(agentId, { chatId, outcome: "error", messagesCount: 0 }, log);
            recordSendError(agentId, { chatId, source: "monitor", errorCode: "get_messages_error" }, log);
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

        // 5.2 — Пометить прочитанными (немедленно)
        const maxId = Math.max(...messages.map((m) => m.id));
        try {
            await tg.markAsRead(chatId, maxId);
        } catch (err: any) {
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[monitor] mark_as_read failed for chatId=${chatId}: ${err.message ?? err}`);
        }

        // 5.3 — Классифицировать сообщения
        const { generalMessages, newThreadMessages, threadReplies } = classifyMessages(agentId, chatId, messages, log);

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
            // отбрасывает заведомо непроходные сообщения до LLM (3.1).
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
                        log.warn(`[monitor] analyzeChannelMessages вернул несуществующий id=${sel.id}, ответ на общие сообщения пропущен`);
                    } else {
                        const replyPrompt = generateReply(selMsg.text);
                        const replyText = await llm.complete({ system: persona, prompt: replyPrompt });

                        const sent = await sendReply(chatId, sel.id, replyText);
                        repliesGeneral += 1;

                        // Записать ответ в БД (сидирует replies для детекта новых тредов)
                        try {
                            saveReply(agentId, { chatId, msgId: sel.id, msgText: selMsg.text, replyMsgId: sent.messageId, replyText, channelUsername: channelsMap.get(chatId)?.username ?? null });
                        } catch (saveErr: any) {
                            log.warn(`[monitor] saveReply failed: ${saveErr.message ?? saveErr}`);
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

    // Итоговая статус-модель (русские ключи, 2.3)
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
        },
    };
}
