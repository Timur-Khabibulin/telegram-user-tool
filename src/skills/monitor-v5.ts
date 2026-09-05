// skills/monitor-v5.ts — runMonitorV5 (group-monitoring-v5).
//
// Копия-адаптация monitor.ts (v1): §1-5.8 — чтение всего чата обсуждения
// (батч, диалоги, непрочитанные, классификация, ведение и продолжение
// диалоговых веток, решение по общим сообщениям, DM-скоринг) переносятся без
// изменений по существу — тот же analyzeChannelMessages/generateReply, что и
// в v1 (openspec/changes/monitor-v5/design.md). Меняется только одно место:
// обработка ошибок отправки — handlePostCommentSendError вместо инлайн-
// классификации v1: учитывает PEER_FLOOD/баны/эскалацию, как monitor-v3/
// monitor-v4. Проверки поста канала (веб-превью, гейт по комментариям,
// only_comment) — нет вообще, это исключительно monitor-v4. monitor.ts/
// monitor-v4.ts не меняются ни строкой.
//
// human-pacing (2026-08): ритм прогона приведён к человеческому. Было —
// фиксированная пауза 1 сек между каналами, статус всех каналов батча одним
// обходом диалогов до цикла, мгновенная отметка о прочтении и мгновенная
// отправка ответа. Стало:
//   • батч 20 каналов вместо 50 (иначе прогон не влезает в лимит юнита);
//   • статус каждого чата — отдельным запросом в своей итерации;
//   • паузы случайные: 20-50 сек после «читал», 8-20 сек после пустого;
//   • время чтения — по объёму текста хвоста сообщений;
//   • отметка о прочтении — после чтения, а не сразу после загрузки;
//   • ответ — пауза «подумать» + индикатор «печатает…» по скорости печати.
// Значения — константы V5_* в core/config.ts.
//
// human-pacing-batching (monitor-v5-human-pacing-batching, 2026-08): вторая
// итерация human-pacing поверх предыдущей. Было — полная синхронизация
// списка каналов каждый прогон одним запросом, один getChannelsBatch на весь
// батч, одно чтение + одна разметка прочитанным на весь непрочитанный хвост
// чата, typing по скорости печати текста ответа. Стало:
//   • полная синхронизация (listGroupChannels/syncChannels/
//     cacheChannelIdentities) — не чаще раза в сутки (V5_FULL_SYNC_PERIOD_SECONDS),
//     listGroupChannels постранично с паузами (core/telegram/service.ts);
//   • отбор каналов — волнами случайного размера (V5_WAVE_MIN/MAX) через
//     повторные вызовы getChannelsBatch, пока не набран мягкий потолок
//     V5_BATCH_LIMIT, с паузой после каждого вызова;
//   • чтение сообщений — чанками случайного размера (V5_MSG_CHUNK_MIN/MAX) с
//     паузой перед и между разметкой прочитанным каждого чанка;
//   • typing — единый диапазон V5_TYPING_MIN/MAX_SEC вместо расчёта по
//     скорости печати и отдельной паузы «подумать» (readingSeconds убрана
//     целиком — её роль взяли на себя паузы между чанками).
// Решения — openspec/changes/monitor-v5-human-pacing-batching/design.md.

import { z } from "zod";

