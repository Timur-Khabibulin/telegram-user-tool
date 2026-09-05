// core/db/pending-reviews.ts — очередь ручного подтверждения комментариев
// перед отправкой (post-comment-review).
//
// Одна строка на пост, поставленный на ревью. Статус меняется на месте
// (pending → approved/rejected) — отдельного append-only лога решений не
// заводим: оценка LLM уже лежит в той же строке, а решение и время решения
// пишутся туда же (design.md, решение 10) — обновление статуса безусловно,
// независимо от исхода. Без TTL/авто-expiry (design.md, Non-Goals) — строка
// без решения остаётся pending бессрочно.

import Database from "better-sqlite3";
import { pendingReviewsDbPath } from "../config";
import type { Logger } from "../logger";

export type PendingReviewStatus = "pending" | "approved" | "rejected";

export interface PendingReviewRow {
    id: number;
    chatId: string;
    postId: number;
    postText: string;
    /** Числовая оценка LLM — generatePostCommentV2 (score, больше не активна) или generatePostCommentV4 (оценка 0-4, monitor-v4-comment-signal); nullable, generatePostCommentV3 её не даёт. */
    llmScore: number | null;
    llmAxes: string | null;
    /** generatePostCommentV3: тип поста (история/мнение/новость); generatePostCommentV4 (monitor-v4-comment-signal): главное мнение аудитории — nullable, поле переиспользуется между версиями промпта, не привязано к одной схеме. */
    llmType: string | null;
    comment: string;
    rootMsgId: number;
    status: PendingReviewStatus;
    createdAt: number;
    resolvedAt: number | null;
}

function openDb(agentId: string): Database.Database {
    const db = new Database(pendingReviewsDbPath(agentId));
    ensureTable(db);
    return db;
}

function ensureTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS pending_reviews (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId     TEXT    NOT NULL,
            postId     INTEGER NOT NULL,
            postText   TEXT    NOT NULL,
            llmScore   REAL,
            llmAxes    TEXT,
            llmType    TEXT,
            comment    TEXT    NOT NULL,
            rootMsgId  INTEGER NOT NULL,
            status     TEXT    NOT NULL DEFAULT 'pending',
            createdAt  INTEGER NOT NULL,
            resolvedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pending_reviews_status ON pending_reviews(status);
    `);
}

/** Ставит пост в очередь на ревью (monitor-v3, review-gate включён). Возвращает id строки — идёт в callback_data кнопок. */
export function insertPendingReview(
    agentId: string,
    record: {
        chatId: string;
        postId: number;
        postText: string;
        llmScore?: number;
        llmAxes?: string;
        llmType?: string;
        comment: string;
        rootMsgId: number;
    },
    log: Logger,
): number {
    const db = openDb(agentId);
    try {
        const result = db.prepare(`
            INSERT INTO pending_reviews (chatId, postId, postText, llmScore, llmAxes, llmType, comment, rootMsgId, status, createdAt)
            VALUES (@chatId, @postId, @postText, @llmScore, @llmAxes, @llmType, @comment, @rootMsgId, 'pending', @createdAt)
        `).run({
            chatId: record.chatId,
            postId: record.postId,
            postText: record.postText,
            llmScore: record.llmScore ?? null,
            llmAxes: record.llmAxes ?? null,
            llmType: record.llmType ?? null,
            comment: record.comment,
            rootMsgId: record.rootMsgId,
            createdAt: Math.floor(Date.now() / 1000),
        });
        const id = Number(result.lastInsertRowid);
        log.info(`[pending-reviews] insertPendingReview — agentId=${agentId} id=${id} chatId=${record.chatId}`);
        return id;
    } finally {
        db.close();
    }
}

/** Читает строку по id (review-listener, после callback_query). agentId уже известен вызывающему — раскладка по агентам через отдельные БД (per-agent), не через колонку. */
export function getPendingReview(agentId: string, id: number, log: Logger): PendingReviewRow | null {
    const db = openDb(agentId);
    try {
        const row = db.prepare(`SELECT * FROM pending_reviews WHERE id = ?`).get(id) as PendingReviewRow | undefined;
        if (!row) log.warn(`[pending-reviews] getPendingReview — agentId=${agentId} id=${id} не найден`);
        return row ?? null;
    } finally {
        db.close();
    }
}

/** Безусловно фиксирует решение человека (Да → approved, Нет → rejected) — design.md решение 10. */
export function resolvePendingReview(agentId: string, id: number, status: "approved" | "rejected", log: Logger): void {
    const db = openDb(agentId);
    try {
        db.prepare(`
            UPDATE pending_reviews SET status = @status, resolvedAt = @resolvedAt WHERE id = @id
        `).run({ status, resolvedAt: Math.floor(Date.now() / 1000), id });
        log.info(`[pending-reviews] resolvePendingReview — agentId=${agentId} id=${id} status=${status}`);
    } finally {
        db.close();
    }
}
