// core/db/discovery.ts — единый реестр найденных каналов (channel-discovery).
//
// Одна таблица в ~/.openclaw/workspace-<adminAgentId>/discovery.db:
//   • discovered_channels — один канал на всю платформу, назначенный одному агенту.
//
// У реестра ровно одна задача: знать, какой канал уже известен (дедуп) и какому
// агенту он назначен (непересечение). Инвариант «один канал — один агент навсегда»
// держится на уникальности canonical_link (PK), а не на коде раскладки.
// Design: docs/design/channel-discovery/channel-discovery-v1.md.

import Database from "better-sqlite3";
import { discoveryDbPath } from "../config";

// ─── Helpers ──────────────────────────────────────────────────────────

const initializedDbs = new Set<string>();

function openDb(adminAgentId: string): Database.Database {
    const db = new Database(discoveryDbPath(adminAgentId));
    ensureSchema(db, adminAgentId);
    return db;
}

function ensureSchema(db: Database.Database, key: string): void {
    if (initializedDbs.has(key)) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS discovered_channels (
            canonical_link TEXT PRIMARY KEY,
            assigned_agent TEXT,
            added_at INTEGER NOT NULL DEFAULT 0,
            sub_count REAL,
            avg_views REAL,
            p50_user REAL,
            p90_users REAL,
            comments_per_day REAL
        );
    `);
    // Аддитивная миграция уже существующих БД (до колонки added_at): старые строки
    // получают 0 (дата неизвестна), новые — реальный timestamp в registerChannel.
    const cols = (db.prepare(`PRAGMA table_info(discovered_channels)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("added_at")) {
        db.exec(`ALTER TABLE discovered_channels ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0`);
    }
    // Метрики канала (nullable — источник заполнения вне скоупа этого модуля).
    if (!cols.includes("sub_count")) db.exec(`ALTER TABLE discovered_channels ADD COLUMN sub_count REAL`);
    if (!cols.includes("avg_views")) db.exec(`ALTER TABLE discovered_channels ADD COLUMN avg_views REAL`);
    if (!cols.includes("p50_user")) db.exec(`ALTER TABLE discovered_channels ADD COLUMN p50_user REAL`);
    if (!cols.includes("p90_users")) db.exec(`ALTER TABLE discovered_channels ADD COLUMN p90_users REAL`);
    if (!cols.includes("comments_per_day")) db.exec(`ALTER TABLE discovered_channels ADD COLUMN comments_per_day REAL`);
    // Миграция v2: assigned_agent NOT NULL → nullable (discovery-similar-parallel);
    // v3: убрать banned_at (механизм бан/переназначение упразднён). SQLite не
    // поддерживает ALTER COLUMN/DROP COLUMN на старых версиях — пересборка таблицы.
    const colInfo = db.prepare(`PRAGMA table_info(discovered_channels)`).all() as { name: string; notnull: number }[];
    const assignedCol = colInfo.find((c) => c.name === "assigned_agent");
    const hasBannedAt = colInfo.some((c) => c.name === "banned_at");
    if (assignedCol?.notnull || hasBannedAt) {
        db.exec(`
            CREATE TABLE discovered_channels_new (
                canonical_link TEXT PRIMARY KEY,
                assigned_agent TEXT,
                added_at INTEGER NOT NULL DEFAULT 0,
                sub_count REAL,
                avg_views REAL,
                p50_user REAL,
                p90_users REAL,
                comments_per_day REAL
            );
            INSERT INTO discovered_channels_new (canonical_link, assigned_agent, added_at, sub_count, avg_views, p50_user, p90_users, comments_per_day)
                SELECT canonical_link, assigned_agent, added_at, sub_count, avg_views, p50_user, p90_users, comments_per_day FROM discovered_channels;
            DROP TABLE discovered_channels;
            ALTER TABLE discovered_channels_new RENAME TO discovered_channels;
        `);
    }
    // Метрики произвольного меняющегося состава (channel-distribution): единое
    // JSON-поле вместо фиксированных колонок выше. Легаси-колонки (sub_count/…)
    // остаются на месте (обратимость, читателей у них нет), но новые метрики из
    // CSV пишутся сюда — см. setChannelMetricsJson. Аддитивная миграция; стоит
    // ПОСЛЕ пересборки таблицы v2/v3 выше, иначе пересборка отбросила бы колонку.
    const colsAfterRebuild = (db.prepare(`PRAGMA table_info(discovered_channels)`).all() as { name: string }[]).map((c) => c.name);
    if (!colsAfterRebuild.includes("metrics_json")) db.exec(`ALTER TABLE discovered_channels ADD COLUMN metrics_json TEXT`);
    // Имя пула агента (channel-pools): закрепляется один раз при первом присвоении,
    // читается funnel-report. Отдельная таблица, а не поле в tg-account.json — это
    // факт о распределении каналов, а не о телеграм-сессии.
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_pools (
            agent_id  TEXT PRIMARY KEY,
            pool_name TEXT NOT NULL
        );
    `);
    initializedDbs.add(key);
}

// ─── Нормализация ссылки ──────────────────────────────────────────────

/**
 * Каноническая ссылка `https://t.me/<username>` (lowercase, без `@` и хвостового `/`).
 * Единый примитив дедупа реестра и доставки в join_queue: одна и та же форма должна
 * приходить и в реестр, и в addJoinQueue, иначе очередь (link UNIQUE без своей
 * нормализации) примет дубль. Источник discovery отдаёт публичные username, поэтому
 * краёв (preview `t.me/s/`, query-параметры) не ожидается.
 */