import type { SkillContext, SkillStatus } from "./types";
import { sleep, sleepRandom, randomBetween, FloodAbortError, withFloodRetry } from "./util";
import { ClientNotConnectedError } from "../core/telegram/errors";
import type { TgMessage } from "../core/telegram/service";
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
    isFullSyncDue,
    markFullSyncDone,
    saveChatAccessHash,
    getChatAccessHash,
    getChatTitlesAndUsernames,
} from "../core/db/channels";
import { saveReply } from "../core/db/replies";
import { cacheChannelIdentities } from "../core/channel-sync";
import { handlePostCommentSendError } from "../core/post-comment-send";
import { sendNotifyMessage } from "../core/review-bot-api";
import {
    MONITOR_V5_CHECK_PERIOD_SECONDS,
    isReviewGateEnabled,
    V5_BATCH_LIMIT,
    V5_SESSION_SEND_CAP,
    V5_DELAY_ACTIVE_MIN_SEC,
    V5_DELAY_ACTIVE_MAX_SEC,
    V5_DELAY_EMPTY_MIN_SEC,
    V5_DELAY_EMPTY_MAX_SEC,
    V5_GET_MESSAGES_LIMIT,
    V5_FULL_SYNC_PERIOD_SECONDS,
    V5_WAVE_MIN,
    V5_WAVE_MAX,
    V5_WAVE_DELAY_MIN_SEC,
    V5_WAVE_DELAY_MAX_SEC,
    V5_MSG_CHUNK_MIN,
    V5_MSG_CHUNK_MAX,
    V5_MSG_MARK_DELAY_MIN_SEC,
    V5_MSG_MARK_DELAY_MAX_SEC,
    V5_MSG_CHUNK_DELAY_MIN_SEC,
    V5_MSG_CHUNK_DELAY_MAX_SEC,
    V5_TYPING_MIN_SEC,
    V5_TYPING_MAX_SEC,
} from "../core/config";
import {
    generateThreadReply,
    generateThreadContinuation,
    generateReply,
    analyzeChannelMessages,
} from "../llm/prompts";

/**
 * Сигнал «пропустить текущий канал и продолжить прогон» — тот же приём, что
 * в monitor-v3.ts/monitor-v4.ts: бросается обёрткой sendReply при не-flood
 * ошибке отправки, внешний catch цикла ловит его, помечает канал
 * обработанным и переходит к следующему.
 */
class ChannelSkipError extends Error {
    constructor() {
        super("Channel skipped after send error");
        this.name = "ChannelSkipError";
    }
}

/**
 * Сигнал «остановить весь прогон немедленно» при PEER_FLOOD — тот же приём,
 * что в monitor-v3.ts/monitor-v4.ts. Побочные эффекты (agent_restrictions/
 * error_log) уже выполнены в месте броска (handlePostCommentSendError).
 */
class PeerFloodError extends Error {
    constructor() {
        super("PEER_FLOOD — aborting run");
        this.name = "PeerFloodError";
    }
}

const THREAD_EXPIRE_SECONDS = 345600; // 4 дня — то же значение, что в monitor.ts
const DM_SCORE_THRESHOLD = 0.6;
const PREFILTER_MIN_LEN = 15;        // короче — заведомо непроходное (реакции)

/** Тот же эвристический префильтр, что passesPrefilter в monitor.ts. */
function passesPrefilter(text: string): boolean {
    const t = text.trim();
    if (t.length < PREFILTER_MIN_LEN) return false;
    if (!/\p{L}/u.test(t)) return false; // нет ни одной буквы → эмодзи/пунктуация
    return true;
}

