// core/db/replies.ts — SQLite-хранилище ответов и тредов групп.
//
// Перенесено из прежнего replies-db.ts без изменения поведения. Уже было
// набором чистых функций без зависимостей OpenClaw; единственное изменение —
// путь к БД берётся из core/config (DRY).

import * as fs from "fs";
import Database from "better-sqlite3";
import { repliesDbPath } from "../config";
import type { Logger } from "../logger";

function openDb(dbPath: string, readonly = false): Database.Database {
    return new Database(dbPath, { readonly });
}

// ─── Init ─────────────────────────────────────────────────────────────

function ensureTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS replies (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId          TEXT    NOT NULL,
            msgId           INTEGER NOT NULL,
            msgText         TEXT,
            replyMsgId      INTEGER,
            replyText       TEXT    NOT NULL,
            sentAt          INTEGER NOT NULL,
            channelUsername TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_replies_chatId ON replies(chatId);
        CREATE INDEX IF NOT EXISTS idx_replies_sentAt ON replies(sentAt DESC);

        CREATE TABLE IF NOT EXISTS group_threads (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId         TEXT    NOT NULL,
            startMsgId     INTEGER NOT NULL,
            status         TEXT    NOT NULL DEFAULT 'active',
            lastActivityAt INTEGER NOT NULL,
            messages       TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_thread_agent_msgs (
            agentMsgId  INTEGER NOT NULL,
            chatId      TEXT    NOT NULL,
            threadId    INTEGER NOT NULL REFERENCES group_threads(id),
            sentAt      INTEGER,
            PRIMARY KEY (agentMsgId, chatId)
        );

        CREATE TABLE IF NOT EXISTS thread_post_dates (
            chatId      TEXT    NOT NULL,
            topMsgId    INTEGER NOT NULL,
            postDate    INTEGER NOT NULL,
            firstSeenAt INTEGER NOT NULL,
            PRIMARY KEY (chatId, topMsgId)
        );
    `);
    migrateAgentMsgSentAtColumn(db);
    migrateChannelUsernameColumn(db);
}

/**
 * Аддитивная миграция колонки `sentAt` в `group_thread_agent_msgs`
 * (channel-suspend-on-deletion) — БД, созданные до этого изменения, получают
 * колонку без потери данных. Существующие строки останутся с `sentAt = NULL`
 * (не участвуют в окне проверки удаления, эквивалент «сообщение до деплоя»).
 */
function migrateAgentMsgSentAtColumn(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(group_thread_agent_msgs)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("sentAt")) db.exec(`ALTER TABLE group_thread_agent_msgs ADD COLUMN sentAt INTEGER`);
}

/** Аддитивная миграция колонки `channelUsername` в `replies` (reply-channel-username). */
function migrateChannelUsernameColumn(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(replies)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("channelUsername")) db.exec(`ALTER TABLE replies ADD COLUMN channelUsername TEXT`);
}

// ─── Public API ───────────────────────────────────────────────────────

export interface ReplyRecord {
    chatId: string;
    msgId: number;
    msgText?: string;
    replyMsgId?: number;
    replyText: string;
    channelUsername?: string | null;
}

export interface ThreadMessage {
    role: "user" | "agent";
    msgId: number;
    fromName?: string;
    fromId?: string;
    text: string;
}

export interface ThreadRecord {
    id: number;
    chatId: string;
    startMsgId: number;
    status: string;
    lastActivityAt: number;
    messages: ThreadMessage[];
}

export interface ReplyLookupRecord {
    id: number;
    chatId: string;
    msgId: number;
    msgText: string | null;
    replyMsgId: number | null;
    replyText: string;
    sentAt: number;
}

// ─── Funnel API ───────────────────────────────────────────────────────

export interface ChannelSendAgg {
    chatId: string;
    msgCount: number;
    /** MAX(replyMsgId) за окно — якорь для ссылки на канал (funnel-tracking v3, US-5).
     *  null, только если у всех строк группы replyMsgId не заполнен (оборонительный
     *  случай — текущий путь записи replies всегда его заполняет). */
    lastReplyMsgId: number | null;
}

/**
 * Разбивка ответов агента по каналам за окно [startSec, endSec): DISTINCT chatId
 * с числом сообщений и последним msgId — источник и для «каналов с отправкой»
 * (funnel-tracking v3, US-2, `.length`), и для построчной разбивки в CSV (US-5).
 */
export function getChannelSendBreakdown(agentId: string, startSec: number, endSec: number): ChannelSendAgg[] {
    if (!fs.existsSync(repliesDbPath(agentId))) return [];
    const db = openDb(repliesDbPath(agentId), true);
    try {
        return db.prepare(`
            SELECT chatId, COUNT(*) AS msgCount, MAX(replyMsgId) AS lastReplyMsgId
            FROM replies
            WHERE sentAt >= @startSec AND sentAt < @endSec
            GROUP BY chatId
        `).all({ startSec, endSec }) as ChannelSendAgg[];
    } catch {
        return [];
    } finally {
        db.close();
    }
}

// ─── Deletion-check API (channel-suspend-on-deletion) ──────────────────

/**
 * Id сообщений, отправленных агентом в `chatId` начиная с `sinceSec` —
 * объединение общих ответов (`replies.replyMsgId`) и тредовых сообщений
 * агента (`group_thread_agent_msgs.agentMsgId`). Источник для проверки
 * удаления сообщений в Telegram (monitor-v2).
 */
export function getAgentSentMessageIds(agentId: string, chatId: string, sinceSec: number): number[] {
    if (!fs.existsSync(repliesDbPath(agentId))) return [];
    // Не readonly: ensureTable мигрирует group_thread_agent_msgs.sentAt на лету
    // для БД, где ни разу не было записи после этой миграции (createThread/
    // updateThread ни разу не вызывались) — иначе UNION ниже падает на
    // "no such column: sentAt" и функция молча возвращает [] (была найдена
    // как баг: 77 из 140 агентов не имели колонки, deletion-check тихо не
    // работал для них).
    const db = openDb(repliesDbPath(agentId), false);
    try {
        ensureTable(db);
        const rows = db.prepare(`
            SELECT replyMsgId AS msgId FROM replies
            WHERE chatId = @chatId AND replyMsgId IS NOT NULL AND sentAt >= @sinceSec
            UNION
            SELECT agentMsgId AS msgId FROM group_thread_agent_msgs
            WHERE chatId = @chatId AND sentAt >= @sinceSec
        `).all({ chatId, sinceSec }) as { msgId: number }[];
        return rows.map((r) => r.msgId);
    } catch {
        return [];
    } finally {
        db.close();
    }
}

// ─── Thread API ───────────────────────────────────────────────────────

export function findThreadByAgentMsgId(
    agentId: string,
    chatId: string,
    agentMsgId: number,
): ThreadRecord | null {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        const row = db.prepare(`
            SELECT gt.id, gt.chatId, gt.startMsgId, gt.status, gt.lastActivityAt, gt.messages
            FROM group_thread_agent_msgs gta
            JOIN group_threads gt ON gt.id = gta.threadId
            WHERE gta.agentMsgId = @agentMsgId AND gta.chatId = @chatId
            LIMIT 1
        `).get({ agentMsgId, chatId }) as { id: number; chatId: string; startMsgId: number; status: string; lastActivityAt: number; messages: string } | undefined;

        if (!row) return null;
        return {
            id: row.id,
            chatId: row.chatId,
            startMsgId: row.startMsgId,
            status: row.status,
            lastActivityAt: row.lastActivityAt,
            messages: JSON.parse(row.messages) as ThreadMessage[],
        };
    } finally {
        db.close();
    }
}

export function createThread(
    agentId: string,
    chatId: string,
    startMsgId: number,
    messages: ThreadMessage[],
    agentMsgId: number,
): number {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        const now = Math.floor(Date.now() / 1000);
        const messagesJson = JSON.stringify(messages);

        let threadId!: number;
        db.transaction(() => {
            const insertThread = db.prepare(`
                INSERT INTO group_threads (chatId, startMsgId, status, lastActivityAt, messages)
                VALUES (@chatId, @startMsgId, 'active', @lastActivityAt, @messages)
            `);
            const result = insertThread.run({ chatId, startMsgId, lastActivityAt: now, messages: messagesJson });
            threadId = result.lastInsertRowid as number;

            db.prepare(`
                INSERT INTO group_thread_agent_msgs (agentMsgId, chatId, threadId, sentAt)
                VALUES (@agentMsgId, @chatId, @threadId, @sentAt)
            `).run({ agentMsgId, chatId, threadId, sentAt: now });
        })();

        return threadId;
    } finally {
        db.close();
    }
}

export function updateThread(
    agentId: string,
    threadId: number,
    newMessages: ThreadMessage[],
    newAgentMsgId: number,
): void {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        const now = Math.floor(Date.now() / 1000);

        const row = db.prepare(`
            SELECT chatId, messages FROM group_threads WHERE id = @threadId
        `).get({ threadId }) as { chatId: string; messages: string } | undefined;

        if (!row) return;

        const existing = JSON.parse(row.messages) as ThreadMessage[];
        const merged = JSON.stringify([...existing, ...newMessages]);

        db.transaction(() => {
            db.prepare(`
                UPDATE group_threads
                SET messages = @messages, lastActivityAt = @lastActivityAt
                WHERE id = @threadId
            `).run({ messages: merged, lastActivityAt: now, threadId });

            db.prepare(`
                INSERT OR IGNORE INTO group_thread_agent_msgs (agentMsgId, chatId, threadId, sentAt)
                VALUES (@agentMsgId, @chatId, @threadId, @sentAt)
            `).run({ agentMsgId: newAgentMsgId, chatId: row.chatId, threadId, sentAt: now });
        })();
    } finally {
        db.close();
    }
}

export function expireOldThreads(agentId: string, olderThanSeconds: number): number {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        const threshold = Math.floor(Date.now() / 1000) - olderThanSeconds;
        const result = db.prepare(`
            UPDATE group_threads
            SET status = 'expired'
            WHERE status = 'active' AND lastActivityAt < @threshold
        `).run({ threshold });
        return result.changes;
    } finally {
        db.close();
    }
}

export function findReplyByReplyMsgId(
    agentId: string,
    chatId: string,
    replyMsgId: number,
): ReplyLookupRecord | null {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        const row = db.prepare(`
            SELECT id, chatId, msgId, msgText, replyMsgId, replyText, sentAt
            FROM replies
            WHERE chatId = @chatId AND replyMsgId = @replyMsgId
            LIMIT 1
        `).get({ chatId, replyMsgId }) as ReplyLookupRecord | undefined;

        return row ?? null;
    } finally {
        db.close();
    }
}

// ─── Saves ────────────────────────────────────────────────────────────

export function saveReply(agentId: string, record: ReplyRecord): void {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        db.prepare(`
            INSERT INTO replies (chatId, msgId, msgText, replyMsgId, replyText, sentAt, channelUsername)
            VALUES (@chatId, @msgId, @msgText, @replyMsgId, @replyText, @sentAt, @channelUsername)
        `).run({
            chatId:          record.chatId,
            msgId:           record.msgId,
            msgText:         record.msgText ?? null,
            replyMsgId:      record.replyMsgId ?? null,
            replyText:       record.replyText,
            sentAt:          Math.floor(Date.now() / 1000),
            channelUsername: record.channelUsername ?? null,
        });
    } finally {
        db.close();
    }
}

// ─── Даты публикации постов веток (post-freshness-gate, случай A) ─────

/** Сохранённая дата публикации поста ветки, если ещё не вытеснена по TTL. */
export function getThreadPostDate(agentId: string, chatId: string, topMsgId: number): number | null {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        const row = db.prepare(`
            SELECT postDate FROM thread_post_dates WHERE chatId = @chatId AND topMsgId = @topMsgId
        `).get({ chatId, topMsgId }) as { postDate: number } | undefined;
        return row?.postDate ?? null;
    } finally {
        db.close();
    }
}

/** Сохраняет дату публикации поста ветки при первой встрече с веткой. */
export function saveThreadPostDate(
    agentId: string,
    chatId: string,
    topMsgId: number,
    postDate: number,
    log: Logger,
): void {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        db.prepare(`
            INSERT OR REPLACE INTO thread_post_dates (chatId, topMsgId, postDate, firstSeenAt)
            VALUES (@chatId, @topMsgId, @postDate, @firstSeenAt)
        `).run({ chatId, topMsgId, postDate, firstSeenAt: Math.floor(Date.now() / 1000) });
        log.info(`[tg-replies-db] saveThreadPostDate — chatId=${chatId} topMsgId=${topMsgId} postDate=${postDate}`);
    } finally {
        db.close();
    }
}

/** Вытесняет записи дат постов старше `olderThanSeconds` с момента сохранения (гигиена объёма). */
export function expireOldThreadPostDates(agentId: string, olderThanSeconds: number, log: Logger): { expired: number } {
    const db = openDb(repliesDbPath(agentId));
    try {
        ensureTable(db);
        const threshold = Math.floor(Date.now() / 1000) - olderThanSeconds;
        const result = db.prepare(`
            DELETE FROM thread_post_dates WHERE firstSeenAt < @threshold
        `).run({ threshold });
        log.info(`[tg-replies-db] expireOldThreadPostDates — expired ${result.changes} rows`);
        return { expired: result.changes };
    } finally {
        db.close();
    }
}

