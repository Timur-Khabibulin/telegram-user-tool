// core/db/codex-cooldown.ts — host-level cooldown codex-аккаунтов
// (llm-multi-account-failover).
//
// В отличие от остальных БД проекта (per-agent в workspace-<agentId> или
// admin-workspace) этот стор — РЕСУРС ХОСТА: пул codex-подписок общий для всех
// telegram-агентов и всех параллельных прогонов, поэтому файл один на хост
// (~/.openclaw/codex-cooldown.db). Прогоны идут параллельными процессами, поэтому
// WAL (конкурентные читатели + один писатель) + busy_timeout.
//
// Одна строка на codex-слот. cooldown_until — единственное несущее поле доступности
// (NULL/прошлое = доступен, >now = на cooldown). Ключ — стабильное имя слота (каталог
// codex-auth/<slot>), не accessToken (ротируется) и не accountId из /wham/usage (может
// быть неизвестен при неуспехе usage-запроса).

import Database from "better-sqlite3";
import { codexCooldownDbPath } from "../config";

function openDb(): Database.Database {
    const db = new Database(codexCooldownDbPath());
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    ensureSchema(db);
    return db;
}

function ensureSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS codex_cooldown (
            account_id     TEXT    PRIMARY KEY,
            cooldown_until INTEGER,
            reached_type   TEXT,
            checked_at     INTEGER NOT NULL
        );
    `);
}

/**
 * Из переданных слотов (в порядке приоритета) возвращает те, что сейчас доступны:
 * нет строки, либо cooldown_until истёк. Порядок входного списка сохраняется.
 */
export function listAvailableAccounts(slots: string[]): string[] {
    if (slots.length === 0) return [];
    const db = openDb();
    try {
        const now = Math.floor(Date.now() / 1000);
        const rows = db
            .prepare("SELECT account_id, cooldown_until FROM codex_cooldown")
            .all() as { account_id: string; cooldown_until: number | null }[];
        const onCooldown = new Set(
            rows.filter((r) => r.cooldown_until != null && r.cooldown_until > now).map((r) => r.account_id),
        );
        return slots.filter((slot) => !onCooldown.has(slot));
    } finally {
        db.close();
    }
}

/** Выставляет cooldown слота до момента сброса (атомарный upsert, last-writer-wins). */
export function setCooldown(accountId: string, cooldownUntil: number, reachedType: string | null): void {
    const db = openDb();
    try {
        db.prepare(`
            INSERT INTO codex_cooldown (account_id, cooldown_until, reached_type, checked_at)
            VALUES (@accountId, @cooldownUntil, @reachedType, @now)
            ON CONFLICT(account_id) DO UPDATE SET
                cooldown_until = @cooldownUntil,
                reached_type   = @reachedType,
                checked_at     = @now
        `).run({
            accountId,
            cooldownUntil,
            reachedType: reachedType ?? null,
            now: Math.floor(Date.now() / 1000),
        });
    } finally {
        db.close();
    }
}

/** Момент сброса cooldown слота (unix sec) или null, если строки нет / cooldown не стоит. */
export function getCooldownUntil(accountId: string): number | null {
    const db = openDb();
    try {
        const row = db
            .prepare("SELECT cooldown_until FROM codex_cooldown WHERE account_id = ?")
            .get(accountId) as { cooldown_until: number | null } | undefined;
        return row?.cooldown_until ?? null;
    } finally {
        db.close();
    }
}
