// core/db/distribution.ts — хранилище прогонов распределения каналов через бот
// (channel-distribution). Одна таблица `distribution_tasks` (уровень прогона) в
// общей на платформу channel-distribution.db (workspace админ-агента, как
// discovery.db). Per-канальную детализацию исходов здесь НЕ храним — она в
// журнале прогона (journald); таблица несёт только статус, счётчики исходов и
// поля аудита (R9/R24/R27).

import Database from "better-sqlite3";
import { distributionDbPath } from "../config";

// ─── Types ────────────────────────────────────────────────────────────

export type DistributionTaskStatus = "running" | "done";

export interface DistributionOutcomeCounts {
    added: number;
    skipped: number;
    error: number;
}

export interface DistributionTaskRow {
    id: number;
    status: DistributionTaskStatus;
    filePath: string;
    persona: string;
    requesterId: string;
    addedCount: number;
    skippedCount: number;
    errorCount: number;
    createdAt: number;
    finishedAt: number | null;
}

export interface CreateDistributionTaskParams {
    filePath: string;
    persona: string;
    requesterId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(adminAgentId: string): Database.Database {
    const db = new Database(distributionDbPath(adminAgentId));
    ensureSchema(db);
    return db;
}

function ensureSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS distribution_tasks (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            status        TEXT    NOT NULL,
            file_path     TEXT    NOT NULL,
            persona       TEXT    NOT NULL,
            requester_id  TEXT    NOT NULL,
            added_count   INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            error_count   INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            finished_at   INTEGER
        );
    `);
    // channel-multipersona: колонка agents_spec переименована в persona — теперь
    // хранит имя целевой персоны, а не спек агентов (цель распределения — персона).
    // Аддитивная миграция существующих БД; таблица уровня прогона, исторических
    // читателей значения нет.
    const cols = (db.prepare(`PRAGMA table_info(distribution_tasks)`).all() as { name: string }[]).map((c) => c.name);
    if (cols.includes("agents_spec") && !cols.includes("persona")) {
        db.exec(`ALTER TABLE distribution_tasks RENAME COLUMN agents_spec TO persona`);
    }
}

function mapRow(row: {
    id: number;
    status: string;
    file_path: string;
    persona: string;
    requester_id: string;
    added_count: number;
    skipped_count: number;
    error_count: number;
    created_at: number;
    finished_at: number | null;
}): DistributionTaskRow {
    return {
        id: row.id,
        status: row.status as DistributionTaskStatus,
        filePath: row.file_path,
        persona: row.persona,
        requesterId: row.requester_id,
        addedCount: row.added_count,
        skippedCount: row.skipped_count,
        errorCount: row.error_count,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
    };
}

// ─── API ──────────────────────────────────────────────────────────────

/** Идемпотентно создаёт схему. Безопасно вызывать на каждом прогоне. */
export function ensureDistributionSchema(adminAgentId: string): void {
    openDb(adminAgentId).close();
}

/**
 * Есть ли незавершённая задача распределения (R24) — источник истины «занято».
 * Не более одной задачи одновременно: перед созданием новой вызывающий проверяет
 * это и отказывает, если true.
 */
export function hasUnfinishedTask(adminAgentId: string): boolean {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`SELECT 1 FROM distribution_tasks WHERE status != 'done' LIMIT 1`).get();
        return row !== undefined;
    } finally {
        db.close();
    }
}

/** Создаёт строку задачи в статусе `running`, возвращает её id. */
export function createDistributionTask(adminAgentId: string, params: CreateDistributionTaskParams): number {
    const db = openDb(adminAgentId);
    try {
        const result = db.prepare(`
            INSERT INTO distribution_tasks (status, file_path, persona, requester_id, created_at)
            VALUES ('running', @filePath, @persona, @requesterId, @createdAt)
        `).run({
            filePath: params.filePath,
            persona: params.persona,
            requesterId: params.requesterId,
            createdAt: Math.floor(Date.now() / 1000),
        });
        return Number(result.lastInsertRowid);
    } finally {
        db.close();
    }
}

/**
 * Завершает задачу: пишет итоговые счётчики исходов, статус `done` и время
 * завершения. Вызывается один раз в конце прогона (в т.ч. после частичного
 * успеха — уже добавленные каналы зафиксированы в реестре независимо, R25).
 */
export function finishDistributionTask(adminAgentId: string, id: number, counts: DistributionOutcomeCounts): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`
            UPDATE distribution_tasks
            SET status = 'done', added_count = @added, skipped_count = @skipped,
                error_count = @error, finished_at = @finishedAt
            WHERE id = @id
        `).run({
            added: counts.added,
            skipped: counts.skipped,
            error: counts.error,
            finishedAt: Math.floor(Date.now() / 1000),
            id,
        });
    } finally {
        db.close();
    }
}

/** Задача по id — для отдачи статуса (R10) и сводки по завершении (R9). */
export function getDistributionTask(adminAgentId: string, id: number): DistributionTaskRow | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`SELECT * FROM distribution_tasks WHERE id = ?`).get(id) as
            | Parameters<typeof mapRow>[0]
            | undefined;
        return row ? mapRow(row) : null;
    } finally {
        db.close();
    }
}

/** Последняя по времени задача — для запроса статуса без явного id. */
export function getLatestDistributionTask(adminAgentId: string): DistributionTaskRow | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`SELECT * FROM distribution_tasks ORDER BY id DESC LIMIT 1`).get() as
            | Parameters<typeof mapRow>[0]
            | undefined;
        return row ? mapRow(row) : null;
    } finally {
        db.close();
    }
}
