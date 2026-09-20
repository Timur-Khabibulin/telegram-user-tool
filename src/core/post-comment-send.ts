// core/post-comment-send.ts — общая логика после решения «написать комментарий
// к посту» (channel-post-watch / post-comment-review): пост-отправочная
// обвязка успешной отправки и классификация ошибок отправки. Общая для
// monitor-v3.ts (прямая отправка, review-gate выключен) и review-listener.ts
// (после «Да» — design.md, решения 7 и 12). Извлечено из monitor-v3.ts без
// изменения поведения — то же копирование-и-адаптация из monitor-v2.ts,
// которое monitor-v3.ts уже унаследовал (design.md monitor-v3, решение 7).

import type { Logger } from "./logger";
import type { OperationSource } from "./db/channel-operations";
import { classifyTelegramErrorTag, parseFloodWait } from "./telegram/errors";
import { classifySendError } from "./write-access";
import {
    createGroupThread,
    savePostWatchComment,
    markChannelStatus,
    setWriteAccessReason,
    recordSendError,
    countRecentlyBannedChannels,
    type SendErrorSource,
} from "./db/channels";
import { saveReply } from "./db/replies";
import { upsertRestriction } from "./db/agent-restrictions";
import { recordAccountError } from "./db/error-log";
import { FUNNEL_ADMIN_AGENT_ID } from "./config";

/** Окно и порог правила «10 каналов banned за сутки» (общее для monitor-v2/monitor-v3). */
const RECENTLY_BANNED_WINDOW_SECONDS = 86400;
const RECENTLY_BANNED_THRESHOLD = 10;

/**
 * Пост-отправочная обвязка успешной отправки комментария к посту — заводит
 * тред, сохраняет lastSeenChannelPostId/watchedThreadRootMsgId, переводит
 * канал в статус only_comment, сохраняет отправленный ответ (saveReply).
 * `source` — тег для saveReply/логов ("monitor_v3" | "review_listener").
 */
export function applyApprovedComment(
    agentId: string,
    chatId: string,
    params: { postId: number; postText: string; comment: string; rootMsgId: number; sentMessageId: number; channelUsername?: string | null },
    log: Logger,
    source: SendErrorSource,
): void {
    createGroupThread(
        agentId,
        { chatId, startMsgId: params.rootMsgId, startMsgText: params.postText, agentMsgId: params.sentMessageId, agentMsgText: params.comment },
        log,
    );
    savePostWatchComment(agentId, chatId, { lastSeenChannelPostId: params.postId, watchedThreadRootMsgId: params.rootMsgId }, log);
    markChannelStatus(agentId, chatId, "only_comment", log);
    try {
        saveReply(agentId, { chatId, msgId: params.rootMsgId, msgText: params.postText, replyMsgId: params.sentMessageId, replyText: params.comment, channelUsername: params.channelUsername ?? null });
    } catch (saveErr: any) {
        log.warn(`[post-comment-send:${source}] saveReply failed: ${saveErr.message ?? saveErr}`);
    }
}

export type SendErrorTag = "peer_flood" | "banned" | "format_error" | "flood_deferred" | "other";

/**
 * Классифицирует ошибку отправки комментария и выполняет те же побочные
 * эффекты (agent_restrictions/channel status/send_errors), что были инлайн
 * в monitor-v3.ts sendReply — не решает за вызывающего, останавливать ли
 * прогон (PEER_FLOOD) или просто пропустить: возвращает тег, вызывающий сам
 * решает свою локальную логику управления потоком.
 */
export function handlePostCommentSendError(
    agentId: string,
    chatId: string,
    err: any,
    log: Logger,
    source: SendErrorSource,
): SendErrorTag {
    const msg = err?.message ?? String(err);
    log.warn(`[post-comment-send:${source}] отправка не удалась chatId=${chatId}: ${msg}`);
    const tag = classifyTelegramErrorTag(err);
    // Источник для журнала операций (channel-operations-history): review-listener
    // — отдельный фоновый контекст (module), остальные вызовы — мониторный.
    const journalSource: OperationSource = source === "review_listener" ? "module" : "monitor";

    if (tag === "peer_flood") {
        upsertRestriction(FUNNEL_ADMIN_AGENT_ID, agentId, "suspend", msg, 86400);
        recordAccountError(agentId, source, msg);
        return "peer_flood";
    }

    if (tag === "chat_write_forbidden" || tag === "user_banned_in_channel") {
        // channel-write-access (§4.3): переменная причина права записи —
        // CHAT_WRITE_FORBIDDEN / account_kicked. Плюс status='banned' (вход в
        // leave/rotate, R9) — прежнее поведение без изменений.
        const reason = classifySendError(tag);
        if (reason) setWriteAccessReason(agentId, chatId, reason, log);
        recordSendError(agentId, { chatId, source, errorCode: "chat_write_forbidden" }, log);
        // Причина пробрасывается в событие бана журнала операций (§6).
        markChannelStatus(agentId, chatId, "banned", log, undefined, undefined, journalSource, reason ?? undefined);

        const recentlyBanned = countRecentlyBannedChannels(agentId, RECENTLY_BANNED_WINDOW_SECONDS);
        if (recentlyBanned >= RECENTLY_BANNED_THRESHOLD) {
            upsertRestriction(FUNNEL_ADMIN_AGENT_ID, agentId, "suspend", "channels_banned", 259200);
            recordAccountError(agentId, source, "channels_banned");
        }
        return "banned";
    }

    if (tag === "allow_payment_required") {
        // channel-write-access (§2.3/§4.3): постоянная причина `paid` — канал
        // остаётся read-only, `status` НЕ трогаем (прежний 'format_error' убран).
        // Отправки дальше гейтит постоянная причина (precheck monitor-v5).
        setWriteAccessReason(agentId, chatId, "paid", log);
        return "format_error";
    }

    if (tag === "chat_send_plain_forbidden" || tag === "chat_send_media_forbidden") {
        // Запрет формата контента (№25-26) — канал сам не забанен, только
        // отклоняет способ отправки. Вне перечня причин права записи (§2.3):
        // поведение как раньше — 'format_error', причину не пишем.
        markChannelStatus(agentId, chatId, "format_error", log, undefined, undefined, journalSource);
        return "format_error";
    }

    if (parseFloodWait(err) !== null) {
        recordSendError(agentId, { chatId, source, errorCode: "flood_deferred" }, log);
        return "flood_deferred";
    }

    recordSendError(agentId, { chatId, source, errorCode: "reply_failed" }, log);
    return "other";
}