/** Случайное целое в диапазоне [min, max] включительно (размер волны/чанка). */
function randomInt(min: number, max: number): number {
    return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Служебные отказы модели, которые нельзя публиковать в чат. Реальный случай:
 * за время работы в каналы улетело 57 таких «ответов» — «Не отвечу на это
 * сообщение.», «Пропущу.», «Не знаю.», «Пропускать тут буквально нечего - в
 * сообщении пустота.». Модель отказывалась отвечать, а текст отказа уходил
 * как обычный комментарий и выдавал бота с головой.
 *
 * Формулировки заведомо служебные — проверяются с начала строки, чтобы живой
 * ответ вроде «Не знаю, у меня было по-другому…» не попал под фильтр.
 */
// ВАЖНО: границу слова здесь нельзя писать через \b — в JS \b определяется
// через ASCII-класс \w, и для кириллицы не срабатывает вообще ("отвечу." не
// даёт границы между "у" и "."). Вместо неё — явный lookahead «дальше не
// буква» с флагом u.
const REFUSAL_PATTERNS: RegExp[] = [
    /^\s*(я\s+)?не\s+отвеч(у|аю)(?!\p{L})/iu,
    /^\s*не\s+буду\s+отвечать(?!\p{L})/iu,
    /^\s*отвечать\s+не\s+буду(?!\p{L})/iu,
    /^\s*пропу(щу|скаю|стить)(?!\p{L})/iu,
    /^\s*(это\s+)?сообщение\s+не\s+требует(?!\p{L})/iu,
    /нечего\s+(тут\s+|здесь\s+)?отвеч/iu,
    /в\s+сообщении\s+пустота/iu,
    /не\s+вижу\s+смысла\s+отвечать/iu,
    /как\s+(ии|искусственный\s+интеллект|языковая\s+модель)/iu,
    /языков(ая|ой)\s+модел/iu,
];

/** Короче этого ответ считается мусором и не отправляется. */
const REPLY_MIN_LEN = 8;

/** Отдельно: «Не знаю.» как самостоятельная реплика (но не начало живой фразы). */
const SHORT_DONT_KNOW_MAX_LEN = 25;

/**
 * Похоже ли на служебный отказ/мусор, который нельзя отправлять в чат
 * (refusal-filter). true — ответ подавляется, агент просто идёт дальше.
 */
export function isRefusalText(text: string): boolean {
    const t = text.trim();
    if (t.length < REPLY_MIN_LEN) return true;
    if (!/\p{L}/u.test(t)) return true; // ни одной буквы — эмодзи/пунктуация
    if (/^\s*не\s+знаю(?!\p{L})/iu.test(t) && t.length <= SHORT_DONT_KNOW_MAX_LEN) return true;
    return REFUSAL_PATTERNS.some((re) => re.test(t));
}

/**
 * Держит индикатор «печатает…» указанное время. Telegram гасит индикатор
 * примерно через 6 секунд, поэтому живой клиент шлёт его повторно — здесь
 * тот же приём, раз в 5 секунд. Ошибки индикатора игнорируются: это
 * косметика, из-за неё прогон падать не должен.
 */
async function showTypingFor(
    tg: SkillContext["tg"],
    chatId: string,
    seconds: number,
    log: SkillContext["log"],
): Promise<void> {
    const until = Date.now() + seconds * 1000;
    let warned = false;
    while (Date.now() < until) {
        try {
            await tg.setTyping(chatId, true);
        } catch (err: any) {
            if (!warned) {
                log.warn(`[monitor-v5] индикатор печати недоступен chatId=${chatId}: ${err?.message ?? err}`);
                warned = true;
            }
        }
        await sleep(Math.max(0, Math.min(5000, until - Date.now())));
    }
}

/**
 * Текст постфактум-уведомления в чат ревьюеров об отправленном ответе на
 * общее сообщение — то же сообщение (на которое ответили) и сам ответ. Тот
 * же приём, что formatSentNotification в monitor-v4.ts (без кнопок, только
 * для видимости — monitor-v5 не ждёт апрува).
 */
function formatGeneralReplyNotification(agentId: string, channelTitle: string, messageText: string, replyText: string): string {
    return [
        `Агент: ${agentId}`,
        `Канал: ${channelTitle}`,
        "",
        "Сообщение:",
        messageText,
        "",
        "Ответ:",
        replyText,
    ].join("\n");
}

/**
 * То же уведомление, что formatGeneralReplyNotification, но для тредовых
 * ответов (5.4 — старт нового треда, 5.5 — продолжение существующего) —
 * чтобы в чат ревьюеров уходили все сообщения, отправленные агентом, а не
 * только ответы на общие сообщения.
 */
function formatThreadReplyNotification(
    agentId: string,
    channelTitle: string,
    kind: "новый тред" | "продолжение треда",
    lastMessageText: string,
    replyText: string,
): string {
    return [
        `Агент: ${agentId}`,
        `Канал: ${channelTitle}`,
        `Тип: ${kind}`,
        "",
        "Сообщение:",
        lastMessageText,
        "",
        "Ответ:",
        replyText,
    ].join("\n");
}

export async function runMonitorV5(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, persona, tg, llm, log } = ctx;

    // Шаг 1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // Шаг 2 — Инициализация таблицы
    initChannels(agentId, log);

    // Шаг 3/3b — Полная синхронизация каналов (список диалогов + идентичность
    // привязанных каналов) — не чаще раза в сутки, не каждый прогон
    // (monitor-v5-human-pacing-batching design.md Decision 1). Due-порог —
    // тот же periodSeconds-приём, что у getChannelsBatch.
    if (isFullSyncDue(agentId, log, V5_FULL_SYNC_PERIOD_SECONDS)) {
        const channelsMap = await tg.listGroupChannels();
        syncChannels(agentId, channelsMap, log);
        // Персист chatAccessHash, узнанного listGroupChannels в peerCache
        // (design.md решение 5) — переживает рестарт процесса, в отличие от
        // самого peerCache, и годится для сидирования кэша на следующих
        // прогонах monitor-v5 (peerCache-окно между full sync — 24 ч).
        for (const chatId of channelsMap.keys()) {
            const accessHash = tg.getCachedChatAccessHash(chatId);
            if (accessHash) saveChatAccessHash(agentId, chatId, accessHash, log);
        }
        try {
            await cacheChannelIdentities(agentId, tg, log);
        } catch (err: any) {
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[monitor-v5] шаг кэширования идентичности каналов пропущен: ${err?.message ?? err}`);
        }
        markFullSyncDone(agentId, log);
    } else {
        log.info(`[monitor-v5] полная синхронизация каналов пропущена — не due`);
    }

    // Шаг 4.5 — Экспирировать устаревшие треды (один раз за прогон)
    expireGroupThreads(agentId, log, THREAD_EXPIRE_SECONDS);

    // Статус диалога снимается по одному каналу за раз внутри цикла обработки
    // (human-pacing), не общим обходом до цикла.

    let candidatesAdded = 0;
    let channelsProcessed = 0;
    let channelsWithActivity = 0;
    let channelsSkippedErrors = 0;
    let repliesNewThreads = 0;
    let repliesThreadContinuations = 0;
    let repliesGeneral = 0;
    let repliesSuppressed = 0;

    /** Подавить служебный отказ вместо отправки его в чат (refusal-filter). */
    const suppressRefusal = (chatId: string, kind: string, text: string): boolean => {
        if (!isRefusalText(text)) return false;
        repliesSuppressed += 1;
        log.warn(`[monitor-v5] ответ подавлен (${kind}) chatId=${chatId}: "${text.trim().slice(0, 80)}"`);
        return true;
    };

    // Отправка с обработкой FLOOD_WAIT/классификацией ошибок — design.md
    // Decision 3: handlePostCommentSendError (monitor-v3/monitor-v4), не
    // инлайн-обработка monitor.ts.
    const sendReplyRaw = (chatId: string, replyToMessageId: number, text: string) =>
        withFloodRetry(() => tg.replyToMessage(chatId, replyToMessageId, text), log);

    const sendReply = async (chatId: string, replyToMessageId: number, text: string) => {
        // human-pacing-batching: думание и печать больше не разделены на фазы —
        // единый диапазон typing перед отправкой, не зависящий от длины текста
        // (monitor-v5-human-pacing-batching design.md Decision 5).
        const typingSeconds = randomBetween(V5_TYPING_MIN_SEC, V5_TYPING_MAX_SEC);
        await showTypingFor(tg, chatId, typingSeconds, log);

        let sent;
        try {
            sent = await sendReplyRaw(chatId, replyToMessageId, text);
        } catch (err: any) {
            if (err instanceof FloodAbortError) throw err;
            if (err instanceof ClientNotConnectedError) throw err;
            const tag = handlePostCommentSendError(agentId, chatId, err, log, "monitor_v5");
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
            log.warn(`[monitor-v5] markAsRead(own reply) failed for chatId=${chatId}: ${err.message ?? err}`);
        }
        return sent;
    };

    // Шаг 4 + 5 — Волновой отбор назревших каналов и их обработка
    // (monitor-v5-human-pacing-batching design.md Decision 3): getChannelsBatch
    // вызывается повторно волнами случайного размера (V5_WAVE_MIN/MAX), пока
    // суммарно за прогон не набран мягкий потолок V5_BATCH_LIMIT либо
    // очередная волна не окажется пустой.
    let processedThisRun = 0;

    // Уникальные каналы с реально отправленным сообщением за прогон
    // (monitor-v5-session-send-cap) — отдельный, более строгий потолок, чем
    // V5_BATCH_LIMIT (тот считает посещённые/прочитанные каналы, не отправки).
    const sentChannels = new Set<string>();

    while (processedThisRun < V5_BATCH_LIMIT) {
        const { channels: wave } = getChannelsBatch(
            agentId,
            log,
            randomInt(V5_WAVE_MIN, V5_WAVE_MAX),
            MONITOR_V5_CHECK_PERIOD_SECONDS,
        );
        if (wave.length === 0) break;
        await sleepRandom(V5_WAVE_DELAY_MIN_SEC, V5_WAVE_DELAY_MAX_SEC);

    for (const channel of wave) {
        const chatId = channel.chatId;

        // 5.0 — Досеять peerCache персистентным chatAccessHash (design.md
        // решение 5), если full sync сегодня не due и канал туда не попал:
        // access_hash не истекает в рамках Telegram-сессии (core.telegram.org/
        // api/peers), поэтому значение, записанное join-queue или прошлым full
        // sync, остаётся рабочим и после рестарта процесса — не нужно ждать
        // следующего full sync, чтобы getPeerDialog нашёл peer.
        const cachedAccessHash = getChatAccessHash(agentId, chatId, log);
        if (cachedAccessHash) tg.seedPeerCache(chatId, cachedAccessHash);

        // 5.1 — Открыть чат: статус именно этого диалога, отдельным запросом
        // (human-pacing — раньше статус всех каналов батча снимался одним
        // обходом диалогов до начала цикла).
        let dialogStatus: { unreadCount: number; readInboxMaxId: number } | null;
        try {
            dialogStatus = await withFloodRetry(() => tg.getPeerDialog(chatId), log);
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { step: "get_peer_dialog", reason: "repeated_flood_wait", chatId } };
            }
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[monitor-v5] get_peer_dialog failed for chatId=${chatId}: ${err?.message ?? err}`);
            dialogStatus = null;
        }

        if (!dialogStatus) {
            // lastProcessedAt НЕ трогаем (в отличие от остальных исходов ниже) —
            // канал не был реально проверен, статус диалога просто не удалось
            // снять. Если бы отметили обработанным, канал ушёл бы в конец
            // очереди на MONITOR_V5_CHECK_PERIOD_SECONDS (72ч) вместо повторной
            // попытки на следующем прогоне.
            log.warn(`[monitor-v5] dialog status undetermined for chatId=${chatId}, skipping channel`);
            recordChannelVisit(agentId, { chatId, outcome: "error", messagesCount: 0 }, log);
            recordSendError(agentId, { chatId, source: "monitor_v5", errorCode: "dialog_status_unknown" }, log);
            channelsProcessed += 1;
            channelsSkippedErrors += 1;
            await sleepRandom(V5_DELAY_EMPTY_MIN_SEC, V5_DELAY_EMPTY_MAX_SEC);
            continue;
        }
        if (dialogStatus.unreadCount === 0) {
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            // «Заглянул и закрыл» — пауза короче, чем после чтения, но не ноль.
            await sleepRandom(V5_DELAY_EMPTY_MIN_SEC, V5_DELAY_EMPTY_MAX_SEC);
            continue;
        }

        // 5.1c/5.2 — Читать непрочитанные чанками случайного размера, с паузой
        // перед и между разметкой прочитанным каждого чанка
        // (monitor-v5-human-pacing-batching design.md Decision 4). Заменяет
        // прежний один вызов getMessages на весь хвост + одну разметку сразу
        // после «прочтения» по объёму текста (readingSeconds — убрана).
        let messages: TgMessage[] = [];
        try {
            let cursor = dialogStatus.readInboxMaxId;
            let totalFetched = 0;
            while (true) {
                const chunkSize = randomInt(V5_MSG_CHUNK_MIN, V5_MSG_CHUNK_MAX);
                const res = await withFloodRetry(
                    () => tg.getMessages(chatId, cursor, chunkSize, { reverse: true }),
                    log,
                );
                const chunk = res.messages;
                if (chunk.length === 0) break;

                await sleepRandom(V5_MSG_MARK_DELAY_MIN_SEC, V5_MSG_MARK_DELAY_MAX_SEC);
                const chunkMaxId = Math.max(...chunk.map((m) => m.id));
                try {
                    await tg.markAsRead(chatId, chunkMaxId);
                } catch (err: any) {
                    if (err instanceof ClientNotConnectedError) throw err;
                    log.warn(`[monitor-v5] mark_as_read failed for chatId=${chatId}: ${err.message ?? err}`);
                }

                messages.push(...chunk);
                cursor = chunkMaxId;
                totalFetched += chunk.length;

                if (totalFetched >= V5_GET_MESSAGES_LIMIT) {
                    log.warn(
                        `[monitor-v5] chatId=${chatId} превысил суммарный потолок ${V5_GET_MESSAGES_LIMIT} сообщений за прогон, дочитывание прервано`,
                    );
                    break;
                }
                if (chunk.length < chunkSize) break; // хвост вычитан до конца

                await sleepRandom(V5_MSG_CHUNK_DELAY_MIN_SEC, V5_MSG_CHUNK_DELAY_MAX_SEC);
            }
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { step: "get_messages", reason: "repeated_flood_wait", chatId } };
            }
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[monitor-v5] get_messages failed for chatId=${chatId}, skipping channel: ${err.message ?? err}`);
            recordChannelVisit(agentId, { chatId, outcome: "error", messagesCount: 0 }, log);
            recordSendError(agentId, { chatId, source: "monitor_v5", errorCode: "get_messages_error" }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            channelsSkippedErrors += 1;
            await sleepRandom(V5_DELAY_EMPTY_MIN_SEC, V5_DELAY_EMPTY_MAX_SEC);
            continue;
        }

        if (messages.length === 0) {
            recordChannelVisit(agentId, { chatId, outcome: "empty", messagesCount: 0 }, log);
            markChannelProcessed(agentId, chatId, log);
            channelsProcessed += 1;
            await sleepRandom(V5_DELAY_EMPTY_MIN_SEC, V5_DELAY_EMPTY_MAX_SEC);
            continue;
        }

        recordChannelVisit(agentId, { chatId, outcome: "active", messagesCount: messages.length }, log);
        channelsWithActivity += 1;

        // 5.3 — Классифицировать сообщения
        const { generalMessages, newThreadMessages, threadReplies } = classifyMessages(agentId, chatId, messages, log);

        let dmAnalysis: { ответитьНа: { id: number; текст: string } | null; dmКандидаты: { id: number; score: number; reason?: string }[] } | null = null;
        const generalById = new Map(generalMessages.map((m) => [m.id, m]));

        try {
            // 5.4 — newThreadMessages (первый ответ пользователя) — без изменений от monitor.ts.
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
                if (suppressRefusal(chatId, "новый тред", replyText)) continue;
                const sent = await sendReply(chatId, last.id, replyText);
                repliesNewThreads += 1;
                sentChannels.add(chatId);

                const newMsgs = [
                    ...entry.messages.map((m) => ({ role: "user", msgId: m.id, fromName: m.fromName, fromId: m.fromId, text: m.text })),
                    { role: "agent", msgId: sent.messageId, text: replyText },
                ];
                updateGroupThread(agentId, threadId, JSON.stringify(newMsgs), sent.messageId, log);

                if (isReviewGateEnabled(agentId)) {
                    try {
                        await sendNotifyMessage(
                            formatThreadReplyNotification(agentId, channel.title, "новый тред", last.text, replyText),
                            log,
                        );
                    } catch (notifyErr: any) {
                        log.warn(`[monitor-v5] sendNotifyMessage failed for chatId=${chatId}: ${notifyErr?.message ?? notifyErr}`);
                    }
                }
            }

            // 5.5 — threadReplies (продолжение существующего треда) — без изменений от monitor.ts.
            for (const entry of threadReplies) {
                const historyLines = entry.threadMessages
                    .map((m) => (m.role === "agent" ? `- Ты: ${m.text}` : `- ${m.fromName ?? "Пользователь"}: ${m.text}`))
                    .join("\n");
                const newLines = entry.newMessages.map((m) => `- ${m.fromName}: ${m.text}`).join("\n");
                const prompt = generateThreadContinuation(historyLines, newLines);
                const replyText = await llm.complete({ system: persona, prompt });

                const last = entry.newMessages[entry.newMessages.length - 1];
                if (suppressRefusal(chatId, "продолжение треда", replyText)) continue;
                const sent = await sendReply(chatId, last.id, replyText);
                repliesThreadContinuations += 1;
                sentChannels.add(chatId);

                const newMsgs = [
                    ...entry.newMessages.map((m) => ({ role: "user", msgId: m.id, fromName: m.fromName, fromId: m.fromId, text: m.text })),
                    { role: "agent", msgId: sent.messageId, text: replyText },
                ];
                updateGroupThread(agentId, entry.threadId, JSON.stringify(newMsgs), sent.messageId, log);

                if (isReviewGateEnabled(agentId)) {
                    try {
                        await sendNotifyMessage(
                            formatThreadReplyNotification(agentId, channel.title, "продолжение треда", last.text, replyText),
                            log,
                        );
                    } catch (notifyErr: any) {
                        log.warn(`[monitor-v5] sendNotifyMessage failed for chatId=${chatId}: ${notifyErr?.message ?? notifyErr}`);
                    }
                }
            }

            // 5.6 — generalMessages: один структурированный вызов на канал
            // (отбор ≤1 сообщения для ответа + скоринг DM-кандидатов) — без
            // изменений от monitor.ts.
            const filtered = generalMessages.filter((m) => passesPrefilter(m.text));
            if (filtered.length > 0) {
                const analyzePrompt = analyzeChannelMessages(filtered.map((m) => `id=${m.id} ${m.fromName}: ${m.text}`).join("\n"));
                dmAnalysis = await llm.completeObject(
                    { system: persona, prompt: analyzePrompt },
                    z.object({
                        ответитьНа: z.object({ id: z.number(), текст: z.string() }).nullable(),
                        dmКандидаты: z.array(z.object({ id: z.number(), score: z.number(), reason: z.string().optional() })),
                    }),
                );

                if (dmAnalysis.ответитьНа) {
                    const sel = dmAnalysis.ответитьНа;
                    // Текст берём по id из реальных сообщений (general-reply-text-grounding) —
                    // sel.текст это восстановленный LLM текст, не обязательно совпадающий с оригиналом.
                    const selMsg = generalById.get(sel.id);
                    if (!selMsg) {
                        log.warn(`[monitor-v5] analyzeChannelMessages вернул несуществующий id=${sel.id}, ответ на общие сообщения пропущен`);
                    } else {
                        const replyPrompt = generateReply(selMsg.text);
                        const replyText = await llm.complete({ system: persona, prompt: replyPrompt });

                        // Отказ модели не публикуем; DM-кандидаты ниже обрабатываются в любом случае.
                        if (!suppressRefusal(chatId, "общее сообщение", replyText)) {
                            const sent = await sendReply(chatId, sel.id, replyText);
                            repliesGeneral += 1;
                            sentChannels.add(chatId);

                            try {
                                // Персистентный chatUsername из channels (не эфемерный channelsMap
                                // из full sync — тот в scope только когда полная синхронизация
                                // due в этом прогоне, monitor-v5 human-pacing гейтит её раз в сутки).
                                const chatUsername = getChatTitlesAndUsernames(agentId, [chatId]).get(chatId)?.chatUsername ?? null;
                                saveReply(agentId, { chatId, msgId: sel.id, msgText: selMsg.text, replyMsgId: sent.messageId, replyText, channelUsername: chatUsername });
                            } catch (saveErr: any) {
                                log.warn(`[monitor-v5] saveReply failed: ${saveErr.message ?? saveErr}`);
                            }

                            if (isReviewGateEnabled(agentId)) {
                                try {
                                    await sendNotifyMessage(
                                        formatGeneralReplyNotification(agentId, channel.title, selMsg.text, replyText),
                                        log,
                                    );
                                } catch (notifyErr: any) {
                                    log.warn(`[monitor-v5] sendNotifyMessage failed for chatId=${chatId}: ${notifyErr?.message ?? notifyErr}`);
                                }
                            }
                        }
                    }
                }
            }
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                const repliesSent = repliesNewThreads + repliesThreadContinuations + repliesGeneral;
                return { status: "error", details: { step: "reply", reason: "repeated_flood_wait", chatId, repliesSent, candidatesAdded } };
            }
            if (err instanceof PeerFloodError) {
                return { status: "error", details: { step: "reply", reason: "peer_flood", chatId } };
            }
            if (err instanceof ChannelSkipError) {
                markChannelProcessed(agentId, chatId, log);
                channelsProcessed += 1;
                channelsSkippedErrors += 1;
                await sleepRandom(V5_DELAY_ACTIVE_MIN_SEC, V5_DELAY_ACTIVE_MAX_SEC);
                continue;
            }
            throw err;
        }

        // 5.7 — Сохранить прогресс
        markChannelProcessed(agentId, chatId, log);
        channelsProcessed += 1;

        // 5.8 — Записать DM-кандидатов — без изменений от monitor.ts.
        if (dmAnalysis) {
            for (const cand of dmAnalysis.dmКандидаты) {
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

        // Пауза перед переходом к следующему чату — после канала, в котором
        // было что читать (human-pacing, было фиксированные 1000 мс).
        await sleepRandom(V5_DELAY_ACTIVE_MIN_SEC, V5_DELAY_ACTIVE_MAX_SEC);

        // Потолок реальных отправок за прогон (monitor-v5-session-send-cap)
        // — канал только что полностью обработан (все его треды/general-ответ
        // уже отправлены или пропущены), поэтому можно останавливаться прямо
        // здесь: остаток волны и все следующие волны не читаются вообще.
        if (sentChannels.size >= V5_SESSION_SEND_CAP) {
            return {
                status: "success",
                details: {
                    reason: "session_send_cap",
                    "каналов обработано": channelsProcessed,
                    "каналов с активностью": channelsWithActivity,
                    "каналов пропущено (ошибки)": channelsSkippedErrors,
                    "ответов отправлено": {
                        "всего": repliesNewThreads + repliesThreadContinuations + repliesGeneral,
                        "новые треды": repliesNewThreads,
                        "продолжения тредов": repliesThreadContinuations,
                        "общие сообщения": repliesGeneral,
                    },
                    "ответов подавлено (служебный отказ)": repliesSuppressed,
                    "dm-кандидатов добавлено": candidatesAdded,
                },
            };
        }
    }

        processedThisRun += wave.length;
    }

    if (processedThisRun === 0) {
        return { status: "success", details: { reason: "no_due_channels" } };
    }

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
            "ответов подавлено (служебный отказ)": repliesSuppressed,
            "dm-кандидатов добавлено": candidatesAdded,
        },
    };
}
