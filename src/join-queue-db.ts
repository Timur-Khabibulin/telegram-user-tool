import { Type } from "@sinclair/typebox";
import Database from "better-sqlite3";
import type { PluginLogger } from "../openclaw/src/plugin-sdk/core";
import * as path from "path";
import * as os from "os";

// ─── Status model ─────────────────────────────────────────────────────
//
//   pending ──get_batch──► processing ──update("joined")──► joined
//                │                    └──update("skipped")─► skipped
//                │                    └──update("error")──► error
//                │                    └──timeout reset──────► pending
//                └──────────────────────────────────────────────────┐
//   error ──get_batch (attempts < MAX_ATTEMPTS)──► processing       │
//                                                                    │
//  pending:    ожидает обработки (начальное состояние)              │
//  processing: взят в батч; если агент упал и запись не обновлена   │
//              дольше PROCESSING_TIMEOUT_SECONDS — сбрасывается     ┘
//              обратно в pending
//  joined:     успешно вступили в discussion group (финальный)
//  skipped:    пропущен навсегда — приватный канал, нет discussion
//              group, невалидный username и т.п. (финальный)
//  error:      временная ошибка (FLOOD_WAIT, сеть и т.п.);
//              повторяется до MAX_ATTEMPTS раз, затем остаётся error

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_BATCH_LIMIT = 15;
const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_SECONDS = 3600;

// ─── Helpers ──────────────────────────────────────────────────────────

function resolveDbPath(agentId: string): string {
    return path.join(os.homedir(), ".openclaw", `workspace-${agentId}`, "tg-join-queue.db");
}

function openDb(dbPath: string): Database.Database {
    return new Database(dbPath);
}

