// core/db/metrics-pipeline.ts — хранилище прогонов конвейера метрик
// (channel-metrics-pipeline). Одна таблица `metrics_pipeline_tasks` (уровень
// прогона) в channel-metrics-pipeline.db (workspace админ-агента, как
// channel-distribution.db). Несёт статус, параметры прогона (агенты пула, фильтр),
// прогресс (total/processed) и пути файлов — чтобы `/status` и guard «один прогон
// за раз» переживали рестарт слушателя (расчёт идёт в отдельном процессе).

import Database from "better-sqlite3";
import { metricsPipelineDbPath } from "../config";

// ─── Types ────────────────────────────────────────────────────────────

export type PipelineTaskStatus = "running" | "done" | "error";

export interface PipelineTaskRow {
    id: number;
    status: PipelineTaskStatus;
    agents: string;
    filterColumn: string;
    filterThreshold: number;
    total: number;
    processed: number;
    passedCount: number;
    inputPath: string;
    outputPath: string;
    resultPath: string | null;
    requesterId: string;
    createdAt: number;
    finishedAt: number | null;
    error: string | null;
}

export interface CreatePipelineTaskParams {
    agents: string[];
    filterColumn: string;
    filterThreshold: number;
    inputPath: string;
    outputPath: string;
    requesterId: string;
}

export interface FinishPipelineTaskParams {
    status: Extract<PipelineTaskStatus, "done" | "error">;
    passedCount?: number;
    resultPath?: string | null;
    error?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(adminAgentId: string): Database.Database {
    const db = new Database(metricsPipelineDbPath(adminAgentId));
    ensureSchema(db);
    return db;
}

function ensureSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS metrics_pipeline_tasks (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            status           TEXT    NOT NULL,
            agents           TEXT    NOT NULL,
            filter_column    TEXT    NOT NULL,
            filter_threshold REAL    NOT NULL,
            total            INTEGER NOT NULL DEFAULT 0,
            processed        INTEGER NOT NULL DEFAULT 0,
            passed_count     INTEGER NOT NULL DEFAULT 0,
            input_path       TEXT    NOT NULL,
            output_path      TEXT    NOT NULL,
            result_path      TEXT,
            requester_id     TEXT    NOT NULL,
            created_at       INTEGER NOT NULL,
            finished_at      INTEGER,
            error            TEXT
        );
    `);
}

interface RawRow {
    id: number;
    status: string;
    agents: string;
    filter_column: string;
    filter_threshold: number;
    total: number;
    processed: number;
    passed_count: number;
    input_path: string;
    output_path: string;
    result_path: string | null;
    requester_id: string;
    created_at: number;
    finished_at: number | null;
    error: string | null;
}

function mapRow(row: RawRow): PipelineTaskRow {
    return {
        id: row.id,
        status: row.status as PipelineTaskStatus,
        agents: row.agents,
        filterColumn: row.filter_column,
        filterThreshold: row.filter_threshold,
        total: row.total,
        processed: row.processed,
        passedCount: row.passed_count,
        inputPath: row.input_path,
        outputPath: row.output_path,
        resultPath: row.result_path,
        requesterId: row.requester_id,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
        error: row.error,
    };
}

// ─── API ──────────────────────────────────────────────────────────────

/** Идемпотентно создаёт схему. Безопасно вызывать на каждом прогоне. */
export function ensurePipelineSchema(adminAgentId: string): void {
    openDb(adminAgentId).close();
}

/**
 * Есть ли незавершённая задача (guard «один прогон за раз»): расчёт идёт в
 * отдельном процессе часами, второй запуск поверх недопустим. Источник истины
 * «занято» — статус `running`.
 */
export function hasUnfinishedPipelineTask(adminAgentId: string): boolean {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`SELECT 1 FROM metrics_pipeline_tasks WHERE status = 'running' LIMIT 1`).get();
        return row !== undefined;
    } finally {
        db.close();
    }
}

/** Создаёт строку задачи в статусе `running`, возвращает её id. `agents` — CSV пула. */
export function createPipelineTask(adminAgentId: string, params: CreatePipelineTaskParams): number {
    const db = openDb(adminAgentId);
    try {
        const result = db.prepare(`
            INSERT INTO metrics_pipeline_tasks
                (status, agents, filter_column, filter_threshold, input_path, output_path, requester_id, created_at)
            VALUES ('running', @agents, @filterColumn, @filterThreshold, @inputPath, @outputPath, @requesterId, @createdAt)
        `).run({
            agents: params.agents.join(","),
            filterColumn: params.filterColumn,
            filterThreshold: params.filterThreshold,
            inputPath: params.inputPath,
            outputPath: params.outputPath,
            requesterId: params.requesterId,
            createdAt: Math.floor(Date.now() / 1000),
        });
        return Number(result.lastInsertRowid);
    } finally {
        db.close();
    }
}

/**
 * Обновляет прогресс задачи (для `/status`): всего к обработке и сколько уже
 * посчитано. Вызывается воркером по ходу расчёта.
 */
export function updatePipelineProgress(adminAgentId: string, id: number, total: number, processed: number): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`UPDATE metrics_pipeline_tasks SET total = @total, processed = @processed WHERE id = @id`).run({
            total,
            processed,
            id,
        });
    } finally {
        db.close();
    }
}

/**
 * Завершает задачу: статус `done`/`error`, число прошедших фильтр, путь к итоговому
 * CSV и текст ошибки (если прогон упал). Вызывается один раз в конце прогона.
 */
export function finishPipelineTask(adminAgentId: string, id: number, params: FinishPipelineTaskParams): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`
            UPDATE metrics_pipeline_tasks
            SET status = @status, passed_count = @passedCount, result_path = @resultPath,
                error = @error, finished_at = @finishedAt
            WHERE id = @id
        `).run({
            status: params.status,
            passedCount: params.passedCount ?? 0,
            resultPath: params.resultPath ?? null,
            error: params.error ?? null,
            finishedAt: Math.floor(Date.now() / 1000),
            id,
        });
    } finally {
        db.close();
    }
}

/** Задача по id. */
export function getPipelineTask(adminAgentId: string, id: number): PipelineTaskRow | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`SELECT * FROM metrics_pipeline_tasks WHERE id = ?`).get(id) as RawRow | undefined;
        return row ? mapRow(row) : null;
    } finally {
        db.close();
    }
}

/** Последняя по времени задача — для `/status` без явного id. */
export function getLatestPipelineTask(adminAgentId: string): PipelineTaskRow | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`SELECT * FROM metrics_pipeline_tasks ORDER BY id DESC LIMIT 1`).get() as RawRow | undefined;
        return row ? mapRow(row) : null;
    } finally {
        db.close();
    }
}
