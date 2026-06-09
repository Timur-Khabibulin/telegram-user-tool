// core/db/funnel.ts — хранилище воронки (funnel-tracking).
//
// Две таблицы в ~/.openclaw/workspace-<adminAgentId>/funnel.db:
//   • channel_snapshots — сырые снапшоты метрик каналов (по агенту, раз в день);
//   • daily_stats       — предвычисленные дневные агрегаты (дельта + абсолют).
// Дельта считается как разность текущего снапшота и предыдущего того же agentId.
// Сырьё хранится отдельно от агрегатов, чтобы дельты можно было пересчитать при
// пропуске/ошибке прогона (design.md §Decisions).

import Database from "better-sqlite3";
import { funnelDbPath } from "../config";

// ─── Types ────────────────────────────────────────────────────────────

export interface SnapshotRow {
    agentId: string;
    snappedAt: number;
    publicChannelSubs: number | null;
    postId: number | null;
    postViews: number | null;
    privatePendingRequests: number | null;
}

export interface DailyStatsRow {
    date: string;            // YYYY-MM-DD (день UTC+5)
    agentId: string;
    groupReplies: number;
    dmsSent: number;
    postViewsDelta: number | null;
    postViewsAbs: number | null;
    publicSubsDelta: number | null;
    publicSubsAbs: number | null;
    privateRequestsDelta: number | null;
    privateRequestsAbs: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const initializedDbs = new Set<string>();

function openDb(adminAgentId: string): Database.Database {
    const db = new Database(funnelDbPath(adminAgentId));
    ensureSchema(db, adminAgentId);
    return db;
}

function ensureSchema(db: Database.Database, key: string): void {
    if (initializedDbs.has(key)) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS channel_snapshots (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id                 TEXT    NOT NULL,
            snapped_at               INTEGER NOT NULL,
            public_channel_subs      INTEGER,
            post_id                  INTEGER,
            post_views               INTEGER,
            private_pending_requests INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_agent_time
            ON channel_snapshots(agent_id, snapped_at DESC);

        CREATE TABLE IF NOT EXISTS daily_stats (
            date                   TEXT    NOT NULL,
            agent_id               TEXT    NOT NULL,
            group_replies          INTEGER NOT NULL DEFAULT 0,
            dms_sent               INTEGER NOT NULL DEFAULT 0,
            post_views_delta       INTEGER,
            post_views_abs         INTEGER,
            public_subs_delta      INTEGER,
            public_subs_abs        INTEGER,
            private_requests_delta INTEGER,
            private_requests_abs   INTEGER,
            PRIMARY KEY (date, agent_id)
        );
    `);
    initializedDbs.add(key);
}

// ─── API ──────────────────────────────────────────────────────────────

/** Идемпотентно создаёт схему. Безопасно вызывать на каждом прогоне. */
export function ensureFunnelSchema(adminAgentId: string): void {
    const db = openDb(adminAgentId);
    db.close();
}

/** Последний (самый свежий) снапшот агента — база для дельты. */
export function getPreviousSnapshot(adminAgentId: string, agentId: string): SnapshotRow | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`
            SELECT agent_id AS agentId, snapped_at AS snappedAt,
                   public_channel_subs AS publicChannelSubs, post_id AS postId,
                   post_views AS postViews, private_pending_requests AS privatePendingRequests
            FROM channel_snapshots
            WHERE agent_id = ?
            ORDER BY snapped_at DESC
            LIMIT 1
        `).get(agentId) as SnapshotRow | undefined;
        return row ?? null;
    } finally {
        db.close();
    }
}

/**
 * Есть ли уже снапшот агента за день UTC+5, начинающийся в `dayStartSec`.
 * Используется как защита от двойного прогона (только в режиме persist).
 */
export function hasSnapshotForDay(adminAgentId: string, agentId: string, dayStartSec: number): boolean {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`
            SELECT 1 FROM channel_snapshots
            WHERE agent_id = ? AND snapped_at >= ?
            LIMIT 1
        `).get(agentId, dayStartSec) as { 1: number } | undefined;
        return row !== undefined;
    } finally {
        db.close();
    }
}

export function insertSnapshot(adminAgentId: string, row: SnapshotRow): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`
            INSERT INTO channel_snapshots
                (agent_id, snapped_at, public_channel_subs, post_id, post_views, private_pending_requests)
            VALUES
                (@agentId, @snappedAt, @publicChannelSubs, @postId, @postViews, @privatePendingRequests)
        `).run({
            agentId: row.agentId,
            snappedAt: row.snappedAt,
            publicChannelSubs: row.publicChannelSubs,
            postId: row.postId,
            postViews: row.postViews,
            privatePendingRequests: row.privatePendingRequests,
        });
    } finally {
        db.close();
    }
}

/** Запись/обновление дневного агрегата по (date, agentId). */
export function upsertDailyStats(adminAgentId: string, row: DailyStatsRow): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`
            INSERT INTO daily_stats
                (date, agent_id, group_replies, dms_sent,
                 post_views_delta, post_views_abs, public_subs_delta, public_subs_abs,
                 private_requests_delta, private_requests_abs)
            VALUES
                (@date, @agentId, @groupReplies, @dmsSent,
                 @postViewsDelta, @postViewsAbs, @publicSubsDelta, @publicSubsAbs,
                 @privateRequestsDelta, @privateRequestsAbs)
            ON CONFLICT(date, agent_id) DO UPDATE SET
                group_replies          = excluded.group_replies,
                dms_sent               = excluded.dms_sent,
                post_views_delta       = excluded.post_views_delta,
                post_views_abs         = excluded.post_views_abs,
                public_subs_delta      = excluded.public_subs_delta,
                public_subs_abs        = excluded.public_subs_abs,
                private_requests_delta = excluded.private_requests_delta,
                private_requests_abs   = excluded.private_requests_abs
        `).run({
            date: row.date,
            agentId: row.agentId,
            groupReplies: row.groupReplies,
            dmsSent: row.dmsSent,
            postViewsDelta: row.postViewsDelta,
            postViewsAbs: row.postViewsAbs,
            publicSubsDelta: row.publicSubsDelta,
            publicSubsAbs: row.publicSubsAbs,
            privateRequestsDelta: row.privateRequestsDelta,
            privateRequestsAbs: row.privateRequestsAbs,
        });
    } finally {
        db.close();
    }
}