export function normalizeChannelLink(raw: string): string {
    let s = raw.trim().toLowerCase();
    s = s.replace(/^https?:\/\//, "");
    s = s.replace(/^(www\.)?(t\.me|telegram\.me)\//, "");
    s = s.replace(/^@/, "");
    s = s.split(/[/?#]/)[0]; // username до первого разделителя
    return `https://t.me/${s}`;
}

// ─── API ──────────────────────────────────────────────────────────────

/** Идемпотентно создаёт схему. Безопасно вызывать на каждом прогоне. */
export function ensureDiscoverySchema(adminAgentId: string): void {
    openDb(adminAgentId).close();
}

/** Известен ли канал реестру (дедуп). Ключ — каноническая ссылка. */
export function isKnownChannel(adminAgentId: string, canonicalLink: string): boolean {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(
            `SELECT 1 FROM discovered_channels WHERE canonical_link = ? LIMIT 1`,
        ).get(canonicalLink);
        return row !== undefined;
    } finally {
        db.close();
    }
}

/**
 * Заносит канал в реестр. Если `assignedAgent` не передан — канал записывается без
 * агента (NULL), в «пул» текущего прогона; distribute заполняет агента позже.
 * Идемпотентно: если канал уже известен — назначение не меняется (INSERT OR IGNORE).
 * @returns inserted=true если вставили новую строку, false если канал уже был.
 */
export function registerChannel(
    adminAgentId: string,
    canonicalLink: string,
    assignedAgent?: string,
): { inserted: boolean } {
    const db = openDb(adminAgentId);
    try {
        const addedAt = Math.floor(Date.now() / 1000);
        const result = db.prepare(
            `INSERT OR IGNORE INTO discovered_channels (canonical_link, assigned_agent, added_at) VALUES (?, ?, ?)`,
        ).run(canonicalLink, assignedAgent ?? null, addedAt);
        return { inserted: result.changes > 0 };
    } finally {
        db.close();
    }
}

/**
 * Записывает метрики канала (sub_count/avg_views/p50_user/p90_users/comments_per_day) —
 * частичный UPDATE, передаются только заданные поля. Источник метрик вне скоупа
 * этого модуля (см. комментарий у схемы); канал должен уже существовать в реестре.
 */
export function setChannelMetrics(
    adminAgentId: string,
    canonicalLink: string,
    metrics: { subCount?: number | null; avgViews?: number | null; p50User?: number | null; p90Users?: number | null; commentsPerDay?: number | null },
): void {
    const cols: string[] = [];
    const values: (number | null)[] = [];
    if ("subCount" in metrics) { cols.push("sub_count = ?"); values.push(metrics.subCount ?? null); }
    if ("avgViews" in metrics) { cols.push("avg_views = ?"); values.push(metrics.avgViews ?? null); }
    if ("p50User" in metrics) { cols.push("p50_user = ?"); values.push(metrics.p50User ?? null); }
    if ("p90Users" in metrics) { cols.push("p90_users = ?"); values.push(metrics.p90Users ?? null); }
    if ("commentsPerDay" in metrics) { cols.push("comments_per_day = ?"); values.push(metrics.commentsPerDay ?? null); }
    if (cols.length === 0) return;

    const db = openDb(adminAgentId);
    try {
        db.prepare(`UPDATE discovered_channels SET ${cols.join(", ")} WHERE canonical_link = ?`).run(...values, canonicalLink);
    } finally {
        db.close();
    }
}

/**
 * Записывает метрики канала как единый JSON-объект произвольного состава
 * (channel-distribution, R3): ключи — имена метрик (заголовки колонок CSV),
 * значения — как есть из ячеек. Справочные данные, на распределение не влияют.
 * Пустой объект метрик записывается как NULL (нет метрик — нет строки JSON).
 * Канал должен уже существовать в реестре (вызывается после registerChannel).
 */
export function setChannelMetricsJson(
    adminAgentId: string,
    canonicalLink: string,
    metrics: Readonly<Record<string, string>>,
): void {
    const json = Object.keys(metrics).length > 0 ? JSON.stringify(metrics) : null;
    const db = openDb(adminAgentId);
    try {
        db.prepare(`UPDATE discovered_channels SET metrics_json = ? WHERE canonical_link = ?`).run(json, canonicalLink);
    } finally {
        db.close();
    }
}

/** Каналы без назначенного агента — пул незавершённого прогона (discovery-similar-parallel). */
export function getUnassignedChannels(adminAgentId: string): string[] {
    const db = openDb(adminAgentId);
    try {
        const rows = db.prepare(
            `SELECT canonical_link FROM discovered_channels WHERE assigned_agent IS NULL ORDER BY added_at`,
        ).all() as { canonical_link: string }[];
        return rows.map((r) => r.canonical_link);
    } finally {
        db.close();
    }
}

/**
 * Назначает агента каналу, у которого агент ещё не задан (assigned_agent IS NULL).
 * Атомарно: если агент уже назначен другим прогоном — не перезаписывает.
 * @returns assigned=true если назначение прошло, false если канал уже имел агента.
 */
export function assignChannel(
    adminAgentId: string,
    canonicalLink: string,
    agent: string,
): { assigned: boolean } {
    const db = openDb(adminAgentId);
    try {
        const result = db.prepare(
            `UPDATE discovered_channels SET assigned_agent = ? WHERE canonical_link = ? AND assigned_agent IS NULL`,
        ).run(agent, canonicalLink);
        return { assigned: result.changes > 0 };
    } finally {
        db.close();
    }
}

/**
 * Удаляет канал из реестра (channel-cleanup). Строка удаляется полностью.
 * Идемпотентно: если канала нет, ошибки нет.
 */
export function deleteDiscoveredChannel(
    adminAgentId: string,
    canonicalLink: string,
): { deleted: boolean } {
    const db = openDb(adminAgentId);
    try {
        const result = db.prepare(
            `DELETE FROM discovered_channels WHERE canonical_link = ?`,
        ).run(canonicalLink);
        return { deleted: result.changes > 0 };
    } finally {
        db.close();
    }
}

/** Число назначенных каналов по агентам — для отчёта прогона (NULL-пул не включается). */
export function assignmentCounts(adminAgentId: string): Record<string, number> {
    const db = openDb(adminAgentId);
    try {
        const rows = db.prepare(
            `SELECT assigned_agent AS agent, COUNT(*) AS count FROM discovered_channels WHERE assigned_agent IS NOT NULL GROUP BY assigned_agent`,
        ).all() as { agent: string; count: number }[];
        return Object.fromEntries(rows.map((r) => [r.agent, r.count]));
    } finally {
        db.close();
    }
}

// ─── Пулы агентов (channel-pools) ──────────────────────────────────────

/** Имя пула агента (channel-pools) — null, если ещё не закреплено. Читается funnel-report. */
export function getAgentPool(adminAgentId: string, agentId: string): string | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(
            `SELECT pool_name FROM agent_pools WHERE agent_id = ?`,
        ).get(agentId) as { pool_name: string } | undefined;
        return row?.pool_name ?? null;
    } finally {
        db.close();
    }
}

/**
 * Закрепляет имя пула за агентом один раз. Если пула ещё нет — записывает и
 * возвращает `ok: true`. Если пул уже есть и совпадает — тоже `ok: true`
 * (no-op, повторный импорт того же CSV не считается конфликтом). Если пул
 * уже есть и отличается — `ok: false` с текущим значением для сообщения о
 * конфликте (импорт эту строку CSV пропускает целиком).
 */
export function trySetAgentPool(
    adminAgentId: string,
    agentId: string,
    poolName: string,
): { ok: true } | { ok: false; existing: string } {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(
            `SELECT pool_name FROM agent_pools WHERE agent_id = ?`,
        ).get(agentId) as { pool_name: string } | undefined;
        if (row === undefined) {
            db.prepare(`INSERT INTO agent_pools (agent_id, pool_name) VALUES (?, ?)`).run(agentId, poolName);
            return { ok: true };
        }
        if (row.pool_name === poolName) return { ok: true };
        return { ok: false, existing: row.pool_name };
    } finally {
        db.close();
    }
}

