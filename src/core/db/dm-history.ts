// core/db/dm-history.ts — запись истории отправленных DM (legacy dm_history).
//
// Выделено из тела telegram_send_dm: ранее запись делалась inline сразу после
// подтверждения отправки. Поведение сохранено (R-B2) — вызывается строго ПОСЛЕ
// успешной отправки; ошибка записи не откатывает отправленный DM, поэтому
// логируется предупреждением и возвращается false, а не пробрасывается.

import Database from "better-sqlite3";
import { channelsDbPath } from "../config";
import type { Logger } from "../logger";

export interface DmHistoryRecord {
    userAccessHash: string;
    username?: string;
    triggerText: string;
    dmText: string;
    sentAt: number;
    lastAgentMsgAt: number;
    replyCount?: number;
    status?: string;
}

export function saveDmHistory(
    agentId: string,
    userId: string,
    record: DmHistoryRecord,
    messageId: number,
    log: Logger,
): boolean {
    try {
        const dbPath = channelsDbPath(agentId);
        const db = new Database(dbPath);
        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS dm_history (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    userId          TEXT NOT NULL,
                    userAccessHash  TEXT NOT NULL,
                    username        TEXT,
                    triggerText     TEXT NOT NULL,
                    dmText          TEXT NOT NULL,
                    sentAt          INTEGER NOT NULL,
                    lastAgentMsgAt  INTEGER NOT NULL,
                    replyCount      INTEGER DEFAULT 0,
                    status          TEXT DEFAULT 'sent'
                );
                CREATE INDEX IF NOT EXISTS idx_dm_history_user_sent
                    ON dm_history (userId, sentAt DESC);
            `);
            db.prepare(`
                INSERT INTO dm_history
                    (userId, userAccessHash, username, triggerText, dmText, sentAt, lastAgentMsgAt, replyCount, status)
                VALUES
                    (@userId, @userAccessHash, @username, @triggerText, @dmText, @sentAt, @lastAgentMsgAt, @replyCount, @status)
            `).run({
                userId,
                userAccessHash: record.userAccessHash,
                username: record.username ?? null,
                triggerText: record.triggerText,
                dmText: record.dmText,
                sentAt: record.sentAt,
                lastAgentMsgAt: record.lastAgentMsgAt,
                replyCount: record.replyCount ?? 0,
                status: record.status ?? "sent",
            });
            log.info(
                `[telegram-user-tool] tool:telegram_send_dm — dm_history saved atomically for userId=${userId} messageId=${messageId}`,
            );
            return true;
        } finally {
            db.close();
        }
    } catch (dbErr: any) {
        log.warn(
            `[telegram-user-tool] tool:telegram_send_dm — dm_history save failed (DM was sent): ${dbErr.message ?? dbErr}`,
        );
        return false;
    }
}
