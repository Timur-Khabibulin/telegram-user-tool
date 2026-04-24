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