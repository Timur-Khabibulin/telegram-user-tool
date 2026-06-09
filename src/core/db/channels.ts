// core/db/channels.ts — состояние батч-обработки каналов, DM-кандидаты,
// классификация сообщений и групповые треды.
//
// Перенесено из прежнего channels-db.ts: тела инструментов превращены в обычные
// экспортируемые функции без TypeBox и без формата { content: [...] }. Поведение
// и SQL сохранены (R-B2). Логирование инжектируется через Logger (DIP).

import Database from "better-sqlite3";
import { channelsDbPath } from "../config";
import type { Logger } from "../logger";
import {
    findThreadByAgentMsgId,
    createThread,
    updateThread,
    expireOldThreads,
    findReplyByReplyMsgId,
    type ThreadMessage,
} from "./replies";

// ─── Constants ────────────────────────────────────────────────────────

/** Количество каналов, возвращаемых за один прогон по умолчанию */
const DEFAULT_BATCH_LIMIT = 20;
/** Период обхода каждого канала по умолчанию: 72 часа в секундах */
const DEFAULT_PERIOD_SECONDS = 259200;
/** Период истечения тредов по умолчанию: 4 дня в секундах */
const DEFAULT_THREAD_EXPIRE_SECONDS = 345600;

// ─── Types ────────────────────────────────────────────────────────────

interface ChannelRow {
    chatId: string;
    title: string;
    lastProcessedAt: number;
}

export interface ClassifyInputMessage {
    id: number;
    fromId: string;
    fromName: string;
    text: string;
    date: number;
    userAccessHash?: string;
    replyToMsgId?: number;
}

export interface AgentReplyRecord {
    msgId: number;
    msgText: string;
    replyMsgId: number;
    replyText: string;
}

export interface NewThreadEntry {
    agentReplyRecord: AgentReplyRecord;
    messages: ClassifyInputMessage[];
}

export interface ThreadReplyEntry {
    threadId: number;
    threadStatus: string;
    threadMessages: ThreadMessage[];
    newMessages: ClassifyInputMessage[];
}

export interface ClassifyResult {
    generalMessages: ClassifyInputMessage[];
    newThreadMessages: NewThreadEntry[];
    threadReplies: ThreadReplyEntry[];
}

export interface DmCandidateRow {
    id: number;
    userId: string;
    userAccessHash: string | null;
    sourceChatId: string;
    msgId: number;
    msgText: string;
    score: number;
    scoreReason: string | null;
    status: string;
    createdAt: number;
}

export interface DmCandidateRecord {
    userId: string;
    userAccessHash?: string;
    sourceChatId: string;
    msgId: number;
    msgText: string;
    score: number;
    scoreReason?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(dbPath: string, readonly = false): Database.Database {
    return new Database(dbPath, { readonly });
}

function ensureDmCandidatesTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS dm_candidates (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            userId         TEXT NOT NULL,
            userAccessHash TEXT,
            sourceChatId   TEXT NOT NULL,
            msgId          INTEGER NOT NULL,
            msgText        TEXT NOT NULL,
            score          REAL DEFAULT 0,
            scoreReason    TEXT,
            status         TEXT DEFAULT 'pending',
            createdAt      INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_candidates_msg
            ON dm_candidates (sourceChatId, msgId);
        CREATE INDEX IF NOT EXISTS idx_dm_candidates_status
            ON dm_candidates (status, score DESC);
    `);
}

// ─── Channels ─────────────────────────────────────────────────────────

export function initChannels(agentId: string, log: Logger): { ok: true } {
    const dbPath = channelsDbPath(agentId);
    log.info(`[tg-channels-db] tg_channels_init called — agentId=${agentId} dbPath=${dbPath}`);
    const db = openDb(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS channels (
                chatId          TEXT    PRIMARY KEY,
                title           TEXT    NOT NULL,
                lastProcessedAt INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_lastProcessedAt
                ON channels(lastProcessedAt ASC);
        `);
        log.info(`[tg-channels-db] tg_channels_init — done`);
        return { ok: true };
    } finally {
        db.close();
    }
}

/**
 * Синхронизирует таблицу channels с актуальными диалогами Telegram.
 * Карта chatId → title подготавливается вызывающей стороной (TelegramService),
 * чтобы слой БД не зависел от Telegram.
 */
