// core/db/tasks.ts — таблица расписания задач агента (architecture.md §3.3).
//
// Расписание хранится в БД, а не в systemd-таймере: один heartbeat-таймер не
// описывает разные периоды задач. Поле `schedule` — cron-выражение + `tz` (R-A1).
// Уникальность по (agentId, type); выборка назревших по (enabled, nextRun).
// Лежит в ~/.openclaw/workspace-<agentId>/tasks.db рядом с прочими БД агента.
//
// Потребители (создаются в следующих разделах): диспетчер (раздел 4) читает
// назревшие задачи и сдвигает nextRun; OpenClaw-скилл-пульт (раздел 6) делает
// upsert расписания и внеплановый запуск (setTaskDueNow).

import Database from "better-sqlite3";
import { parseExpression } from "cron-parser";
import { tasksDbPath } from "../config";

/** Типы задач = портированные скиллы (раздел 2). */
export type TaskType = "monitor" | "dm-send" | "dm-replies" | "account-warmup" | "join-queue";

export interface TaskRow {
    agentId: string;
    type: TaskType;
    schedule: string;
    tz: string;
    lastRun: number | null;
    nextRun: number;
    enabled: number; // 0 | 1 (SQLite не имеет boolean)
}

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(dbPath: string, readonly = false): Database.Database {
    return new Database(dbPath, { readonly });
}

const initializedDbs = new Set<string>();

function ensureTable(db: Database.Database, dbPath: string): void {
    if (initializedDbs.has(dbPath)) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            agentId  TEXT    NOT NULL,
            type     TEXT    NOT NULL,
            schedule TEXT    NOT NULL,
            tz       TEXT    NOT NULL,
            lastRun  INTEGER,
            nextRun  INTEGER NOT NULL,
            enabled  INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (agentId, type)
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(enabled, nextRun);
    `);
    initializedDbs.add(dbPath);
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

// ─── Schema (3.1) ─────────────────────────────────────────────────────

/**
 * Идемпотентно создаёт схему `tasks`. Диспетчер вызывает на старте (шаг 0),
 * пульт-скилл — перед upsert. Безопасно вызывать на каждом прогоне.
 */
export function ensureTasksSchema(agentId: string): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
    } finally {
        db.close();
    }
}

// ─── Пересчёт срока (3.2) ─────────────────────────────────────────────

/**
 * Следующий плановый момент по cron-выражению и часовому поясу.
 * Возвращает Unix-время в секундах. R-A1: cron-выражение + tz полностью
 * описывают период (и интервальные, и календарные расписания).
 */
export function computeNextRun(schedule: string, tz: string, from: Date = new Date()): number {
    const interval = parseExpression(schedule, { tz, currentDate: from });
    return Math.floor(interval.next().toDate().getTime() / 1000);
}

// ─── Выборка и обновление ─────────────────────────────────────────────

/**
 * Назревшие задачи: enabled=1 AND nextRun <= now, отсортированные по nextRun.
 * Используется диспетчером (раздел 4, шаг 2).
 */
export function getDueTasks(agentId: string, now: number = nowSeconds()): TaskRow[] {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath, true);
    try {
        ensureTable(db, dbPath);
        return db.prepare(`
            SELECT agentId, type, schedule, tz, lastRun, nextRun, enabled
            FROM tasks
            WHERE enabled = 1 AND nextRun <= @now
            ORDER BY nextRun ASC
        `).all({ now }) as TaskRow[];
    } finally {
        db.close();
    }
}

/**
 * После прогона задачи (R-D1): lastRun = now, nextRun сдвигается ВСЕГДА —
 * и при успехе, и при ошибке (задача не застревает назревшей). Возвращает
 * новый nextRun (Unix-время в секундах).
 */
export function advanceTask(agentId: string, type: TaskType, now: number = nowSeconds()): number {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        const row = db.prepare(`SELECT schedule, tz FROM tasks WHERE agentId = @agentId AND type = @type`)
            .get({ agentId, type }) as { schedule: string; tz: string } | undefined;
        if (!row) {
            throw new Error(`Task not found: agentId=${agentId} type=${type}`);
        }
        const nextRun = computeNextRun(row.schedule, row.tz, new Date(now * 1000));
        db.prepare(`
            UPDATE tasks SET lastRun = @now, nextRun = @nextRun
            WHERE agentId = @agentId AND type = @type
        `).run({ now, nextRun, agentId, type });
        return nextRun;
    } finally {
        db.close();
    }
}

/**
 * Отключить задачу (enabled = 0). Конечные задачи (join-queue) вызывают это при
 * терминальном статусе прогона (R-A3) — задача перестаёт выбираться планировщиком.
 */
export function disableTask(agentId: string, type: TaskType): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        db.prepare(`UPDATE tasks SET enabled = 0 WHERE agentId = @agentId AND type = @type`)
            .run({ agentId, type });
    } finally {
        db.close();
    }
}

// ─── Управление расписанием (пульт, раздел 6) ─────────────────────────

/**
 * Создать/обновить задачу (§3.6): при конфликте (agentId, type) обновляет
 * расписание/tz и включает задачу. Начальный nextRun считается из cron-выражения.
 */
export function upsertTask(params: { agentId: string; type: TaskType; schedule: string; tz: string }): void {
    const { agentId, type, schedule, tz } = params;
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        const nextRun = computeNextRun(schedule, tz);
        db.prepare(`
            INSERT INTO tasks (agentId, type, schedule, tz, nextRun, enabled)
            VALUES (@agentId, @type, @schedule, @tz, @nextRun, 1)
            ON CONFLICT(agentId, type) DO UPDATE SET
                schedule = excluded.schedule,
                tz       = excluded.tz,
                enabled  = 1
        `).run({ agentId, type, schedule, tz, nextRun });
    } finally {
        db.close();
    }
}

/**
 * Внеплановый запуск (§3.6): выставляет nextRun = now, чтобы ближайший прогон
 * диспетчера подхватил задачу немедленно.
 */
export function setTaskDueNow(agentId: string, type: TaskType, now: number = nowSeconds()): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        db.prepare(`UPDATE tasks SET nextRun = @now WHERE agentId = @agentId AND type = @type`)
            .run({ now, agentId, type });
    } finally {
        db.close();
    }
}

/** Все задачи агента (любой enabled) — пульт показывает статус расписания. */
export function listTasks(agentId: string): TaskRow[] {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath, true);
    try {
        ensureTable(db, dbPath);
        return db.prepare(`
            SELECT agentId, type, schedule, tz, lastRun, nextRun, enabled
            FROM tasks
            ORDER BY type ASC
        `).all() as TaskRow[];
    } finally {
        db.close();
    }
}

/** Число активных (enabled=1) задач агента — пульт решает, гасить ли таймер. */
export function countActiveTasks(agentId: string): number {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath, true);
    try {
        ensureTable(db, dbPath);
        const row = db.prepare(`SELECT COUNT(*) AS cnt FROM tasks WHERE enabled = 1`).get() as { cnt: number };
        return row.cnt;
    } finally {
        db.close();
    }
}
