// core/db/dm-threads.ts — контекстные DM-треды (sliding window 50 сообщений).
//
// Перенесено из прежнего dm-threads-db.ts: тела инструментов превращены в обычные
// функции без TypeBox и без формата { content: [...] }. Поведение, схема и
// cooldown сохранены (R-B2). Логирование инжектируется через Logger (DIP).

import Database from "better-sqlite3";
import { dmThreadsDbPath } from "../config";
import type { Logger } from "../logger";

// ─── Constants ────────────────────────────────────────────────────────

/** Maximum number of messages stored in the sliding window */
const MAX_MESSAGES = 50;
/** Cooldown period in days — thread is considered active within this window */
const COOLDOWN_DAYS = 14;

// ─── Types ────────────────────────────────────────────────────────────

export interface DmThreadMessage {
    role: "agent" | "user";
    msgId: number;
    text: string;
    sentAt: number;
}

interface DmThreadRow {
    id: number;
    userId: string;
    userAccessHash: string;
    userName: string | null;
    fromChatId: string;
    triggerMessage: string;
    messages: string;
    createdAt: number;
    lastActivityAt: number;
}

export interface DmThreadFirstMessage {
    role: "agent";
    msgId: number;
    text: string;
    sentAt: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(dbPath: string, readonly = false): Database.Database {
    return new Database(dbPath, { readonly });
}

// Кэш проинициализированных БД, чтобы не выполнять DDL на каждый вызов.
const initializedDbs = new Set<string>();

function ensureDmThreadsTable(db: Database.Database, dbPath: string): void {
    if (initializedDbs.has(dbPath)) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS dm_threads (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            userId          TEXT    NOT NULL UNIQUE,
            userAccessHash  TEXT    NOT NULL,
            userName        TEXT,
            fromChatId      TEXT    NOT NULL,
            triggerMessage  TEXT    NOT NULL,
            messages        TEXT    NOT NULL DEFAULT '[]',
            createdAt       INTEGER NOT NULL,
            lastActivityAt  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dm_threads_created  ON dm_threads (createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_dm_threads_activity ON dm_threads (lastActivityAt DESC);
    `);
    initializedDbs.add(dbPath);
}

// ─── API ──────────────────────────────────────────────────────────────

export function createDmThread(
    agentId: string,
    params: {
        userId: string;
        userAccessHash: string;
        userName?: string;
        fromChatId: string;
        triggerMessage: string;
        firstMessage: DmThreadFirstMessage;
    },
    log: Logger,
): { ok: true; threadId: number | bigint } | { error: "thread_exists" } {
    const dbPath = dmThreadsDbPath(agentId);
    log.info(`[dm-threads-db] dm_threads_create called — agentId=${agentId} userId=${params.userId}`);

    const db = openDb(dbPath);
    try {
        ensureDmThreadsTable(db, dbPath);

        const now = Math.floor(Date.now() / 1000);
        const messagesJson = JSON.stringify([params.firstMessage]);

        const result = db.prepare(`
            INSERT INTO dm_threads
                (userId, userAccessHash, userName, fromChatId, triggerMessage, messages, createdAt, lastActivityAt)
            VALUES
                (@userId, @userAccessHash, @userName, @fromChatId, @triggerMessage, @messages, @createdAt, @lastActivityAt)
        `).run({
            userId: params.userId,
            userAccessHash: params.userAccessHash,
            userName: params.userName ?? null,
            fromChatId: params.fromChatId,
            triggerMessage: params.triggerMessage,
            messages: messagesJson,
            createdAt: now,
            lastActivityAt: now,
        });

        log.info(`[dm-threads-db] dm_threads_create — created threadId=${result.lastInsertRowid}`);
        return { ok: true, threadId: result.lastInsertRowid };
    } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint failed")) {
            log.warn(`[dm-threads-db] dm_threads_create — thread already exists for userId=${params.userId}`);
            return { error: "thread_exists" };
        }
        throw err;
    } finally {
        db.close();
    }
}

export function getDmThreadsByUsers(
    agentId: string,
    users: Array<{ userId: string; accessHash: string; userName?: string }>,
    log: Logger,
): { threads: DmThreadRow[]; notFound: string[] } {
    const dbPath = dmThreadsDbPath(agentId);
    log.info(`[dm-threads-db] dm_threads_get_by_users called — agentId=${agentId} users=${users.length}`);

    const db = openDb(dbPath);
    try {
        ensureDmThreadsTable(db, dbPath);

        const updateStmt = db.prepare(`
            UPDATE dm_threads
            SET userAccessHash = @accessHash,
                userName = COALESCE(@userName, userName)
            WHERE userId = @userId
        `);

        const selectStmt = db.prepare(`
            SELECT id, userId, userAccessHash, userName, fromChatId,
                   triggerMessage, messages, createdAt, lastActivityAt
            FROM dm_threads
            WHERE userId = @userId
        `);

        const threads: DmThreadRow[] = [];
        const notFound: string[] = [];

        db.transaction(() => {
            for (const user of users) {
                updateStmt.run({
                    userId: user.userId,
                    accessHash: user.accessHash,
                    userName: user.userName ?? null,
                });

                const row = selectStmt.get({ userId: user.userId }) as DmThreadRow | undefined;
                if (row) {
                    threads.push(row);
                } else {
                    notFound.push(user.userId);
                }
            }
        })();

        log.info(`[dm-threads-db] dm_threads_get_by_users — found=${threads.length} notFound=${notFound.length}`);
        return { threads, notFound };
    } finally {
        db.close();
    }
}

export function updateDmThreadMsgs(
    agentId: string,
    userId: string,
    newMessages: DmThreadMessage[],
    log: Logger,
): { ok: true; totalMessages: number } | { error: "thread_not_found" } {
    const dbPath = dmThreadsDbPath(agentId);
    log.info(
        `[dm-threads-db] dm_threads_update_msgs called — agentId=${agentId} userId=${userId} newMessages=${newMessages.length}`,
    );

    const db = openDb(dbPath);
    try {
        ensureDmThreadsTable(db, dbPath);

        const row = db.prepare(`SELECT messages FROM dm_threads WHERE userId = @userId`).get({ userId }) as
            | { messages: string }
            | undefined;

        if (!row) {
            log.warn(`[dm-threads-db] dm_threads_update_msgs — thread not found for userId=${userId}`);
            return { error: "thread_not_found" };
        }

        let messages: DmThreadMessage[] = JSON.parse(row.messages);
        messages = messages.concat(newMessages);

        const beforeTrim = messages.length;
        if (messages.length > MAX_MESSAGES) {
            messages = messages.slice(-MAX_MESSAGES);
            log.warn(
                `[dm-threads-db] dm_threads_update_msgs — sliding window trimmed ${beforeTrim - MAX_MESSAGES} oldest messages for userId=${userId} (${beforeTrim} → ${messages.length})`,
            );
        }

        // lastActivityAt = MAX sentAt from newMessages
        const lastActivityAt = Math.max(...newMessages.map((m) => m.sentAt));

        db.prepare(`
            UPDATE dm_threads
            SET messages = @messages,
                lastActivityAt = @lastActivityAt
            WHERE userId = @userId
        `).run({ userId, messages: JSON.stringify(messages), lastActivityAt });

        log.info(`[dm-threads-db] dm_threads_update_msgs — updated userId=${userId} totalMessages=${messages.length}`);
        return { ok: true, totalMessages: messages.length };
    } finally {
        db.close();
    }
}

export function countDmThreadsToday(agentId: string, log: Logger): { count: number } {
    const dbPath = dmThreadsDbPath(agentId);
    log.info(`[dm-threads-db] dm_threads_count_today called — agentId=${agentId}`);

    const db = openDb(dbPath, true);
    try {
        ensureDmThreadsTable(db, dbPath);

        const now = new Date();
        const midnightUtc = Math.floor(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
        );

        const row = db.prepare(`
            SELECT COUNT(*) as cnt FROM dm_threads WHERE createdAt >= @midnightUtc
        `).get({ midnightUtc }) as { cnt: number };

        log.info(`[dm-threads-db] dm_threads_count_today — count=${row.cnt}`);
        return { count: row.cnt };
    } finally {
        db.close();
    }
}

export function dmThreadExists(
    agentId: string,
    userId: string,
    log: Logger,
): { exists: false } | { exists: true; cooldownActive: boolean; days: number } {
    const dbPath = dmThreadsDbPath(agentId);
    log.info(`[dm-threads-db] dm_threads_exists called — agentId=${agentId} userId=${userId}`);

    const db = openDb(dbPath, true);
    try {
        ensureDmThreadsTable(db, dbPath);

        const row = db.prepare(`
            SELECT id, lastActivityAt,
                   CAST((strftime('%s','now') - lastActivityAt) / 86400 AS INTEGER) AS days
            FROM dm_threads
            WHERE userId = @userId
            LIMIT 1
        `).get({ userId }) as { id: number; lastActivityAt: number; days: number } | undefined;

        if (!row) {
            log.info(`[dm-threads-db] dm_threads_exists — userId=${userId} not found`);
            return { exists: false };
        }

        const cooldownActive = row.days < COOLDOWN_DAYS;
        log.info(
            `[dm-threads-db] dm_threads_exists — userId=${userId} exists, days=${row.days} cooldownActive=${cooldownActive}`,
        );
        return { exists: true, cooldownActive, days: row.days };
    } finally {
        db.close();
    }
}

export function deleteDmThread(agentId: string, userId: string, log: Logger): { deleted: boolean } {
    const dbPath = dmThreadsDbPath(agentId);
    log.info(`[dm-threads-db] dm_threads_delete called — agentId=${agentId} userId=${userId}`);

    const db = openDb(dbPath);
    try {
        ensureDmThreadsTable(db, dbPath);

        const result = db.prepare(`DELETE FROM dm_threads WHERE userId = @userId`).run({ userId });
        const deleted = result.changes > 0;
        log.info(`[dm-threads-db] dm_threads_delete — userId=${userId} deleted=${deleted}`);
        return { deleted };
    } finally {
        db.close();
    }
}
