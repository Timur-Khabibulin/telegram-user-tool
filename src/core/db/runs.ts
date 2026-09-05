// core/db/runs.ts — таблица прогонов скиллов (run-status-tracking §1).
//
// По строке на каждый прогон скилла: исход (success/error), длительность, число
// LLM-запросов, текст ошибки. Лежит в той же per-agent БД, что и расписание
// (~/.openclaw/workspace-<agentId>/tasks.db) — агент уже открывает её каждый
// прогон. `agentId` дублируется в строках намеренно: дневная сводка объединяет
// строки из разных файлов, каждая строка самоописательна.

import Database from "better-sqlite3";
import { tasksDbPath } from "../config";
import type { TaskType } from "./tasks";

export interface RunRow {
    agentId: string;
    type: TaskType;
    startedAt: number;   // unix-сек, момент старта скилла
    durationMs: number;
    status: "success" | "error";
    error: string | null; // NULL при success
    llmCalls: number;
    cpuUserMs: number;   // process.cpuUsage().user, снятый вокруг вызова скилла
    cpuSystemMs: number; // process.cpuUsage().system, снятый вокруг вызова скилла
}

function openDb(dbPath: string): Database.Database {
    return new Database(dbPath);
}

const initializedDbs = new Set<string>();

function ensureTable(db: Database.Database, dbPath: string): void {
    if (initializedDbs.has(dbPath)) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            agentId    TEXT    NOT NULL,
            type       TEXT    NOT NULL,
            startedAt  INTEGER NOT NULL,
            durationMs INTEGER NOT NULL,
            status     TEXT    NOT NULL,
            error      TEXT,
            llmCalls   INTEGER NOT NULL,
            createdAt  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(startedAt);
    `);
    // Аддитивная миграция: CPU-поля добавлены позже (predictable-agent-scheduling) —
    // у уже существующих БД их может не быть, ALTER TABLE ADD COLUMN не имеет
    // IF NOT EXISTS в SQLite, поэтому проверяем через pragma table_info.
    const columns = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("cpuUserMs")) {
        db.exec(`ALTER TABLE runs ADD COLUMN cpuUserMs INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columnNames.has("cpuSystemMs")) {
        db.exec(`ALTER TABLE runs ADD COLUMN cpuSystemMs INTEGER NOT NULL DEFAULT 0`);
    }
    initializedDbs.add(dbPath);
}

/** Идемпотентно создаёт схему `runs`. Диспетчер зовёт на старте (шаг 0). */
export function ensureRunsSchema(agentId: string): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
    } finally {
        db.close();
    }
}

/** Записать прогон. `createdAt` ставится автоматически. */
export function insertRun(
    agentId: string,
    row: {
        type: TaskType;
        startedAt: number;
        durationMs: number;
        status: "success" | "error";
        error: string | null;
        llmCalls: number;
        cpuUserMs: number;
        cpuSystemMs: number;
    },
): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        db.prepare(`
            INSERT INTO runs (agentId, type, startedAt, durationMs, status, error, llmCalls, cpuUserMs, cpuSystemMs, createdAt)
            VALUES (@agentId, @type, @startedAt, @durationMs, @status, @error, @llmCalls, @cpuUserMs, @cpuSystemMs, @createdAt)
        `).run({
            agentId,
            type: row.type,
            startedAt: row.startedAt,
            durationMs: row.durationMs,
            status: row.status,
            error: row.error ?? null,
            llmCalls: row.llmCalls,
            cpuUserMs: row.cpuUserMs,
            cpuSystemMs: row.cpuSystemMs,
            createdAt: Math.floor(Date.now() / 1000),
        });
    } finally {
        db.close();
    }
}

/**
 * Прогоны агента с `startedAt` в полуинтервале `[startSec, endSec)`. Открывает
 * БД на запись (а не readonly) намеренно: агент мог ещё ни разу не прогоняться —
 * тогда `tasks.db`/таблицы `runs` нет, и её надо создать (пустая выборка), а не
 * упасть на readonly-открытии отсутствующего файла.
 */
export function getRunsBetween(agentId: string, startSec: number, endSec: number): RunRow[] {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        return db.prepare(`
            SELECT agentId, type, startedAt, durationMs, status, error, llmCalls, cpuUserMs, cpuSystemMs
            FROM runs
            WHERE startedAt >= @startSec AND startedAt < @endSec
            ORDER BY startedAt ASC
        `).all({ startSec, endSec }) as RunRow[];
    } finally {
        db.close();
    }
}