export function syncChannels(
    agentId: string,
    telegramChannels: Map<string, string>,
    log: Logger,
): { ok: true; added: number; removed: number; updated: number } {
    log.info(`[tg-channels-db] tg_channels_sync called — agentId=${agentId}`);
    const db = openDb(channelsDbPath(agentId));
    try {
        const dbChannels = new Map(
            (db.prepare("SELECT chatId, title FROM channels").all() as { chatId: string; title: string }[])
                .map(({ chatId, title }) => [chatId, title]),
        );

        const toAdd = [...telegramChannels.entries()].filter(([chatId]) => !dbChannels.has(chatId));
        const toRemove = [...dbChannels.keys()].filter((chatId) => !telegramChannels.has(chatId));
        const toUpdate = [...telegramChannels.entries()].filter(
            ([chatId, title]) => dbChannels.has(chatId) && dbChannels.get(chatId) !== title,
        );

        const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO channels (chatId, title, lastProcessedAt)
            VALUES (@chatId, @title, 0)
        `);
        const deleteStmt = db.prepare(`DELETE FROM channels WHERE chatId = ?`);
        const updateStmt = db.prepare(`UPDATE channels SET title = @title WHERE chatId = @chatId`);

        db.transaction(() => {
            for (const [chatId, title] of toAdd) insertStmt.run({ chatId, title });
            for (const chatId of toRemove) deleteStmt.run(chatId);
            for (const [chatId, title] of toUpdate) updateStmt.run({ chatId, title });
        })();

        log.info(
            `[tg-channels-db] tg_channels_sync — added=${toAdd.length} removed=${toRemove.length} updated=${toUpdate.length}`,
        );
        return { ok: true, added: toAdd.length, removed: toRemove.length, updated: toUpdate.length };
    } finally {
        db.close();
    }
}

export function getChannelsBatch(
    agentId: string,
    log: Logger,
    limit = DEFAULT_BATCH_LIMIT,
    periodSeconds = DEFAULT_PERIOD_SECONDS,
): { channels: ChannelRow[] } {
    log.info(
        `[tg-channels-db] tg_channels_get_batch called — agentId=${agentId} limit=${limit} periodSeconds=${periodSeconds}`,
    );
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const rows = db.prepare(`
            SELECT chatId, title, lastProcessedAt
            FROM channels
            WHERE lastProcessedAt = 0
               OR lastProcessedAt <= strftime('%s','now') - @periodSeconds
            ORDER BY lastProcessedAt ASC
            LIMIT @limit
        `).all({ periodSeconds, limit }) as ChannelRow[];

        log.info(`[tg-channels-db] tg_channels_get_batch — returned ${rows.length} channels`);
        return { channels: rows };
    } finally {
        db.close();
    }
}

export function markChannelProcessed(agentId: string, chatId: string, log: Logger): { ok: true } {
    log.info(`[tg-channels-db] tg_channels_mark_processed called — agentId=${agentId} chatId=${chatId}`);
    const db = openDb(channelsDbPath(agentId));
    try {
        const result = db.prepare(`
            UPDATE channels
            SET lastProcessedAt = strftime('%s','now')
            WHERE chatId = ?
        `).run(chatId);

        if (result.changes === 0) {
            log.error(`[tg-channels-db] tg_channels_mark_processed — chatId=${chatId} not found`);
            throw new Error(`Channel ${chatId} not found in database`);
        }

        log.info(`[tg-channels-db] tg_channels_mark_processed — updated chatId=${chatId}`);
        return { ok: true };
    } finally {
        db.close();
    }
}

// ─── DM candidates ────────────────────────────────────────────────────

export function insertDmCandidate(agentId: string, record: DmCandidateRecord, log: Logger): { ok: true } {
    log.info(
        `[tg-channels-db] dm_candidates_insert called — agentId=${agentId} sourceChatId=${record.sourceChatId} msgId=${record.msgId}`,
    );
    const db = openDb(channelsDbPath(agentId));
    try {
        ensureDmCandidatesTable(db);
        const { userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason } = record;
        const now = Math.floor(Date.now() / 1000);
        db.prepare(`
            INSERT OR IGNORE INTO dm_candidates
                (userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason, status, createdAt)
            VALUES
                (@userId, @userAccessHash, @sourceChatId, @msgId, @msgText, @score, @scoreReason, 'pending', @createdAt)
        `).run({
            userId,
            userAccessHash: userAccessHash ?? null,
            sourceChatId,
            msgId,
            msgText,
            score,
            scoreReason: scoreReason ?? null,
            createdAt: now,
        });

        log.info(`[tg-channels-db] dm_candidates_insert — done`);
        return { ok: true };
    } finally {
        db.close();
    }
}

export function getPendingDmCandidates(agentId: string, limit: number, log: Logger): { candidates: DmCandidateRow[] } {
    log.info(`[tg-channels-db] dm_candidates_get_pending called — agentId=${agentId} limit=${limit}`);
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const rows = db.prepare(`
            SELECT id, userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason, status, createdAt
            FROM dm_candidates
            WHERE status = 'pending'
            ORDER BY score DESC
            LIMIT @limit
        `).all({ limit }) as DmCandidateRow[];

        log.info(`[tg-channels-db] dm_candidates_get_pending — returned ${rows.length} rows`);
        return { candidates: rows };
    } finally {
        db.close();
    }
}

export function updateDmCandidateStatus(agentId: string, id: number, status: string, log: Logger): { ok: true } {
    log.info(`[tg-channels-db] dm_candidates_update_status called — agentId=${agentId} id=${id} status=${status}`);
    const db = openDb(channelsDbPath(agentId));
    try {
        const result = db.prepare(`
            UPDATE dm_candidates SET status = @status WHERE id = @id
        `).run({ status, id });

        if (result.changes === 0) {
            throw new Error(`dm_candidates row id=${id} not found`);
        }

        log.info(`[tg-channels-db] dm_candidates_update_status — done`);
        return { ok: true };
    } finally {
        db.close();
    }
}

export function expireOldDmCandidates(agentId: string, olderThanDays: number, log: Logger): { ok: true; expired: number } {
    log.info(`[tg-channels-db] dm_candidates_expire_old called — agentId=${agentId} olderThanDays=${olderThanDays}`);
    const db = openDb(channelsDbPath(agentId));
    try {
        const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
        const result = db.prepare(`
            UPDATE dm_candidates
            SET status = 'expired'
            WHERE status = 'pending' AND createdAt < @cutoff
        `).run({ cutoff });

        log.info(`[tg-channels-db] dm_candidates_expire_old — expired ${result.changes} rows`);
        return { ok: true, expired: result.changes };
    } finally {
        db.close();
    }
}

// ─── Classification ───────────────────────────────────────────────────

export function classifyMessages(
    agentId: string,
    chatId: string,
    messages: ClassifyInputMessage[],
    log: Logger,
): ClassifyResult {
    log.info(
        `[tg-channels-db] tg_classify_messages called — agentId=${agentId} chatId=${chatId} total=${messages.length}`,
    );
    const generalMessages: ClassifyInputMessage[] = [];
    const newThreadByReplyToMsgId = new Map<number, NewThreadEntry>();
    const threadRepliesByThreadId = new Map<number, ThreadReplyEntry>();

    for (const msg of messages) {
        if (msg.replyToMsgId === undefined || msg.replyToMsgId === null) {
            generalMessages.push(msg);
            continue;
        }

        const thread = findThreadByAgentMsgId(agentId, chatId, msg.replyToMsgId);
        if (thread) {
            let entry = threadRepliesByThreadId.get(thread.id);
            if (!entry) {
                entry = {
                    threadId: thread.id,
                    threadStatus: thread.status,
                    threadMessages: thread.messages,
                    newMessages: [],
                };
                threadRepliesByThreadId.set(thread.id, entry);
            }
            entry.newMessages.push(msg);
            continue;
        }

        const reply = findReplyByReplyMsgId(agentId, chatId, msg.replyToMsgId);
        if (reply) {
            let entry = newThreadByReplyToMsgId.get(msg.replyToMsgId);
            if (!entry) {
                entry = {
                    agentReplyRecord: {
                        msgId: reply.msgId,
                        msgText: reply.msgText ?? "",
                        replyMsgId: reply.replyMsgId ?? msg.replyToMsgId,
                        replyText: reply.replyText,
                    },
                    messages: [],
                };
                newThreadByReplyToMsgId.set(msg.replyToMsgId, entry);
            }
            entry.messages.push(msg);
            continue;
        }

        generalMessages.push(msg);
    }

    const newThreadMessages = Array.from(newThreadByReplyToMsgId.values());
    const threadReplies = Array.from(threadRepliesByThreadId.values());

    log.info(
        `[tg-channels-db] tg_classify_messages — general=${generalMessages.length} newThreads=${newThreadMessages.length} threadReplies=${threadReplies.length}`,
    );
    return { generalMessages, newThreadMessages, threadReplies };
}

// ─── Group threads ────────────────────────────────────────────────────

export function createGroupThread(
    agentId: string,
    params: { chatId: string; startMsgId: number; startMsgText: string; agentMsgId: number; agentMsgText: string },
    log: Logger,
): { ok: true; threadId: number } {
    log.info(
        `[tg-channels-db] tg_group_thread_create called — agentId=${agentId} chatId=${params.chatId} startMsgId=${params.startMsgId}`,
    );
    const messages: ThreadMessage[] = [
        { role: "user", msgId: params.startMsgId, text: params.startMsgText },
        { role: "agent", msgId: params.agentMsgId, text: params.agentMsgText },
    ];
    const threadId = createThread(agentId, params.chatId, params.startMsgId, messages, params.agentMsgId);
    log.info(`[tg-channels-db] tg_group_thread_create — created threadId=${threadId}`);
    return { ok: true, threadId };
}

export function updateGroupThread(
    agentId: string,
    threadId: number,
    newMessages: string,
    newAgentMsgId: number,
    log: Logger,
): { ok: true } {
    log.info(
        `[tg-channels-db] tg_group_thread_update called — agentId=${agentId} threadId=${threadId} newAgentMsgId=${newAgentMsgId}`,
    );
    const parsed = JSON.parse(newMessages) as ThreadMessage[];
    updateThread(agentId, threadId, parsed, newAgentMsgId);
    log.info(`[tg-channels-db] tg_group_thread_update — done threadId=${threadId}`);
    return { ok: true };
}

export function expireGroupThreads(
    agentId: string,
    log: Logger,
    olderThanSeconds = DEFAULT_THREAD_EXPIRE_SECONDS,
): { ok: true; expired: number } {
    log.info(`[tg-channels-db] tg_group_thread_expire called — agentId=${agentId} olderThanSeconds=${olderThanSeconds}`);
    const expired = expireOldThreads(agentId, olderThanSeconds);
    log.info(`[tg-channels-db] tg_group_thread_expire — expired ${expired} threads`);
    return { ok: true, expired };
}
