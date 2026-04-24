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
}