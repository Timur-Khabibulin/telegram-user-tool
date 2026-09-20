// core/db/lifecycle-transitions.ts — отложенные переходы жизненного цикла агента
// после авто-замены аккаунта (banned-account-replacement, R9–R11).
//
// Одна БД на всю платформу в workspace админ-агента (lifecycleTransitionsDbPath) —
// тот же приём, что agent-restrictions.db. При замене (T0) sweep посевает строки
// (agentId, action, run_at): старт join-queue на T0+1д, включение monitor-v5 и
// выключение warmup на T0+3д. Назревшие строки (run_at <= now AND done=0) исполняет
// тот же суточный sweep замены. Нативного nextRun недостаточно: он откладывает
// только запуск задачи, а «выключить warmup по времени» им не выражается.

import Database from "better-sqlite3";
import { lifecycleTransitionsDbPath } from "../config";

/** Действие отложенного перехода — включение/выключение задач агента через scheduler-control. */
export type LifecycleAction = "start_join_queue" | "enable_monitor_v5" | "disable_warmup";

export interface LifecycleTransitionRow {
    id: number;
    agentId: string;
    action: LifecycleAction;
    run_at: number;
    done: number;
}

export interface SeedTransition {
    action: LifecycleAction;
    runAt: number;
}

function openDb(adminAgentId: string): Database.Database {
    const db = new Database(lifecycleTransitionsDbPath(adminAgentId));
    ensureSchema(db);
    return db;
}

function ensureSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS lifecycle_transitions (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            agentId  TEXT    NOT NULL,
            action   TEXT    NOT NULL,
            run_at   INTEGER NOT NULL,
            done     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_lifecycle_due ON lifecycle_transitions(done, run_at);
    `);
}

/** Идемпотентно создаёт схему. Безопасно вызывать на каждом прогоне. */
export function ensureLifecycleTransitionsSchema(adminAgentId: string): void {
    openDb(adminAgentId).close();
}

/**
 * Посевает отложенные переходы агента (при замене, T0). Прежде удаляет незакрытые
 * (done=0) строки этого агента — повторная замена того же agentId (сбой/ретрай) не
 * должна оставлять устаревшие переходы от прошлой попытки.
 */
export function seedTransitions(adminAgentId: string, agentId: string, transitions: SeedTransition[]): void {
    const db = openDb(adminAgentId);
    try {
        db.transaction(() => {
            db.prepare(`DELETE FROM lifecycle_transitions WHERE agentId = ? AND done = 0`).run(agentId);
            const insert = db.prepare(
                `INSERT INTO lifecycle_transitions (agentId, action, run_at, done)
                 VALUES (@agentId, @action, @run_at, 0)`,
            );
            for (const t of transitions) {
                insert.run({ agentId, action: t.action, run_at: t.runAt });
            }
        })();
    } finally {
        db.close();
    }
}

/** Назревшие непройденные переходы (run_at <= now AND done=0), в порядке run_at. */
export function listDueTransitions(adminAgentId: string, now: number): LifecycleTransitionRow[] {
    const db = openDb(adminAgentId);
    try {
        return db.prepare(
            `SELECT id, agentId, action, run_at, done
             FROM lifecycle_transitions
             WHERE done = 0 AND run_at <= ?
             ORDER BY run_at ASC, id ASC`,
        ).all(now) as LifecycleTransitionRow[];
    } finally {
        db.close();
    }
}

/** Помечает переход исполненным (done=1). Идемпотентно. */
export function markTransitionDone(adminAgentId: string, id: number): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`UPDATE lifecycle_transitions SET done = 1 WHERE id = ?`).run(id);
    } finally {
        db.close();
    }
}