// ─── Импорт канал→агент напрямую (channel-pools) ───────────────────────

/** Статус канала в реестре для ветвления импорта (register/skip). Null — канал не известен. */
export function getChannelStatus(
    adminAgentId: string,
    canonicalLink: string,
): { assignedAgent: string | null } | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(
            `SELECT assigned_agent FROM discovered_channels WHERE canonical_link = ?`,
        ).get(canonicalLink) as { assigned_agent: string | null } | undefined;
        if (row === undefined) return null;
        return { assignedAgent: row.assigned_agent };
    } finally {
        db.close();
    }
}

/**
 * Принудительно передаёт канал новому агенту независимо от текущего состояния
 * (известен/неизвестен) — в отличие от `assignChannel` (только NULL), смена
 * владельца здесь сама цель вызова (agent-pool-redistribution: готовый CSV с
 * новым распределением каналов по агентам).
 */
export function forceAssignChannel(adminAgentId: string, canonicalLink: string, agent: string): void {
    const db = openDb(adminAgentId);
    try {
        const addedAt = Math.floor(Date.now() / 1000);
        db.prepare(`
            INSERT INTO discovered_channels (canonical_link, assigned_agent, added_at)
            VALUES (?, ?, ?)
            ON CONFLICT(canonical_link) DO UPDATE SET assigned_agent = excluded.assigned_agent
        `).run(canonicalLink, agent, addedAt);
    } finally {
        db.close();
    }
}

/**
 * Принудительно (пере)записывает имя пула агента — в отличие от `trySetAgentPool`
 * (лочит один раз, конфликт = пропуск строки вызывающим), новое имя всегда
 * побеждает. Для того же сценария принудительного перераспределения.
 */
export function setAgentPool(adminAgentId: string, agentId: string, poolName: string): void {
    const db = openDb(adminAgentId);
    try {
        db.prepare(`
            INSERT INTO agent_pools (agent_id, pool_name) VALUES (?, ?)
            ON CONFLICT(agent_id) DO UPDATE SET pool_name = excluded.pool_name
        `).run(agentId, poolName);
    } finally {
        db.close();
    }
}
