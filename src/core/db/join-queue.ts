// core/db/join-queue.ts — очередь каналов для вступления в discussion-группы.
//
// Перенесено из прежнего join-queue-db.ts: тела инструментов превращены в обычные
// функции без TypeBox и без формата { content: [...] }. Логирование инжектируется
// через Logger (DIP).
//
// Статусная модель telegram-error-handling (заменяет прежнюю — там всё было
// наоборот: error ретраился автоматически до MAX_ATTEMPTS раз, skipped был
// постоянным статусом, снимался только вручную resetSkippedToPending):
//
//   pending ──get_batch──► processing ──update("joined")──► joined
//                │                    └──update("skipped")─► skipped
//                │                    └──update("error")──► error
//                │                    └──timeout reset──────► pending
//   skipped ──перед каждым следующим батчем──► pending (автоматически)
//   error ── не ретраится автоматически, снимается только вручную
//
//  pending:    ожидает обработки (начальное состояние)
//  processing: взят в батч; если запись не обновлена дольше
//              PROCESSING_TIMEOUT_SECONDS — сбрасывается обратно в pending
//  joined:     успешно вступили (финальный)
//  skipped:    временная причина отказа (флуд после исчерпания повторов,
//              CHANNELS_TOO_MUCH) — перед взятием каждого следующего батча
//              автоматически переводится обратно в pending
//  error:      постоянная причина отказа (канал непригоден для вступления
//              независимо от повторных попыток) — не ретраится, снимается
//              только вручную человеком

import Database from "better-sqlite3";
import { joinQueueDbPath } from "../config";
import type { Logger } from "../logger";

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_BATCH_LIMIT = 15;
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

            // skipped — временная причина отказа: возвращается в pending перед
            // каждым следующим батчем (telegram-error-handling).
            const unskip = db.prepare(`
                UPDATE join_queue SET status = 'pending', updatedAt = ? WHERE status = 'skipped'
            `).run(now);
            if (unskip.changes > 0) {
                log.info(`[tg-join-queue] get_batch — ${unskip.changes} skipped entries returned to pending`);
            }

            // Забрать следующий батч. error — постоянная причина отказа, не
            // ретраится автоматически (telegram-error-handling).
            const rows = db.prepare(`
                SELECT link FROM join_queue
                WHERE status = 'pending'
                ORDER BY updatedAt ASC
                LIMIT ?
            `).all(limit) as { link: string }[];

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

/** Ссылки каналов, в которые агент успешно вступил (status='joined') — для backfill реестра discovery. */
export function getJoinedLinks(agentId: string, log: Logger): string[] {
    log.info(`[tg-join-queue] tg_join_queue_joined_links — agentId=${agentId}`);
    const db = openDb(joinQueueDbPath(agentId));
    try {
        ensureTable(db);
        const rows = db.prepare(`SELECT link FROM join_queue WHERE status = 'joined'`).all() as { link: string }[];
        return rows.map((r) => r.link);
    } finally {
        db.close();
    }
}

export interface JoinedLinkRow {
    link: string;
    updatedAt: number;
}

/**
 * Ссылки со `status='joined'` вместе со временем простановки статуса
 * (channel-not-found-recovery, разовая миграция cat4/cat7) — момент
 * `updatedAt` нужен, чтобы отличить залипший `leaved_manual` (выставлен ДО
 * повторного `joined`) от легитимного более позднего статуса.
 */
export function getJoinedLinksWithTimestamps(agentId: string, log: Logger): JoinedLinkRow[] {
    const db = openDb(joinQueueDbPath(agentId));
    try {
        ensureTable(db);
        const rows = db.prepare(`SELECT link, updatedAt FROM join_queue WHERE status = 'joined'`).all() as JoinedLinkRow[];
        log.info(`[tg-join-queue] getJoinedLinksWithTimestamps — agentId=${agentId} returned=${rows.length}`);
        return rows;
    } finally {
        db.close();
    }
}

/**
 * Разовая миграция (channel-not-found-recovery, cat7): переводит перечисленные
 * `joined`-ссылки обратно в `pending` — для каналов, у которых нет строки в
 * `channels.db` того же агента (потеряны прежним `DELETE` в `syncChannels`).
 * Повторное вступление подхватит их новой self-heal логикой
 * (`USER_ALREADY_PARTICIPANT` → успех). Идемпотентно: ссылки не в `joined`
 * этим вызовом не затрагиваются.
 */
export function requeueJoinedLinks(agentId: string, links: string[], log: Logger): { requeued: number } {
    if (links.length === 0) return { requeued: 0 };
    const db = openDb(joinQueueDbPath(agentId));
    try {
        ensureTable(db);
        const now = Math.floor(Date.now() / 1000);
        const placeholders = links.map(() => "?").join(",");
        const result = db.prepare(`
            UPDATE join_queue SET status = 'pending', updatedAt = ?
            WHERE status = 'joined' AND link IN (${placeholders})
        `).run(now, ...links);
        log.info(`[tg-join-queue] requeueJoinedLinks — agentId=${agentId} requeued=${result.changes}`);
        return { requeued: result.changes };
    } finally {
        db.close();
    }
}

/**
 * Разовый бэкфилл (flood-wait-detection, design.md Migration Plan): сбрасывает все
 * `status='skipped'` обратно в `pending` с `attempts=0` — ссылки проходят повторную
 * обработку через уже исправленную flood-детекцию вместо того, чтобы оставаться
 * помеченными пропущенными навсегда из-за старого бага классификации. Идемпотентно
 * (повторный вызов просто даёт ещё одну попытку уже осевшим обратно в skipped
 * строкам), но не бесплатно — вызывать один раз после деплоя фикса, не по расписанию
 * (см. `scripts/join-queue-backfill.ts`).
 */
export function resetSkippedToPending(agentId: string, log: Logger): { reset: number } {
    const db = openDb(joinQueueDbPath(agentId));
    try {
        ensureTable(db);
        const result = db.prepare(`UPDATE join_queue SET status = 'pending', attempts = 0 WHERE status = 'skipped'`).run();
        log.info(`[tg-join-queue] resetSkippedToPending — agentId=${agentId} reset=${result.changes}`);
        return { reset: result.changes };
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
