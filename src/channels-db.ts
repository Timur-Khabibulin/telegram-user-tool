import { Type } from "@sinclair/typebox";
import Database from "better-sqlite3";
import { TelegramClient } from "telegram";
import type { PluginLogger } from "../openclaw/src/plugin-sdk/core";
import * as path from "path";
import * as os from "os";

// ─── Constants ───────────────────────────────────────────────────────

/** Количество каналов, возвращаемых за один прогон по умолчанию */
const DEFAULT_BATCH_LIMIT = 20;

/** Период обхода каждого канала по умолчанию: 72 часа в секундах */
const DEFAULT_PERIOD_SECONDS = 259200;

// ─── Types ────────────────────────────────────────────────────────────

interface ChannelRow {
    chatId: string;
    title: string;
    lastProcessedAt: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(dbPath: string, readonly = false): Database.Database {
    return new Database(dbPath, { readonly });
}

function resolveDbPath(agentId: string): string {
    return path.join(os.homedir(), ".openclaw", `workspace-${agentId}`, "tg-channels.db");
}

function ok(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

// ─── Shared agentId parameter schema ─────────────────────────────────

const agentIdParam = Type.String({
    description: "Your agentId from the Runtime section of the system prompt",
});

// ─── DM Candidates table helpers ─────────────────────────────────────

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

// ─── DM History table helpers ─────────────────────────────────────────

function ensureDmHistoryTable(db: Database.Database): void {
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
}

// ─── Tool Registrations ───────────────────────────────────────────────

export function registerChannelDbTools(
    api: { registerTool: (tool: any, opts?: any) => void; logger: PluginLogger },
    ensureClient: (log: PluginLogger) => Promise<TelegramClient | null>,
): void {
    const log = api.logger;

    // ── tg_channels_init ──────────────────────────────────────────────

    api.registerTool(
        {
            name: "tg_channels_init",
            description:
                "Create the channels SQLite table and index for this agent if they do not exist. " +
                "No Telegram connection required. Safe to call on every run — does nothing if table already exists. " +
                "Always call this first, then call tg_channels_sync to populate or update the data.",
            parameters: Type.Object({
                agentId: agentIdParam,
            }),

            async execute(_id: string, params: { agentId: string }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(`[tg-channels-db] tg_channels_init called — agentId=${params.agentId} dbPath=${dbPath}`);

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
                    return ok({ ok: true });
                } catch (err: any) {
                    log.error(`[tg-channels-db] tg_channels_init — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── tg_channels_sync ─────────────────────────────────────────────

    api.registerTool(
        {
            name: "tg_channels_sync",
            description:
                "Sync the channels database with the current Telegram dialogs. " +
                "On first run (empty table) populates all channels. " +
                "On subsequent runs: adds new channels, removes channels the agent has left, updates renamed titles. " +
                "Does NOT touch lastProcessedAt for existing channels. " +
                "Call on every run after tg_channels_init.",
            parameters: Type.Object({
                agentId: agentIdParam,
            }),

            async execute(_id: string, params: { agentId: string }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(`[tg-channels-db] tg_channels_sync called — agentId=${params.agentId}`);

                const client = await ensureClient(log);
                if (!client) return fail("Client not connected");

                try {
                    const dialogs = await client.getDialogs({});
                    const telegramChannels = new Map(
                        dialogs
                            .filter((d: any) => d.isGroup || d.isChannel)
                            .map((d: any) => [d.id?.toString() ?? "", d.title ?? ""])
                            .filter(([chatId]: [string, string]) => chatId !== ""),
                    );

                    const db = openDb(dbPath);
                    try {
                        const dbChannels = new Map(
                            (db.prepare("SELECT chatId, title FROM channels").all() as { chatId: string; title: string }[])
                                .map(({ chatId, title }) => [chatId, title]),
                        );

                        const toAdd = [...telegramChannels.entries()]
                            .filter(([chatId]) => !dbChannels.has(chatId));

                        const toRemove = [...dbChannels.keys()]
                            .filter((chatId) => !telegramChannels.has(chatId));

                        const toUpdate = [...telegramChannels.entries()]
                            .filter(([chatId, title]) => dbChannels.has(chatId) && dbChannels.get(chatId) !== title);

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
                        return ok({ ok: true, added: toAdd.length, removed: toRemove.length, updated: toUpdate.length });

                    } finally {
                        db.close();
                    }
                } catch (err: any) {
                    log.error(`[tg-channels-db] tg_channels_sync — error: ${err.message ?? err}`);
                    return fail(err);
                }
            },
        },
        { optional: true },
    );

    // ── tg_channels_get_batch ─────────────────────────────────────────

    api.registerTool(
        {
            name: "tg_channels_get_batch",
            description:
                "Get the next batch of channels due for processing. " +
                "Returns channels where lastProcessedAt is 0 (never processed) or older than periodSeconds ago, sorted oldest-first. " +
                "If the result is empty, all channels are up to date — stop the run.",
            parameters: Type.Object({
                agentId: agentIdParam,
                limit: Type.Optional(Type.Number({
                    description: `Maximum number of channels to return per batch. Default: ${DEFAULT_BATCH_LIMIT}.`,
                })),
                periodSeconds: Type.Optional(Type.Number({
                    description: `Minimum seconds since last processing. Default: ${DEFAULT_PERIOD_SECONDS} (72 hours).`,
                })),
            }),

            async execute(_id: string, params: { agentId: string; limit?: number; periodSeconds?: number }) {
                const dbPath = resolveDbPath(params.agentId);
                const limit = params.limit ?? DEFAULT_BATCH_LIMIT;
                const periodSeconds = params.periodSeconds ?? DEFAULT_PERIOD_SECONDS;

                log.info(
                    `[tg-channels-db] tg_channels_get_batch called — agentId=${params.agentId} limit=${limit} periodSeconds=${periodSeconds}`,
                );

                const db = openDb(dbPath, true);
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
                    return ok({ channels: rows });
                } catch (err: any) {
                    log.error(`[tg-channels-db] tg_channels_get_batch — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── tg_channels_mark_processed ────────────────────────────────────

    api.registerTool(
        {
            name: "tg_channels_mark_processed",
            description:
                "Update lastProcessedAt timestamp for a channel after it has been processed. " +
                "Call immediately after finishing each channel — not at the end of the batch — " +
                "so progress is saved even if the run times out.",
            parameters: Type.Object({
                agentId: agentIdParam,
                chatId: Type.String({
                    description: "The chatId of the processed channel.",
                }),
            }),

            async execute(_id: string, params: { agentId: string; chatId: string }) {
                const dbPath = resolveDbPath(params.agentId);
                const { chatId } = params;
                log.info(`[tg-channels-db] tg_channels_mark_processed called — agentId=${params.agentId} chatId=${chatId}`);

                const db = openDb(dbPath);
                try {
                    const result = db.prepare(`
                        UPDATE channels
                        SET lastProcessedAt = strftime('%s','now')
                        WHERE chatId = ?
                    `).run(chatId);

                    if (result.changes === 0) {
                        log.error(`[tg-channels-db] tg_channels_mark_processed — chatId=${chatId} not found`);
                        return fail(`Channel ${chatId} not found in database`);
                    }

                    log.info(`[tg-channels-db] tg_channels_mark_processed — updated chatId=${chatId}`);
                    return ok({ ok: true });
                } catch (err: any) {
                    log.error(`[tg-channels-db] tg_channels_mark_processed — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_candidates_insert ──────────────────────────────────────────

    api.registerTool(
        {
            name: "dm_candidates_insert",
            description:
                "Insert a DM candidate into the dm_candidates table. " +
                "Uses INSERT OR IGNORE — duplicate (sourceChatId, msgId) pairs are silently skipped. " +
                "Creates the table if it does not exist.",
            parameters: Type.Object({
                agentId: agentIdParam,
                record: Type.Object({
                    userId: Type.String({ description: "Telegram user ID of the message author" }),
                    userAccessHash: Type.Optional(Type.String({ description: "Access hash for the user" })),
                    sourceChatId: Type.String({ description: "Chat ID where the message was found" }),
                    msgId: Type.Number({ description: "Message ID within the source chat" }),
                    msgText: Type.String({ description: "Text content of the message" }),
                    score: Type.Number({ description: "Relevance score 0.0–1.0" }),
                    scoreReason: Type.Optional(Type.String({ description: "Human-readable reason for the score" })),
                }),
            }),

            async execute(_id: string, params: { agentId: string; record: any }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(
                    `[tg-channels-db] dm_candidates_insert called — agentId=${params.agentId} sourceChatId=${params.record.sourceChatId} msgId=${params.record.msgId}`
                );

                const db = openDb(dbPath);
                try {
                    ensureDmCandidatesTable(db);
                    const { userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason } = params.record;
                    const now = Math.floor(Date.now() / 1000);
                    db.prepare(`
                        INSERT OR IGNORE INTO dm_candidates
                            (userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason, status, createdAt)
                        VALUES
                            (@userId, @userAccessHash, @sourceChatId, @msgId, @msgText, @score, @scoreReason, 'pending', @createdAt)
                    `).run({ userId, userAccessHash: userAccessHash ?? null, sourceChatId, msgId, msgText, score, scoreReason: scoreReason ?? null, createdAt: now });

                    log.info(`[tg-channels-db] dm_candidates_insert — done`);
                    return ok({ ok: true });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_candidates_insert — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_candidates_get_pending ─────────────────────────────────────

    api.registerTool(
        {
            name: "dm_candidates_get_pending",
            description:
                "Return pending DM candidates sorted by score descending, up to limit records. " +
                "Only returns rows with status='pending'.",
            parameters: Type.Object({
                agentId: agentIdParam,
                limit: Type.Number({ description: "Maximum number of candidates to return" }),
            }),

            async execute(_id: string, params: { agentId: string; limit: number }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(
                    `[tg-channels-db] dm_candidates_get_pending called — agentId=${params.agentId} limit=${params.limit}`
                );

                const db = openDb(dbPath, true);
                try {
                    const rows = db.prepare(`
                        SELECT id, userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason, status, createdAt
                        FROM dm_candidates
                        WHERE status = 'pending'
                        ORDER BY score DESC
                        LIMIT @limit
                    `).all({ limit: params.limit });

                    log.info(`[tg-channels-db] dm_candidates_get_pending — returned ${rows.length} rows`);
                    return ok({ candidates: rows });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_candidates_get_pending — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_candidates_update_status ───────────────────────────────────

    api.registerTool(
        {
            name: "dm_candidates_update_status",
            description:
                "Update the status of a single dm_candidates record by id. " +
                "Valid statuses: pending, sent, skipped, expired.",
            parameters: Type.Object({
                agentId: agentIdParam,
                id: Type.Number({ description: "Row id of the dm_candidates record" }),
                status: Type.String({ description: "New status value" }),
            }),

            async execute(_id: string, params: { agentId: string; id: number; status: string }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(
                    `[tg-channels-db] dm_candidates_update_status called — agentId=${params.agentId} id=${params.id} status=${params.status}`
                );

                const db = openDb(dbPath);
                try {
                    const result = db.prepare(`
                        UPDATE dm_candidates SET status = @status WHERE id = @id
                    `).run({ status: params.status, id: params.id });

                    if (result.changes === 0) {
                        return fail(`dm_candidates row id=${params.id} not found`);
                    }

                    log.info(`[tg-channels-db] dm_candidates_update_status — done`);
                    return ok({ ok: true });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_candidates_update_status — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_candidates_expire_old ──────────────────────────────────────

    api.registerTool(
        {
            name: "dm_candidates_expire_old",
            description:
                "Expire pending dm_candidates records older than olderThanDays days. " +
                "Only records with status='pending' and createdAt < now - olderThanDays*86400 are affected.",
            parameters: Type.Object({
                agentId: agentIdParam,
                olderThanDays: Type.Number({ description: "Records older than this many days are expired" }),
            }),

            async execute(_id: string, params: { agentId: string; olderThanDays: number }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(
                    `[tg-channels-db] dm_candidates_expire_old called — agentId=${params.agentId} olderThanDays=${params.olderThanDays}`
                );

                const db = openDb(dbPath);
                try {
                    const cutoff = Math.floor(Date.now() / 1000) - params.olderThanDays * 86400;
                    const result = db.prepare(`
                        UPDATE dm_candidates
                        SET status = 'expired'
                        WHERE status = 'pending' AND createdAt < @cutoff
                    `).run({ cutoff });

                    log.info(`[tg-channels-db] dm_candidates_expire_old — expired ${result.changes} rows`);
                    return ok({ ok: true, expired: result.changes });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_candidates_expire_old — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_history_check_cooldown ─────────────────────────────────────

    api.registerTool(
        {
            name: "dm_history_check_cooldown",
            description:
                "Check whether the 7-day DM cooldown has passed for a given userId. " +
                "Returns { canSend: true } if no DM was sent in the last 7 days, { canSend: false } otherwise.",
            parameters: Type.Object({
                agentId: agentIdParam,
                userId: Type.String({ description: "Telegram user ID to check" }),
            }),

            async execute(_id: string, params: { agentId: string; userId: string }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(
                    `[tg-channels-db] dm_history_check_cooldown called — agentId=${params.agentId} userId=${params.userId}`
                );

                const db = openDb(dbPath, true);
                try {
                    ensureDmHistoryTable(db);
                    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
                    const row = db.prepare(`
                        SELECT COUNT(*) as cnt
                        FROM dm_history
                        WHERE userId = @userId AND sentAt > @cutoff
                    `).get({ userId: params.userId, cutoff }) as { cnt: number };

                    const canSend = row.cnt === 0;
                    log.info(`[tg-channels-db] dm_history_check_cooldown — userId=${params.userId} canSend=${canSend}`);
                    return ok({ canSend });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_history_check_cooldown — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_history_count_today ────────────────────────────────────────

    api.registerTool(
        {
            name: "dm_history_count_today",
            description:
                "Return the count of DMs sent today (since midnight UTC). " +
                "Used to enforce the daily sending limit.",
            parameters: Type.Object({
                agentId: agentIdParam,
            }),

            async execute(_id: string, params: { agentId: string }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(`[tg-channels-db] dm_history_count_today called — agentId=${params.agentId}`);

                const db = openDb(dbPath, true);
                try {
                    // Полночь UTC текущих суток: начало дня в секундах
                    const now = new Date();
                    const midnightUtc = Math.floor(
                        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
                    );
                    const row = db.prepare(`
                        SELECT COUNT(*) as cnt FROM dm_history WHERE sentAt > @midnightUtc
                    `).get({ midnightUtc }) as { cnt: number };

                    log.info(`[tg-channels-db] dm_history_count_today — count=${row.cnt}`);
                    return ok({ count: row.cnt });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_history_count_today — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_history_insert ─────────────────────────────────────────────

    api.registerTool(
        {
            name: "dm_history_insert",
            description:
                "Record a sent DM in the dm_history table. Creates the table if it does not exist. " +
                "Fields: userId, userAccessHash, username, triggerText, dmText, sentAt, lastAgentMsgAt, replyCount, status.",
            parameters: Type.Object({
                agentId: agentIdParam,
                record: Type.Object({
                    userId: Type.String(),
                    userAccessHash: Type.String(),
                    username: Type.Optional(Type.String()),
                    triggerText: Type.String({ description: "The message that triggered this DM" }),
                    dmText: Type.String({ description: "The text of the DM that was sent" }),
                    sentAt: Type.Number({ description: "Unix timestamp when the DM was sent" }),
                    lastAgentMsgAt: Type.Number({ description: "Unix timestamp of the last agent message in this DM thread" }),
                    replyCount: Type.Optional(Type.Number()),
                    status: Type.Optional(Type.String()),
                }),
            }),

            async execute(_id: string, params: { agentId: string; record: any }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(
                    `[tg-channels-db] dm_history_insert called — agentId=${params.agentId} userId=${params.record.userId}`
                );

                const db = openDb(dbPath);
                try {
                    ensureDmHistoryTable(db);
                    const { userId, userAccessHash, username, triggerText, dmText, sentAt, lastAgentMsgAt, replyCount, status } = params.record;
                    db.prepare(`
                        INSERT INTO dm_history
                            (userId, userAccessHash, username, triggerText, dmText, sentAt, lastAgentMsgAt, replyCount, status)
                        VALUES
                            (@userId, @userAccessHash, @username, @triggerText, @dmText, @sentAt, @lastAgentMsgAt, @replyCount, @status)
                    `).run({
                        userId,
                        userAccessHash,
                        username: username ?? null,
                        triggerText,
                        dmText,
                        sentAt,
                        lastAgentMsgAt,
                        replyCount: replyCount ?? 0,
                        status: status ?? "sent",
                    });

                    log.info(`[tg-channels-db] dm_history_insert — done`);
                    return ok({ ok: true });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_history_insert — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_history_get_active ─────────────────────────────────────────

    api.registerTool(
        {
            name: "dm_history_get_active",
            description:
                "Return all dm_history records with status 'sent' or 'in_dialogue'. " +
                "Includes all fields needed to check for replies: id, userId, userAccessHash, username, " +
                "triggerText, dmText, sentAt, lastAgentMsgAt, replyCount, status.",
            parameters: Type.Object({
                agentId: agentIdParam,
            }),

            async execute(_id: string, params: { agentId: string }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(`[tg-channels-db] dm_history_get_active called — agentId=${params.agentId}`);

                const db = openDb(dbPath, true);
                try {
                    const rows = db.prepare(`
                        SELECT id, userId, userAccessHash, username, triggerText, dmText,
                               sentAt, lastAgentMsgAt, replyCount, status
                        FROM dm_history
                        WHERE status IN ('sent', 'in_dialogue')
                        ORDER BY sentAt ASC
                    `).all();

                    log.info(`[tg-channels-db] dm_history_get_active — returned ${rows.length} rows`);
                    return ok({ entries: rows });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_history_get_active — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── dm_history_update ─────────────────────────────────────────────

    api.registerTool(
        {
            name: "dm_history_update",
            description:
                "Update selected fields of a dm_history record by id. " +
                "Supported fields: status, replyCount, lastAgentMsgAt, username. " +
                "Only fields present in the 'fields' object are updated.",
            parameters: Type.Object({
                agentId: agentIdParam,
                id: Type.Number({ description: "Row id of the dm_history record" }),
                fields: Type.Object({
                    status: Type.Optional(Type.String()),
                    replyCount: Type.Optional(Type.Number()),
                    lastAgentMsgAt: Type.Optional(Type.Number()),
                    username: Type.Optional(Type.String()),
                }),
            }),

            async execute(_id: string, params: { agentId: string; id: number; fields: any }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(
                    `[tg-channels-db] dm_history_update called — agentId=${params.agentId} id=${params.id}`
                );

                const db = openDb(dbPath);
                try {
                    const { fields } = params;
                    const setClauses: string[] = [];
                    const values: Record<string, unknown> = { id: params.id };

                    if (fields.status !== undefined) { setClauses.push("status = @status"); values.status = fields.status; }
                    if (fields.replyCount !== undefined) { setClauses.push("replyCount = @replyCount"); values.replyCount = fields.replyCount; }
                    if (fields.lastAgentMsgAt !== undefined) { setClauses.push("lastAgentMsgAt = @lastAgentMsgAt"); values.lastAgentMsgAt = fields.lastAgentMsgAt; }
                    if (fields.username !== undefined) { setClauses.push("username = @username"); values.username = fields.username; }

                    if (setClauses.length === 0) {
                        return ok({ ok: true, changes: 0 });
                    }

                    const result = db.prepare(
                        `UPDATE dm_history SET ${setClauses.join(", ")} WHERE id = @id`
                    ).run(values);

                    if (result.changes === 0) {
                        return fail(`dm_history row id=${params.id} not found`);
                    }

                    log.info(`[tg-channels-db] dm_history_update — done id=${params.id}`);
                    return ok({ ok: true, changes: result.changes });
                } catch (err: any) {
                    log.error(`[tg-channels-db] dm_history_update — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );
}