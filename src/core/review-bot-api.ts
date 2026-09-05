// core/review-bot-api.ts — минимальный клиент Telegram Bot API для ручного
// ревью комментариев (post-comment-review, design.md решение 11).
//
// Единственный модуль в проекте, вызывающий Bot API. sendReviewMessage/
// editReviewMessageOutcome НЕ принимают chatId как параметр — всегда шлют в
// захардкоженный TELEGRAM_REVIEW_CHAT_ID из конфига; других вызывающих путей
// к api.telegram.org быть не должно. getReviewCallbackUpdates — единственный
// long-poll на бота во всём проекте (его вызывает только review-listener.ts,
// design.md решение 2) и фильтрует апдейты по default-deny: возвращает
// только callback_query из TELEGRAM_REVIEW_CHAT_ID, всё остальное молча
// отбрасывается здесь же, до вызывающего кода.

import { TELEGRAM_REVIEW_BOT_TOKEN, TELEGRAM_REVIEW_CHAT_ID } from "./config";
import type { Logger } from "./logger";

export interface SentReviewMessage {
    messageId: number;
}

export interface ReviewCallback {
    updateId: number;
    callbackQueryId: string;
    messageId: number;
    agentId: string;
    reviewId: number;
    decision: "yes" | "no";
}

function requireConfig(): { token: string; chatId: string } {
    if (!TELEGRAM_REVIEW_BOT_TOKEN || !TELEGRAM_REVIEW_CHAT_ID) {
        throw new Error("TELEGRAM_REVIEW_BOT_TOKEN/TELEGRAM_REVIEW_CHAT_ID не заданы в окружении (~/.openclaw/secrets.env)");
    }
    return { token: TELEGRAM_REVIEW_BOT_TOKEN, chatId: TELEGRAM_REVIEW_CHAT_ID };
}

/**
 * Вызывает метод Bot API. Логирует только имя метода и статус ответа —
 * НИКОГДА полный URL или тело запроса: токен закодирован прямо в пути
 * запроса (`api.telegram.org/bot<TOKEN>/...`), логирование URL целиком
 * утекло бы токен в journald (design.md решение 11).
 */
async function callBotApi<T>(method: string, body: Record<string, unknown>, log: Logger): Promise<T> {
    const { token } = requireConfig();
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => null);
    log.info(`[review-bot-api] ${method} — status=${res.status} ok=${json?.ok ?? false}`);
    if (!res.ok || !json?.ok) {
        throw new Error(`Bot API ${method} failed: status=${res.status} description=${json?.description ?? "unknown"}`);
    }
    return json.result as T;
}

/** callback_data — "<agentId>:<reviewId>:<yes|no>", разбирается parseCallbackData ниже. */
function buildCallbackData(agentId: string, reviewId: number, decision: "yes" | "no"): string {
    return `${agentId}:${reviewId}:${decision}`;
}

function parseCallbackData(data: string): { agentId: string; reviewId: number; decision: "yes" | "no" } | null {
    const parts = data.split(":");
    if (parts.length !== 3) return null;
    const [agentId, reviewIdRaw, decisionRaw] = parts;
    const reviewId = Number(reviewIdRaw);
    if (!agentId || !Number.isInteger(reviewId) || (decisionRaw !== "yes" && decisionRaw !== "no")) return null;
    return { agentId, reviewId, decision: decisionRaw };
}

/**
 * Отправляет запрос на ревью в чат ревьюеров с кнопками «Да»/«Нет».
 * `text` уже полностью сформирован вызывающим (пост, оценка LLM, комментарий,
 * agentId/канал — post-comment-review spec) — этот модуль про транспорт, не
 * про формат сообщения.
 */
export async function sendReviewMessage(
    agentId: string,
    reviewId: number,
    text: string,
    log: Logger,
): Promise<SentReviewMessage> {
    const { chatId } = requireConfig();
    const result = await callBotApi<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: {
            inline_keyboard: [[
                { text: "✅ Да", callback_data: buildCallbackData(agentId, reviewId, "yes") },
                { text: "❌ Нет", callback_data: buildCallbackData(agentId, reviewId, "no") },
            ]],
        },
    }, log);
    return { messageId: result.message_id };
}

/**
 * Отправляет информационное сообщение в чат ревьюеров без кнопок (monitor-v4,
 * автоотправка без апрува) — комментарий уже отправлен в канал, это только
 * уведомление постфактум, не запрос решения.
 */
export async function sendNotifyMessage(text: string, log: Logger): Promise<SentReviewMessage> {
    const { chatId } = requireConfig();
    const result = await callBotApi<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text,
    }, log);
    return { messageId: result.message_id };
}

/** Убирает кнопки и показывает итог решения на уже отправленном сообщении ревью. */
export async function editReviewMessageOutcome(messageId: number, text: string, log: Logger): Promise<void> {
    const { chatId } = requireConfig();
    await callBotApi("editMessageText", { chat_id: chatId, message_id: messageId, text }, log);
}

/**
 * Снимает состояние ожидания с нажатой кнопки (обязательный ответ Bot API на
 * callback_query). `alertText`, если задан, показывается нажавшему всплывающим
 * тостом (например, при ошибке отправки — кнопки при этом не убираются,
 * можно нажать повторно).
 */
export async function answerCallbackQuery(callbackQueryId: string, log: Logger, alertText?: string): Promise<void> {
    await callBotApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(alertText ? { text: alertText, show_alert: true } : {}),
    }, log);
}

/**
 * Long-poll апдейтов (таймаут 30с на стороне Telegram). Возвращает следующий
 * offset (нужно передать в следующий вызов, иначе Telegram будет повторно
 * присылать те же апдейты) и уже отфильтрованный список валидных callback'ов
 * ревью: не из чата ревьюеров, не callback_query, или не парсящийся
 * `callback_data` — молча отброшены (default-deny, design.md решение 11).
 */
export async function getReviewCallbackUpdates(
    offset: number,
    log: Logger,
): Promise<{ nextOffset: number; callbacks: ReviewCallback[] }> {
    const { chatId } = requireConfig();
    const updates = await callBotApi<any[]>("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["callback_query"],
    }, log);

    let nextOffset = offset;
    const callbacks: ReviewCallback[] = [];
    for (const update of updates) {
        nextOffset = Math.max(nextOffset, update.update_id + 1);

        const cq = update.callback_query;
        if (!cq?.data || !cq.message?.chat) continue; // не callback_query — игнор
        if (String(cq.message.chat.id) !== String(chatId)) continue; // не из чата ревьюеров — игнор

        const parsed = parseCallbackData(cq.data);
        if (!parsed) continue; // не наш формат — игнор

        callbacks.push({
            updateId: update.update_id,
            callbackQueryId: cq.id,
            messageId: cq.message.message_id,
            agentId: parsed.agentId,
            reviewId: parsed.reviewId,
            decision: parsed.decision,
        });
    }
    return { nextOffset, callbacks };
}
