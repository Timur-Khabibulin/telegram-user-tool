// core/db/join-queue.ts — очередь каналов для вступления в discussion-группы.
//
// Перенесено из прежнего join-queue-db.ts: тела инструментов превращены в обычные
// функции без TypeBox и без формата { content: [...] }. Поведение, схема и
// status-модель сохранены (R-B2). Логирование инжектируется через Logger (DIP).
//
//   pending ──get_batch──► processing ──update("joined")──► joined
//                │                    └──update("skipped")─► skipped
//                │                    └──update("error")──► error
//                │                    └──timeout reset──────► pending
//   error ──get_batch (attempts < MAX_ATTEMPTS)──► processing
//
//  pending:    ожидает обработки (начальное состояние)
//  processing: взят в батч; если запись не обновлена дольше
//              PROCESSING_TIMEOUT_SECONDS — сбрасывается обратно в pending
//  joined:     успешно вступили (финальный)
//  skipped:    пропущен навсегда — приватный канал, нет discussion group и т.п.
//  error:      временная ошибка; повтор до MAX_ATTEMPTS раз, затем остаётся error

import Database from "better-sqlite3";
import { joinQueueDbPath } from "../config";
import type { Logger } from "../logger";

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_BATCH_LIMIT = 15;
const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_SECONDS = 3600;

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(dbPath: string): Database.Database {
    return new Database(dbPath);
}

function ensureTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS join_queue (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            link      TEXT    NOT NULL UNIQUE,
            status    TEXT    NOT NULL DEFAULT 'pending',
            attempts  INTEGER NOT NULL DEFAULT 0,
            lastError TEXT,
            updatedAt INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_join_queue_status
            ON join_queue(status, updatedAt ASC);
    `);
}

// ─── API ──────────────────────────────────────────────────────────────

export function addJoinQueue(agentId: string, links: string[], log: Logger): { ok: true; added: number; skipped: number } {
    log.info(`[tg-join-queue] tg_join_queue_add — agentId=${agentId} links=${links.length}`);
    const db = openDb(joinQueueDbPath(agentId));
    try {
        ensureTable(db);
        const now = Math.floor(Date.now() / 1000);
        const stmt = db.prepare(`INSERT OR IGNORE INTO join_queue (link, status, updatedAt) VALUES (?, 'pending', ?)`);
        let added = 0;
        db.transaction(() => {
            for (const link of links) {
                const result = stmt.run(link.trim(), now);
                if (result.changes > 0) added++;
            }
        })();
        const skipped = links.length - added;
        log.info(`[tg-join-queue] tg_join_queue_add — added=${added} skipped=${skipped}`);
        return { ok: true, added, skipped };
    } finally {
        db.close();
    }
}

export function getJoinQueueBatch(agentId: string, log: Logger, limit = DEFAULT_BATCH_LIMIT): { links: string[] } {
    log.info(`[tg-join-queue] tg_join_queue_get_batch — agentId=${agentId} limit=${limit}`);
    const db = openDb(joinQueueDbPath(agentId));
    try {
        ensureTable(db);
        const now = Math.floor(Date.now() / 1000);
        const staleThreshold = now - PROCESSING_TIMEOUT_SECONDS;

        const batch = db.transaction(() => {
            // Сбросить зависшие processing-записи
            const reset = db.prepare(`
                UPDATE join_queue
                SET status = 'pending', updatedAt = ?
                WHERE status = 'processing' AND updatedAt < ?
            `).run(now, staleThreshold);
            if (reset.changes > 0) {
                log.warn(`[tg-join-queue] get_batch — reset ${reset.changes} stale processing entries`);
            }

            // Забрать следующий батч
            const rows = db.prepare(`
                SELECT link FROM join_queue
                WHERE status = 'pending'
                   OR (status = 'error' AND attempts < ?)
                ORDER BY updatedAt ASC
                LIMIT ?
            `).all(MAX_ATTEMPTS, limit) as { link: string }[];

            if (rows.length > 0) {
                const placeholders = rows.map(() => "?").join(",");
                db.prepare(`
                    UPDATE join_queue
                    SET status = 'processing', updatedAt = ?
                    WHERE link IN (${placeholders})
                `).run(now, ...rows.map((r) => r.link));
            }

            return rows;
        })();

        log.info(`[tg-join-queue] tg_join_queue_get_batch — claimed ${batch.length} links`);
        return { links: batch.map((r) => r.link) };
    } finally {
        db.close();
    }
}

export function updateJoinQueue(
    agentId: string,
    link: string,
    status: "joined" | "skipped" | "error",
    error: string | undefined,
    log: Logger,
): { ok: true } {
    log.info(`[tg-join-queue] tg_join_queue_update — link=${link} status=${status}`);
    const db = openDb(joinQueueDbPath(agentId));
    try {
        ensureTable(db);
        const now = Math.floor(Date.now() / 1000);
        db.prepare(`
            UPDATE join_queue
            SET status = ?, attempts = attempts + 1, lastError = ?, updatedAt = ?
            WHERE link = ?
        `).run(status, error ?? null, now, link);
        return { ok: true };
    } finally {
        db.close();
    }
}

export function joinQueueStats(agentId: string, log: Logger): Record<string, number> {
    const db = openDb(joinQueueDbPath(agentId));
    try {
        ensureTable(db);
        const rows = db.prepare(`
            SELECT status, COUNT(*) as count FROM join_queue GROUP BY status
        `).all() as { status: string; count: number }[];
        const stats = Object.fromEntries(rows.map((r) => [r.status, r.count]));
        log.info(`[tg-join-queue] tg_join_queue_stats — ${JSON.stringify(stats)}`);
        return stats;
    } finally {
        db.close();
    }
}
