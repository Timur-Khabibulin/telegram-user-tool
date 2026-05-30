import Database from "better-sqlite3";
import * as path from "path";
import * as os from "os";

// ─── Helpers ──────────────────────────────────────────────────────────

function resolveDbPath(agentId: string): string {
    return path.join(os.homedir(), ".openclaw", `workspace-${agentId}`, "tg-replies.db");
}

function openDb(dbPath: string): Database.Database {
    return new Database(dbPath);
}

// ─── Init ─────────────────────────────────────────────────────────────

function ensureTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS replies (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId     TEXT    NOT NULL,
            msgId      INTEGER NOT NULL,
            msgText    TEXT,
            replyMsgId INTEGER,
            replyText  TEXT    NOT NULL,
            sentAt     INTEGER NOT NULL
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
            PRIMARY KEY (agentMsgId, chatId)
        );
    `);
}

// ─── Public API ───────────────────────────────────────────────────────

export interface ReplyRecord {
    chatId: string;
    msgId: number;
    msgText?: string;
    replyMsgId?: number;
    replyText: string;
}

// ─── Thread types ─────────────────────────────────────────────────────

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

// ─── Thread API ───────────────────────────────────────────────────────

export function findThreadByAgentMsgId(
    agentId: string,
    chatId: string,
    agentMsgId: number,
): ThreadRecord | null {
    const dbPath = resolveDbPath(agentId);
    const db = openDb(dbPath);
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
    const dbPath = resolveDbPath(agentId);
    const db = openDb(dbPath);
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
                INSERT INTO group_thread_agent_msgs (agentMsgId, chatId, threadId)
                VALUES (@agentMsgId, @chatId, @threadId)
            `).run({ agentMsgId, chatId, threadId });
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
    const dbPath = resolveDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db);
        const now = Math.floor(Date.now() / 1000);

        // Fetch current messages and chatId
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
                INSERT OR IGNORE INTO group_thread_agent_msgs (agentMsgId, chatId, threadId)
                VALUES (@agentMsgId, @chatId, @threadId)
            `).run({ agentMsgId: newAgentMsgId, chatId: row.chatId, threadId });
        })();
    } finally {
        db.close();
    }
}

export function expireOldThreads(agentId: string, olderThanSeconds: number): number {
    const dbPath = resolveDbPath(agentId);
    const db = openDb(dbPath);
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
    const dbPath = resolveDbPath(agentId);
    const db = openDb(dbPath);
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
    const dbPath = resolveDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db);
        db.prepare(`
            INSERT INTO replies (chatId, msgId, msgText, replyMsgId, replyText, sentAt)
            VALUES (@chatId, @msgId, @msgText, @replyMsgId, @replyText, @sentAt)
        `).run({
            chatId:     record.chatId,
            msgId:      record.msgId,
            msgText:    record.msgText ?? null,
            replyMsgId: record.replyMsgId ?? null,
            replyText:  record.replyText,
            sentAt:     Math.floor(Date.now() / 1000),
        });
    } finally {
        db.close();
    }
}