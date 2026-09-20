// core/db/agent-restrictions.ts — ограничения агентов (telegram-error-handling).
//
// Одна БД на всю платформу (не per-agent), лежит в workspace админ-агента —
// тот же приём, что funnel.db/discovery.db/private-invites.db
// (agentRestrictionsDbPath, core/config.ts). Одна строка на agentId: наличие
// строки означает, что агент ограничен, отсутствие — что нет. Диспетчер
// проверяет активную запись перед запуском задач любого агента.

import Database from "better-sqlite3";
import { agentRestrictionsDbPath } from "../config";

export type RestrictionType = "banned" | "need_update_session" | "suspend" | "manual_reauth";

export interface AgentRestrictionRow {
    agentId: string;
    restriction_type: RestrictionType;
    reason: string;
    restriction_duration: number | null;
    restricted_at: number;
}

function openDb(adminAgentId: string): Database.Database {
    const db = new Database(agentRestrictionsDbPath(adminAgentId));
    ensureSchema(db);
    return db;
}

function ensureSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_restrictions (
            agentId              TEXT    PRIMARY KEY,
            restriction_type     TEXT    NOT NULL,
            reason               TEXT    NOT NULL,
            restriction_duration INTEGER,
            restricted_at        INTEGER NOT NULL
        );
    `);
}

/**
 * Создаёт/обновляет ограничение агента. Одна строка на agentId (REPLACE) —
 * новое основание не может возникнуть, пока активно текущее (диспетчер не
 * запускает задачи ограниченного агента), поэтому перезапись здесь означает
 * либо первую установку, либо ручное/автоматическое повторное срабатывание
 * после снятия.
 */
export function upsertRestriction(
    adminAgentId: string,
    agentId: string,
    restrictionType: RestrictionType,
    reason: string,
    restrictionDurationSeconds: number | null,
): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`
            INSERT INTO agent_restrictions (agentId, restriction_type, reason, restriction_duration, restricted_at)
            VALUES (@agentId, @restriction_type, @reason, @restriction_duration, @restricted_at)
            ON CONFLICT(agentId) DO UPDATE SET
                restriction_type     = excluded.restriction_type,
                reason               = excluded.reason,
                restriction_duration = excluded.restriction_duration,
                restricted_at        = excluded.restricted_at
        `).run({
            agentId,
            restriction_type: restrictionType,
            reason,
            restriction_duration: restrictionDurationSeconds,
            restricted_at: Math.floor(Date.now() / 1000),
        });
    } finally {
        db.close();
    }
}

/**
 * Активное ограничение агента, если есть. Для `suspend` с истёкшим TTL —
 * удаляет строку и возвращает null (снятие происходит здесь же, на чтении,
 * а не отдельным фоновым процессом — единственное место, где ограничение
 * проверяется, это перед запуском задач).
 */
export function getActiveRestriction(adminAgentId: string, agentId: string): AgentRestrictionRow | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(`
            SELECT agentId, restriction_type, reason, restriction_duration, restricted_at
            FROM agent_restrictions WHERE agentId = ?
        `).get(agentId) as AgentRestrictionRow | undefined;
        if (!row) return null;

        if (row.restriction_type === "suspend" && row.restriction_duration != null) {
            const expiresAt = row.restricted_at + row.restriction_duration;
            if (expiresAt <= Math.floor(Date.now() / 1000)) {
                db.prepare(`DELETE FROM agent_restrictions WHERE agentId = ?`).run(agentId);
                return null;
            }
        }
        return row;
    } finally {
        db.close();
    }
}

/**
 * Активные ограничения заданного типа по всем агентам (agent-reauth-sweep —
 * выборка кандидатов на авто-реавторизацию по типу `need_update_session`). Для
 * `suspend` с истёкшим TTL строка снимается тут же (delete-on-read, как в
 * getActiveRestriction) и в выборку не попадает; у остальных типов
 * (`need_update_session`/`banned`/`manual_reauth`) TTL нет — возвращаются все.
 */
export function listActiveByType(adminAgentId: string, type: RestrictionType): AgentRestrictionRow[] {
    const db = openDb(adminAgentId);
    try {
        const rows = db.prepare(`
            SELECT agentId, restriction_type, reason, restriction_duration, restricted_at
            FROM agent_restrictions WHERE restriction_type = ?
        `).all(type) as AgentRestrictionRow[];

        if (type !== "suspend") return rows;

        const now = Math.floor(Date.now() / 1000);
        const active: AgentRestrictionRow[] = [];
        for (const row of rows) {
            if (row.restriction_duration != null && row.restricted_at + row.restriction_duration <= now) {
                db.prepare(`DELETE FROM agent_restrictions WHERE agentId = ?`).run(row.agentId);
                continue;
            }
            active.push(row);
        }
        return active;
    } finally {
        db.close();
    }
}

/**
 * Ограничения, наложенные (впервые или повторно) в окне [startSec, endSec) —
 * для отчёта-воронки (funnel-report-restrictions). Так как `agent_restrictions`
 * хранит одну строку на agentId (REPLACE при повторном срабатывании), это
 * именно «кому наложено в отчётные сутки», не снимок текущих ограничений:
 * агент с активным, но более старым `restricted_at` (например, незакрывающийся
 * `need_update_session` с прошлых суток) в выборку не попадает.
 */
export function listRestrictionsSince(adminAgentId: string, startSec: number, endSec: number): AgentRestrictionRow[] {
    const db = openDb(adminAgentId);
    try {
        return db.prepare(`
            SELECT agentId, restriction_type, reason, restriction_duration, restricted_at
            FROM agent_restrictions WHERE restricted_at >= @startSec AND restricted_at < @endSec
        `).all({ startSec, endSec }) as AgentRestrictionRow[];
    } finally {
        db.close();
    }
}

/** Снятие ограничения вручную (оператор/скрипт) — удаляет строку по agentId. */
export function clearRestriction(adminAgentId: string, agentId: string): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`DELETE FROM agent_restrictions WHERE agentId = ?`).run(agentId);
    } finally {
        db.close();
    }
}
