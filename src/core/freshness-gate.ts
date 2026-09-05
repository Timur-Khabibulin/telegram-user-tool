// core/freshness-gate.ts — гейт свежести поста (post-freshness-gate, monitor-v2).
//
// Чистая функция без прямой зависимости от Telegram/БД (зависимости
// инъецируются, как Logger в остальном ядре) — реализует шаги 2-5 алгоритма
// `docs/design/post-freshness-gate/requirements-v1.md`, раздел 5.

import {
    POST_FRESHNESS_FIRST_COMMENT_MAX_AGE_SECONDS,
    POST_FRESHNESS_CONTINUATION_MAX_AGE_SECONDS,
} from "./config";

export interface FreshnessGateDeps {
    getCachedPostDate(chatId: string, topMsgId: number): number | null;
    /** Сеть + запись в кэш при успехе; null при неудаче (сообщение обрабатывается как date_unresolved). */
    fetchAndCachePostDate(chatId: string, topMsgId: number): Promise<number | null>;
}

export type GateOutcome =
    | { pass: true; rule: "R1" | "R2" }
    | { pass: false; rule: "R3"; reason: "no_thread" | "date_unresolved" | "stale" };

export interface FreshnessGateMessage {
    chatId: string;
    /** Собственная дата сообщения (unix-секунды) — используется для случая B. */
    date: number;
    /** Случай A алгоритма: id корневого сообщения ветки. */
    replyToTopId?: number;
    /** Случай B алгоритма: сообщение само — служебная копия поста. */
    isChannelPost?: boolean;
}

export async function evaluateFreshness(
    deps: FreshnessGateDeps,
    msg: FreshnessGateMessage,
    isContinuation: boolean,
    nowSec: number,
): Promise<GateOutcome> {
    let postDate: number;

    if (msg.isChannelPost === true) {
        // Случай B: дата берётся из собственного поля сообщения, без запроса к
        // Telegram и без записи в кеш (требования, раздел 5, шаг 4).
        postDate = msg.date;
    } else if (msg.replyToTopId !== undefined) {
        // Случай A: кеш по (chatId, replyToTopId), при промахе — один запрос.
        const cached = deps.getCachedPostDate(msg.chatId, msg.replyToTopId);
        if (cached !== null) {
            postDate = cached;
        } else {
            const fetched = await deps.fetchAndCachePostDate(msg.chatId, msg.replyToTopId);
            if (fetched === null) {
                return { pass: false, rule: "R3", reason: "date_unresolved" };
            }
            postDate = fetched;
        }
    } else {
        // Ни привязки к ветке, ни признака служебной копии — шаг 3 требований.
        return { pass: false, rule: "R3", reason: "no_thread" };
    }

    if (isContinuation) {
        // R2 — нестрогое неравенство («не больше 4 дней»).
        if (nowSec - postDate <= POST_FRESHNESS_CONTINUATION_MAX_AGE_SECONDS) {
            return { pass: true, rule: "R2" };
        }
        return { pass: false, rule: "R3", reason: "stale" };
    }

    // R1 — строгое неравенство («менее 24 часов»).
    if (nowSec - postDate < POST_FRESHNESS_FIRST_COMMENT_MAX_AGE_SECONDS) {
        return { pass: true, rule: "R1" };
    }
    return { pass: false, rule: "R3", reason: "stale" };
}
