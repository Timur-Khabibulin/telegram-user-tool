// core/db/discovery.ts — реестр найденных каналов (channel-discovery,
// channel-multipersona).
//
// Две таблицы в ~/.openclaw/workspace-<adminAgentId>/discovery.db:
//   • channels — один канал на всю платформу (метрики канала, «один факт — один
//     дом»); база под «полный список реестра без фильтра по персоне».
//   • channel_assignments — закрепление в разрезе персоны, PK (persona,
//     canonical_link). Инвариант «один канал — один агент В РАМКАХ ПЕРСОНЫ»
//     держится на этом PK; agent_id NULLABLE = пустой слот (канал принадлежит
//     персоне, активного агента нет — после бана до ротации).
//
// Старая таблица discovered_channels на время миграции сохраняется как резерв
// (обратимость), её читает разовый перенос данных в ensureSchema.
// Design: docs/design/channel-multipersona/architecture.md.

import Database from "better-sqlite3";
import { discoveryDbPath } from "../config";
import type { Logger } from "../logger";
import { recordAssigned, type OperationSource } from "./channel-operations";

// ─── Helpers ──────────────────────────────────────────────────────────

// Персона, за которой закрепляются каналы при разовой миграции старого реестра
// (channel-multipersona): на момент перехода весь реестр принадлежит единственной
// персоне. Значение сверено с фактическим `persona` в конфигах агентов — код
// источник истины (см. docs/design/channel-multipersona/architecture.md §4.1).
const LEGACY_PERSONA = "maria";

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
    // получают 0 (дата неизвестна), новые — реальный timestamp при вставке канала.
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
    // Мультиперсонность (channel-multipersona): реестр расщепляется на сущность
    // канала и закрепление в разрезе персоны. `channels` — одна строка на канал
    // (метрики канала — «один факт — один дом», база под «полный список реестра
    // без фильтра по персоне»). `channel_assignments` — одна строка на пару
    // (персона, канал); PK держит инвариант «один канал — один агент в рамках
    // персоны», а `agent_id` NULLABLE = пустой слот (канал принадлежит персоне,
    // активного агента нет — после бана до ротации). На время миграции новые
    // таблицы сосуществуют со старой `discovered_channels`: её читает перенос
    // данных (см. миграцию), а функции доступа переезжают отдельным шагом.
    db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
            canonical_link   TEXT PRIMARY KEY,
            added_at         INTEGER NOT NULL DEFAULT 0,
            sub_count        REAL,
            avg_views        REAL,
            p50_user         REAL,
            p90_users        REAL,
            comments_per_day REAL,
            metrics_json     TEXT
        );
        CREATE TABLE IF NOT EXISTS channel_assignments (
            persona        TEXT    NOT NULL,
            canonical_link TEXT    NOT NULL REFERENCES channels(canonical_link),
            agent_id       TEXT,
            assigned_at    INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (persona, canonical_link)
        );
        CREATE INDEX IF NOT EXISTS idx_assignments_persona ON channel_assignments(persona);
        CREATE INDEX IF NOT EXISTS idx_assignments_agent   ON channel_assignments(agent_id);
    `);
    // Разовая миграция старого реестра в две таблицы (channel-multipersona).
    // Идемпотентна: `INSERT OR IGNORE` + первичные ключи делают повтор безопасным
    // (второй прогон ничего не дублирует и не перезаписывает), поэтому отдельный
    // маркер версии схемы не нужен. Выполняется здесь, после того как у
    // `discovered_channels` уже есть все колонки (added_at/метрики домигрированы
    // выше) и целевые таблицы созданы. `discovered_channels` НЕ удаляется —
    // остаётся резервом до отдельного шага депрекейта (обратимость). Строки без
    // владельца (`assigned_agent IS NULL`) переносятся как пустой слот персоны.
    db.exec(`
        INSERT OR IGNORE INTO channels
            (canonical_link, added_at, sub_count, avg_views, p50_user, p90_users, comments_per_day, metrics_json)
        SELECT canonical_link, added_at, sub_count, avg_views, p50_user, p90_users, comments_per_day, metrics_json
        FROM discovered_channels;
    `);
    db.prepare(`
        INSERT OR IGNORE INTO channel_assignments (persona, canonical_link, agent_id, assigned_at)
        SELECT ?, canonical_link, assigned_agent, added_at
        FROM discovered_channels
    `).run(LEGACY_PERSONA);
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

/**
 * Известен ли канал реестру (существует в `channels`) — реестровая проверка для
 * обслуживания метаданных (R9), не дедуп прогона. Дедуп дискавери/распределения —
 * по персоне через `getAssignment` (канал в другой персоне — валидный кандидат).
 */
export function isKnownChannel(adminAgentId: string, canonicalLink: string): boolean {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(
            `SELECT 1 FROM channels WHERE canonical_link = ? LIMIT 1`,
        ).get(canonicalLink);
        return row !== undefined;
    } finally {
        db.close();
    }
}

/**
 * Идемпотентно заносит канал в реестр `channels` (без закрепления за персоной).
 * @returns inserted=true если вставили новую строку, false если канал уже был.
 */
export function ensureChannel(adminAgentId: string, canonicalLink: string): { inserted: boolean } {
    const db = openDb(adminAgentId);
    try {
        const addedAt = Math.floor(Date.now() / 1000);
        const result = db.prepare(
            `INSERT OR IGNORE INTO channels (canonical_link, added_at) VALUES (?, ?)`,
        ).run(canonicalLink, addedAt);
        return { inserted: result.changes > 0 };
    } finally {
        db.close();
    }
}

/**
 * Закрепление канала за агентом в рамках персоны (channel-multipersona). Канал
 * гарантированно заносится в `channels`, затем создаётся строка закрепления
 * `(persona, canonical_link)`. Идемпотентно: если канал уже закреплён в этой
 * персоне — второй слот не создаётся (`INSERT OR IGNORE` по PK), назначение не
 * меняется. Канал, закреплённый в ДРУГОЙ персоне, здесь валиден (разные строки).
 * @returns assigned=true если создали новое закрепление, false если оно уже было.
 */
export function assignToPersona(
    adminAgentId: string,
    params: { persona: string; canonicalLink: string; agentId: string },
    source: OperationSource = "module",
    log?: Logger,
): { assigned: boolean } {
    const db = openDb(adminAgentId);
    let assigned = false;
    try {
        const now = Math.floor(Date.now() / 1000);
        db.transaction(() => {
            db.prepare(`INSERT OR IGNORE INTO channels (canonical_link, added_at) VALUES (?, ?)`)
                .run(params.canonicalLink, now);
            const result = db.prepare(
                `INSERT OR IGNORE INTO channel_assignments (persona, canonical_link, agent_id, assigned_at) VALUES (?, ?, ?, ?)`,
            ).run(params.persona, params.canonicalLink, params.agentId, now);
            assigned = result.changes > 0;
        })();
    } finally {
        db.close();
    }
    // Первичное закрепление в персоне — операция assigned с пустым oldAgentId.
    if (assigned) {
        recordAssigned(
            { adminAgentId, canonicalLink: params.canonicalLink, persona: params.persona, oldAgentId: null, newAgentId: params.agentId, source },
            log,
        );
    }
    return { assigned };
}

/**
 * Текущее закрепление канала в персоне — для дедупа прогона (R4). Возвращает
 * `null`, если канала нет закрепления в этой персоне (валидный кандидат); иначе
 * `{ agentId }`, где `agentId` может быть `null` (пустой слот после бана).
 */
export function getAssignment(
    adminAgentId: string,
    persona: string,
    canonicalLink: string,
): { agentId: string | null } | null {
    const db = openDb(adminAgentId);
    try {
        const row = db.prepare(
            `SELECT agent_id FROM channel_assignments WHERE persona = ? AND canonical_link = ?`,
        ).get(persona, canonicalLink) as { agent_id: string | null } | undefined;
        if (row === undefined) return null;
        return { agentId: row.agent_id };
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
        db.prepare(`UPDATE channels SET ${cols.join(", ")} WHERE canonical_link = ?`).run(...values, canonicalLink);
    } finally {
        db.close();
    }
}

/**
 * Записывает метрики канала как единый JSON-объект произвольного состава
 * (channel-distribution, R3): ключи — имена метрик (заголовки колонок CSV),
 * значения — как есть из ячеек. Справочные данные, на распределение не влияют.
 * Пустой объект метрик записывается как NULL (нет метрик — нет строки JSON).
 * Канал должен уже существовать в реестре (вызывается после ensureChannel/assignToPersona).
 */
export function setChannelMetricsJson(
    adminAgentId: string,
    canonicalLink: string,
    metrics: Readonly<Record<string, string>>,
): void {
    const json = Object.keys(metrics).length > 0 ? JSON.stringify(metrics) : null;
    const db = openDb(adminAgentId);
    try {
        db.prepare(`UPDATE channels SET metrics_json = ? WHERE canonical_link = ?`).run(json, canonicalLink);
    } finally {
        db.close();
    }
}

/**
 * Меняет агента в существующем закреплении персоны (channel-rotation). `agentId`
 * может быть `null` — пустой слот (нет активного агента персоны после бана). Строку
 * закрепления не создаёт и не удаляет (только UPDATE); принадлежность канала
 * персоне сохраняется. Прежний агент читается в той же транзакции для журнала.
 */
export function setAssignmentAgent(
    adminAgentId: string,
    persona: string,
    canonicalLink: string,
    agentId: string | null,
    source: OperationSource = "module",
    log?: Logger,
): void {
    const db = openDb(adminAgentId);
    let oldAgent: string | null = null;
    let changed = false;
    try {
        db.transaction(() => {
            oldAgent = (db.prepare(`SELECT agent_id FROM channel_assignments WHERE persona = ? AND canonical_link = ?`)
                .get(persona, canonicalLink) as { agent_id: string | null } | undefined)?.agent_id ?? null;
            const result = db.prepare(
                `UPDATE channel_assignments SET agent_id = ? WHERE persona = ? AND canonical_link = ?`,
            ).run(agentId, persona, canonicalLink);
            changed = result.changes > 0;
        })();
    } finally {
        db.close();
    }
    if (changed) {
        recordAssigned({ adminAgentId, canonicalLink, persona, oldAgentId: oldAgent, newAgentId: agentId, source }, log);
    }
}

/**
 * Снимает закрепление канала в рамках персоны (channel-cleanup, R7). Удаляет только
 * строку `(persona, canonical_link)`; сам канал в `channels` и закрепления того же
 * канала в других персонах не трогает. Идемпотентно: если строки нет — ошибки нет.
 */
export function removeAssignment(
    adminAgentId: string,
    persona: string,
    canonicalLink: string,
): { deleted: boolean } {
    const db = openDb(adminAgentId);
    try {
        const result = db.prepare(
            `DELETE FROM channel_assignments WHERE persona = ? AND canonical_link = ?`,
        ).run(persona, canonicalLink);
        return { deleted: result.changes > 0 };
    } finally {
        db.close();
    }
}

/**
 * Число закреплённых каналов по агентам в рамках персоны — стартовая нагрузка
 * water-fill (R6). Пустые слоты (`agent_id IS NULL`) не считаются.
 */
export function assignmentCountsForPersona(adminAgentId: string, persona: string): Record<string, number> {
    const db = openDb(adminAgentId);
    try {
        const rows = db.prepare(
            `SELECT agent_id AS agent, COUNT(*) AS count FROM channel_assignments
             WHERE persona = ? AND agent_id IS NOT NULL GROUP BY agent_id`,
        ).all(persona) as { agent: string; count: number }[];
        return Object.fromEntries(rows.map((r) => [r.agent, r.count]));
    } finally {
        db.close();
    }
}

/**
 * Канонические ссылки всех каналов, закреплённых за агентом
 * (banned-account-replacement, R10): актуальный набор каналов агента из реестра
 * владения — им наполняется join-queue нового аккаунта при замене. Разрез по
 * agent_id напрямую (агент принадлежит одной персоне), а не по персоне.
 */
export function listAgentAssignmentLinks(adminAgentId: string, agentId: string): string[] {
    const db = openDb(adminAgentId);
    try {
        const rows = db.prepare(
            `SELECT canonical_link FROM channel_assignments WHERE agent_id = ?`,
        ).all(agentId) as { canonical_link: string }[];
        return rows.map((r) => r.canonical_link);
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
