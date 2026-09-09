// core/distribution-bot-api.ts — минимальный клиент Telegram Bot API для бота
// распределения каналов (channel-distribution). Отдельный bot-токен от
// review-бота: Telegram допускает один long-poll getUpdates на токен.
//
// getDistributionUpdates — единственный long-poll на этот бот (его вызывает
// только distribution-listener.ts). Авторизация по чату (R18, default-deny):
// возвращаются только сообщения из CHANNEL_DISTRIBUTION_CHAT_ID, всё прочее молча
// отбрасывается здесь же, до вызывающего кода. sendDistributionMessage не
// принимает chatId — всегда шлёт в тот же уполномоченный чат.

import { CHANNEL_DISTRIBUTION_BOT_TOKEN, CHANNEL_DISTRIBUTION_CHAT_ID } from "./config";
import type { Logger } from "./logger";

export interface DistributionDocument {
    fileId: string;
    fileName: string;
    fileSize: number;
}

export interface DistributionMessage {
    updateId: number;
    chatId: string;
    fromId: string;
    /** Текст сообщения или подпись к документу (команда, набор агентов); null, если нет. */
    text: string | null;
    /** Приложенный документ (CSV), если есть. */
    document: DistributionDocument | null;
}

function requireConfig(): { token: string; chatId: string } {
    if (!CHANNEL_DISTRIBUTION_BOT_TOKEN || !CHANNEL_DISTRIBUTION_CHAT_ID) {
        throw new Error(
            "CHANNEL_DISTRIBUTION_BOT_TOKEN/CHANNEL_DISTRIBUTION_CHAT_ID не заданы в окружении (~/.openclaw/secrets.env)",
        );
    }
    return { token: CHANNEL_DISTRIBUTION_BOT_TOKEN, chatId: CHANNEL_DISTRIBUTION_CHAT_ID };
}

/**
 * Вызывает метод Bot API. Логирует только имя метода и статус — НИКОГДА полный
 * URL или тело: токен закодирован прямо в пути запроса, логирование URL целиком
 * утекло бы токен в journald (тот же приём, что review-bot-api).
 */
async function callBotApi<T>(method: string, body: Record<string, unknown>, log: Logger): Promise<T> {
    const { token } = requireConfig();
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json: { ok?: boolean; result?: unknown; description?: string } | null = await res.json().catch(() => null);
    log.info(`[distribution-bot-api] ${method} — status=${res.status} ok=${json?.ok ?? false}`);
    if (!res.ok || !json?.ok) {
        throw new Error(`Bot API ${method} failed: status=${res.status} description=${json?.description ?? "unknown"}`);
    }
    return json.result as T;
}

/** Отправляет текстовое сообщение в уполномоченный чат (статус, сводка, отказы). */
export async function sendDistributionMessage(text: string, log: Logger): Promise<void> {
    const { chatId } = requireConfig();
    await callBotApi("sendMessage", { chat_id: chatId, text }, log);
}

/**
 * Long-poll апдейтов (таймаут 30с). Возвращает следующий offset и уже
 * отфильтрованный список сообщений из уполномоченного чата (R18, default-deny):
 * сообщения из другого чата или без message молча отброшены.
 */
export async function getDistributionUpdates(
    offset: number,
    log: Logger,
): Promise<{ nextOffset: number; messages: DistributionMessage[] }> {
    const { chatId } = requireConfig();
    const updates = await callBotApi<RawUpdate[]>("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
    }, log);

    let nextOffset = offset;
    const messages: DistributionMessage[] = [];
    for (const update of updates) {
        nextOffset = Math.max(nextOffset, update.update_id + 1);

        const msg = update.message;
        if (!msg?.chat) continue; // не message — игнор
        if (String(msg.chat.id) !== String(chatId)) continue; // не уполномоченный чат — игнор

        const document: DistributionDocument | null = msg.document
            ? {
                  fileId: msg.document.file_id,
                  fileName: msg.document.file_name ?? "upload.csv",
                  fileSize: msg.document.file_size ?? 0,
              }
            : null;

        messages.push({
            updateId: update.update_id,
            chatId: String(msg.chat.id),
            fromId: msg.from ? String(msg.from.id) : "",
            text: msg.text ?? msg.caption ?? null,
            document,
        });
    }
    return { nextOffset, messages };
}

/**
 * Скачивает документ по fileId: getFile → путь на стороне Telegram → загрузка
 * файла. Возвращает содержимое как Buffer (вызывающий сохраняет на диск и
 * декодирует как UTF-8). URL загрузки содержит токен — не логируется.
 */
export async function downloadDocument(fileId: string, log: Logger): Promise<Buffer> {
    const { token } = requireConfig();
    const file = await callBotApi<{ file_path?: string }>("getFile", { file_id: fileId }, log);
    if (!file.file_path) throw new Error("getFile не вернул file_path");
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Скачивание файла не удалось: status=${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    log.info(`[distribution-bot-api] downloadDocument — bytes=${arrayBuffer.byteLength}`);
    return Buffer.from(arrayBuffer);
}

// ─── Сырые типы апдейта Bot API (сужаются в getDistributionUpdates) ────

interface RawUpdate {
    update_id: number;
    message?: RawMessage;
}

interface RawMessage {
    chat?: { id: number | string };
    from?: { id: number | string };
    text?: string;
    caption?: string;
    document?: { file_id: string; file_name?: string; file_size?: number };
}
