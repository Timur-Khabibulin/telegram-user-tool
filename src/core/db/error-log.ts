// core/db/error-log.ts — журнал ошибок аккаунта (telegram-error-handling).
//
// Append-only, per-agent, лежит в существующей tasks.db (по прецеденту
// runs.ts/dispatcher-runs.ts — обе тоже в tasks.db, диспетчер уже открывает
// этот файл на каждом прогоне). agentId не хранится — принадлежность агенту
// определяется тем, в чьей БД лежит запись.

import Database from "better-sqlite3";
import { tasksDbPath } from "../config";

function openDb(agentId: string): Database.Database {
    const db = new Database(tasksDbPath(agentId));
    ensureTable(db);
    return db;
}

function ensureTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS error_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            skill_type   TEXT    NOT NULL,
            errorMessage TEXT    NOT NULL,
            occured_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_error_log_time ON error_log(occured_at);
    `);
}

/** Записывает срабатывание ошибки аккаунта. Append-only — существующие строки не меняются. */
export function recordAccountError(agentId: string, skillType: string, errorMessage: string): void {
    const db = openDb(agentId);
    try {
        db.prepare(`
            INSERT INTO error_log (skill_type, errorMessage, occured_at)
            VALUES (@skill_type, @errorMessage, @occured_at)
        `).run({ skill_type: skillType, errorMessage, occured_at: Math.floor(Date.now() / 1000) });
    } finally {
        db.close();
    }
}