function ok(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
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

// ─── Tool Registrations ───────────────────────────────────────────────

export function registerJoinQueueTools(
    api: { registerTool: (tool: any, opts?: any) => void; logger: PluginLogger },
): void {
    const log = api.logger;

    // ── tg_join_queue_add ─────────────────────────────────────────────

    api.registerTool(
        {
            name: "tg_join_queue_add",
            description:
                "Add Telegram channel links to the join queue. " +
                "Duplicate links are silently ignored (INSERT OR IGNORE). " +
                "Returns counts of added and skipped (duplicate) links.",
            parameters: Type.Object({
                agentId: Type.String({
                    description: "Your agentId from the Runtime section of the system prompt",
                }),
                links: Type.Array(
                    Type.String({ description: "Telegram channel link in t.me/username format" }),
                    { description: "List of links to enqueue" },
                ),
            }),

            async execute(_id: string, params: { agentId: string; links: string[] }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(`[tg-join-queue] tg_join_queue_add — agentId=${params.agentId} links=${params.links.length}`);
                const db = openDb(dbPath);
                try {
                    ensureTable(db);
                    const now = Math.floor(Date.now() / 1000);
                    const stmt = db.prepare(
                        `INSERT OR IGNORE INTO join_queue (link, status, updatedAt) VALUES (?, 'pending', ?)`
                    );
                    let added = 0;
                    db.transaction(() => {
                        for (const link of params.links) {
                            const result = stmt.run(link.trim(), now);
                            if (result.changes > 0) added++;
                        }
                    })();
                    const skipped = params.links.length - added;
                    log.info(`[tg-join-queue] tg_join_queue_add — added=${added} skipped=${skipped}`);
                    return ok({ ok: true, added, skipped });
                } catch (err: any) {
                    log.error(`[tg-join-queue] tg_join_queue_add — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── tg_join_queue_get_batch ───────────────────────────────────────

    api.registerTool(
        {
            name: "tg_join_queue_get_batch",
            description:
                "Atomically claim the next batch of links for processing. " +
                "First resets stale 'processing' entries (older than 1 hour) back to 'pending' " +
                "so crashed runs don't block the queue. " +
                "Returns empty array when queue is exhausted (all joined/skipped or max attempts reached).",
            parameters: Type.Object({
                agentId: Type.String({
                    description: "Your agentId from the Runtime section of the system prompt",
                }),
                limit: Type.Optional(Type.Number({
                    description: `Maximum number of links to claim. Default: ${DEFAULT_BATCH_LIMIT}.`,
                })),
            }),

            async execute(_id: string, params: { agentId: string; limit?: number }) {
                const dbPath = resolveDbPath(params.agentId);
                const limit = params.limit ?? DEFAULT_BATCH_LIMIT;
                log.info(`[tg-join-queue] tg_join_queue_get_batch — agentId=${params.agentId} limit=${limit}`);
                const db = openDb(dbPath);
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

                        // Забрать следующий батч
                        const rows = db.prepare(`
                            SELECT link FROM join_queue
                            WHERE status = 'pending'
                               OR (status = 'error' AND attempts < ?)
                            ORDER BY updatedAt ASC
                            LIMIT ?
                        `).all(MAX_ATTEMPTS, limit) as { link: string }[];

                        if (rows.length > 0) {
                            const placeholders = rows.map(() => "?").join(",");
                            db.prepare(`
                                UPDATE join_queue
                                SET status = 'processing', updatedAt = ?
                                WHERE link IN (${placeholders})
                            `).run(now, ...rows.map(r => r.link));
                        }

                        return rows;
                    })();

                    log.info(`[tg-join-queue] tg_join_queue_get_batch — claimed ${batch.length} links`);
                    return ok({ links: batch.map(r => r.link) });
                } catch (err: any) {
                    log.error(`[tg-join-queue] tg_join_queue_get_batch — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── tg_join_queue_update ──────────────────────────────────────────

    api.registerTool(
        {
            name: "tg_join_queue_update",
            description:
                "Update the status of a link after a join attempt. " +
                "Use 'joined' on success, 'skipped' for permanent skips (private, invalid, etc.), " +
                "'error' for transient errors (will be retried up to 3 times total).",
            parameters: Type.Object({
                agentId: Type.String({
                    description: "Your agentId from the Runtime section of the system prompt",
                }),
                link: Type.String({ description: "The link being updated" }),
                status: Type.Union(
                    [Type.Literal("joined"), Type.Literal("skipped"), Type.Literal("error")],
                    { description: "Result of the join attempt" },
                ),
                error: Type.Optional(Type.String({
                    description: "Error message, required when status is 'error'",
                })),
            }),

            async execute(_id: string, params: { agentId: string; link: string; status: "joined" | "skipped" | "error"; error?: string }) {
                const dbPath = resolveDbPath(params.agentId);
                log.info(`[tg-join-queue] tg_join_queue_update — link=${params.link} status=${params.status}`);
                const db = openDb(dbPath);
                try {
                    ensureTable(db);
                    const now = Math.floor(Date.now() / 1000);
                    db.prepare(`
                        UPDATE join_queue
                        SET status = ?, attempts = attempts + 1, lastError = ?, updatedAt = ?
                        WHERE link = ?
                    `).run(params.status, params.error ?? null, now, params.link);
                    return ok({ ok: true });
                } catch (err: any) {
                    log.error(`[tg-join-queue] tg_join_queue_update — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );

    // ── tg_join_queue_stats ───────────────────────────────────────────

    api.registerTool(
        {
            name: "tg_join_queue_stats",
            description: "Get current queue statistics: counts by status. Useful to check progress.",
            parameters: Type.Object({
                agentId: Type.String({
                    description: "Your agentId from the Runtime section of the system prompt",
                }),
            }),

            async execute(_id: string, params: { agentId: string }) {
                const dbPath = resolveDbPath(params.agentId);
                const db = openDb(dbPath);
                try {
                    ensureTable(db);
                    const rows = db.prepare(`
                        SELECT status, COUNT(*) as count FROM join_queue GROUP BY status
                    `).all() as { status: string; count: number }[];
                    const stats = Object.fromEntries(rows.map(r => [r.status, r.count]));
                    log.info(`[tg-join-queue] tg_join_queue_stats — ${JSON.stringify(stats)}`);
                    return ok(stats);
                } catch (err: any) {
                    log.error(`[tg-join-queue] tg_join_queue_stats — error: ${err.message ?? err}`);
                    return fail(err);
                } finally {
                    db.close();
                }
            },
        },
        { optional: true },
    );
}