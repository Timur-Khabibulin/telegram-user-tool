// scripts/periodic/review-listener.ts — персистентный слушатель ревью-гейта
// (post-comment-review). Один процесс на всю платформу — единственный
// потребитель getUpdates общего Bot API-бота (design.md решение 2), не по
// таймеру, запускается как persistent systemd-сервис (Restart=always).
//
// На каждое нажатие «Да»/«Нет» в чате ревьюеров: поднимает нужного агента по
// agentId из callback_data (design.md решение 2 — принадлежность агенту
// определяется данными, не тем, какой бот прислал сообщение), и либо
// отправляет комментарий (открывая новое MTProto-соединение специально под
// этот один чат — design.md решение 4), либо помечает пост просмотренным
// без отправки. Идемпотентно: строка pending_reviews с status !== 'pending'
// повторно не обрабатывается — защита от повторной доставки апдейта Telegram
// после рестарта процесса (offset не персистится между рестартами, это
// осознанно допустимый компромисс — см. design.md, Non-Goals).

import type { Logger } from "../../core/logger";
import { TelegramService } from "../../core/telegram/service";
import { ClientNotConnectedError } from "../../core/telegram/errors";
import { withFloodRetry, FloodAbortError } from "../../skills/util";
import { getPendingReview, resolvePendingReview, type PendingReviewRow } from "../../core/db/pending-reviews";
import { markPostSeen, getChatAccessHash, getChatTitlesAndUsernames } from "../../core/db/channels";
import { applyApprovedComment, handlePostCommentSendError } from "../../core/post-comment-send";
import {
    getReviewCallbackUpdates,
    editReviewMessageOutcome,
    answerCallbackQuery,
    type ReviewCallback,
} from "../../core/review-bot-api";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const POLL_ERROR_BACKOFF_MS = 5000;

async function handleApprove(cb: ReviewCallback, review: PendingReviewRow): Promise<void> {
    const tg = new TelegramService(log);
    try {
        tg.loadAccount(cb.agentId);
    } catch (err: any) {
        log.error(`[review-listener] loadAccount failed for agentId=${cb.agentId}: ${err?.message ?? err}`);
        await answerCallbackQuery(cb.callbackQueryId, log, "Ошибка: не удалось загрузить аккаунт агента").catch(() => {});
        return;
    }

    try {
        const accessHash = getChatAccessHash(cb.agentId, review.chatId, log);
        if (!accessHash) {
            log.error(`[review-listener] chatAccessHash не найден для agentId=${cb.agentId} chatId=${review.chatId}`);
            await answerCallbackQuery(cb.callbackQueryId, log, "Ошибка: нет данных о чате, попробуйте позже").catch(() => {});
            return;
        }
        tg.seedPeerCache(review.chatId, accessHash);

        let sent: { messageId: number };
        try {
            sent = await withFloodRetry(() => tg.replyToMessage(review.chatId, review.rootMsgId, review.comment), log);
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                log.error(`[review-listener] repeated FLOOD_WAIT reviewId=${cb.reviewId}`);
                await answerCallbackQuery(cb.callbackQueryId, log, "Ошибка отправки (FLOOD_WAIT) — попробуйте ещё раз").catch(() => {});
                return; // временная причина — статус остаётся pending, кнопки живы для повтора
            }
            if (err instanceof ClientNotConnectedError) {
                await answerCallbackQuery(cb.callbackQueryId, log, "Ошибка соединения — попробуйте ещё раз").catch(() => {});
                return; // временная причина — статус остаётся pending
            }

            const tag = handlePostCommentSendError(cb.agentId, review.chatId, err, log, "review_listener");
            if (tag === "banned" || tag === "format_error") {
                // Постоянная причина — повтор бессмысленен (канал уже забанен/
                // запрещён формат). Разрешаем ту же обработку, что и «Нет»:
                // пост помечается просмотренным, кнопки убираются, чтобы не
                // приглашать на бесполезный повторный клик.
                markPostSeen(cb.agentId, review.chatId, review.postId, log);
                resolvePendingReview(cb.agentId, cb.reviewId, "rejected", log);
                await editReviewMessageOutcome(cb.messageId, `⚠️ Не удалось отправить (канал недоступен: ${tag}) — отмечено как отклонённое\n\n${review.postText}`, log)
                    .catch((editErr: any) => log.warn(`[review-listener] editReviewMessageOutcome failed: ${editErr?.message ?? editErr}`));
                await answerCallbackQuery(cb.callbackQueryId, log).catch(() => {});
                return;
            }

            // flood_deferred / other — временная причина, статус остаётся
            // pending, кнопки живы для повтора (сбой отправки не продвигает
            // lastSeenChannelPostId — тот же приём, что в monitor-v3).
            await answerCallbackQuery(cb.callbackQueryId, log, "Ошибка отправки — попробуйте ещё раз").catch(() => {});
            return;
        }

        const chatInfo = getChatTitlesAndUsernames(cb.agentId, [review.chatId]).get(review.chatId);
        applyApprovedComment(
            cb.agentId,
            review.chatId,
            { postId: review.postId, postText: review.postText, comment: review.comment, rootMsgId: review.rootMsgId, sentMessageId: sent.messageId, channelUsername: chatInfo?.chatUsername ?? null },
            log,
            "review_listener",
        );
        resolvePendingReview(cb.agentId, cb.reviewId, "approved", log);
        await editReviewMessageOutcome(cb.messageId, `✅ Отправлено\n\n${review.postText}\n\n${review.comment}`, log)
            .catch((err: any) => log.warn(`[review-listener] editReviewMessageOutcome failed: ${err?.message ?? err}`));
        await answerCallbackQuery(cb.callbackQueryId, log).catch(() => {});
    } finally {
        await tg.disconnect();
    }
}

async function handleReject(cb: ReviewCallback, review: PendingReviewRow): Promise<void> {
    markPostSeen(cb.agentId, review.chatId, review.postId, log);
    resolvePendingReview(cb.agentId, cb.reviewId, "rejected", log);
    await editReviewMessageOutcome(cb.messageId, `❌ Отклонено\n\n${review.postText}`, log)
        .catch((err: any) => log.warn(`[review-listener] editReviewMessageOutcome failed: ${err?.message ?? err}`));
    await answerCallbackQuery(cb.callbackQueryId, log).catch(() => {});
}

async function handleCallback(cb: ReviewCallback): Promise<void> {
    const review = getPendingReview(cb.agentId, cb.reviewId, log);
    if (!review || review.status !== "pending") {
        // Не найдено, либо уже решено раньше — идемпотентность на повторную
        // доставку апдейта (см. шапку файла).
        await answerCallbackQuery(cb.callbackQueryId, log).catch(() => {});
        return;
    }

    if (cb.decision === "yes") {
        await handleApprove(cb, review);
    } else {
        await handleReject(cb, review);
    }
}

async function main(): Promise<void> {
    log.info("[review-listener] started");
    let offset = 0;

    for (;;) {
        let callbacks: ReviewCallback[] = [];
        try {
            const result = await getReviewCallbackUpdates(offset, log);
            offset = result.nextOffset;
            callbacks = result.callbacks;
        } catch (err: any) {
            log.error(`[review-listener] poll failed: ${err?.message ?? err}`);
            await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
            continue;
        }

        for (const cb of callbacks) {
            try {
                await handleCallback(cb);
            } catch (err: any) {
                log.error(`[review-listener] handleCallback failed reviewId=${cb.reviewId} agentId=${cb.agentId}: ${err?.message ?? err}`);
            }
        }
    }
}

main().catch((err) => {
    log.error(`[review-listener] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
