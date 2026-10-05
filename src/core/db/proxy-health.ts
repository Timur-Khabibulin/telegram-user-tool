// core/db/proxy-health.ts — счётчик подряд идущих провалов боевого подключения
// per-agent (proxy-failure-rotation).
//
// Лежит в существующей tasks.db (по прецеденту runs.ts/dispatcher-runs.ts/error-log.ts —
// диспетчер уже открывает этот файл на каждом прогоне). Одна строка на агента:
// consecutive_failures — число провальных по связности прогонов ПОДРЯД на текущем
// прокси; proxy_key (host:port) — привязка счёта к текущему прокси, чтобы при смене
// прокси вне нового триггера (probe-подбор, reauth, ручной swap) счёт начинался заново,
// а не продолжал чужой. Сброс делают успех боевого getMe и факт ротации.

import Database from "better-sqlite3";
import { tasksDbPath } from "../config";

function openDb(agentId: string): Database.Database {
    const db = new Database(tasksDbPath(agentId));
    ensureProxyHealthSchema(db);
    return db;
}

interface ProxyHealthRow {
    consecutive_failures: number;
    proxy_key: string | null;
}

/** Создаёт схему proxy_health идемпотентно. Принимает открытую БД (для шага 0 диспетчера)
 *  или agentId (тогда открывает tasks.db сама). */
export function ensureProxyHealthSchema(target: Database.Database | string): void {
    const db = typeof target === "string" ? new Database(tasksDbPath(target)) : target;
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS proxy_health (
                agentId              TEXT    PRIMARY KEY,
                consecutive_failures INTEGER NOT NULL DEFAULT 0,
                proxy_key            TEXT,
                updated_at           INTEGER NOT NULL
            );
        `);
    } finally {
        if (typeof target === "string") db.close();
    }
}

/**
 * Провальный по связности прогон: +1 к счётчику текущего прокси. Если сохранённый
 * proxy_key не совпадает с текущим (прокси сменился вне нового триггера) — счёт
 * начинается с 1, а не продолжает прежний. Возвращает новое значение счётчика.
 */
export function incrementProxyFailures(agentId: string, proxyKey: string | null): number {
    const db = openDb(agentId);
    try {
        const row = db
            .prepare("SELECT consecutive_failures, proxy_key FROM proxy_health WHERE agentId = ?")
            .get(agentId) as ProxyHealthRow | undefined;
        const sameProxy = row != null && row.proxy_key === proxyKey;
        const next = sameProxy ? row!.consecutive_failures + 1 : 1;
        db.prepare(`
            INSERT INTO proxy_health (agentId, consecutive_failures, proxy_key, updated_at)
            VALUES (@agentId, @next, @proxy_key, @now)
            ON CONFLICT(agentId) DO UPDATE SET
                consecutive_failures = @next,
                proxy_key            = @proxy_key,
                updated_at           = @now
        `).run({ agentId, next, proxy_key: proxyKey, now: Math.floor(Date.now() / 1000) });
        return next;
    } finally {
        db.close();
    }
}

/** Сбрасывает счётчик агента в 0 (успех боевого getMe или факт ротации). */
export function resetProxyFailures(agentId: string): void {
    const db = openDb(agentId);
    try {
        db.prepare(`
            INSERT INTO proxy_health (agentId, consecutive_failures, proxy_key, updated_at)
            VALUES (@agentId, 0, NULL, @now)
            ON CONFLICT(agentId) DO UPDATE SET
                consecutive_failures = 0,
                updated_at           = @now
        `).run({ agentId, now: Math.floor(Date.now() / 1000) });
    } finally {
        db.close();
    }
}

/** Текущее значение счётчика агента (0, если строки ещё нет). */
export function getProxyFailures(agentId: string): number {
    const db = openDb(agentId);
    try {
        const row = db
            .prepare("SELECT consecutive_failures FROM proxy_health WHERE agentId = ?")
            .get(agentId) as { consecutive_failures: number } | undefined;
        return row?.consecutive_failures ?? 0;
    } finally {
        db.close();
    }
}
