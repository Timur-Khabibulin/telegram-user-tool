// core/db/dispatcher-runs.ts — таблица пиковой памяти прогона диспетчера
// (dispatcher-peak-memory-tracking).
//
// По строке на весь прогон процесса `tg-agent@<agentId>.service` (не на
// каждый скилл, как `runs`) — это та же сущность, которую убивает cgroup
// OOM-killer, поэтому память измеряется на этом уровне. Лежит в той же
// per-agent БД, что `tasks`/`runs` (~/.openclaw/workspace-<agentId>/tasks.db).

import Database from "better-sqlite3";
import { tasksDbPath } from "../config";

function openDb(dbPath: string): Database.Database {
    return new Database(dbPath);
}

const initializedDbs = new Set<string>();

function ensureTable(db: Database.Database, dbPath: string): void {
    if (initializedDbs.has(dbPath)) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS dispatcher_runs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            agentId    TEXT    NOT NULL,
            startedAt  INTEGER NOT NULL,
            taskTypes  TEXT    NOT NULL,
            peakRssKb  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dispatcher_runs_started ON dispatcher_runs(startedAt);
    `);
    initializedDbs.add(dbPath);
}

/** Идемпотентно создаёт схему `dispatcher_runs`. Диспетчер зовёт на старте (шаг 0). */
export function ensureDispatcherRunsSchema(agentId: string): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
    } finally {
        db.close();
    }
}

/** Записать пиковую память одного прогона диспетчера (один вызов на весь прогон). */
export function insertDispatcherRun(
    agentId: string,
    row: { startedAt: number; taskTypes: string; peakRssKb: number },
): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        db.prepare(`
            INSERT INTO dispatcher_runs (agentId, startedAt, taskTypes, peakRssKb)
            VALUES (@agentId, @startedAt, @taskTypes, @peakRssKb)
        `).run({
            agentId,
            startedAt: row.startedAt,
            taskTypes: row.taskTypes,
            peakRssKb: row.peakRssKb,
        });
    } finally {
        db.close();
    }
}
