// core/db/channel-operations.ts — централизованный append-only журнал операций
// над каналами (channel-operations-history).
//
// Одна БД на всю платформу в workspace админ-агента (channelOperationsDbPath).
// Владелец схемы журнала, белого списка учитываемых переходов статуса
// (classifyStatusTransition) и всех функций записи/чтения — больше нигде логики
// журнала нет. Ключ канала — chatId (глобальный marked peer id). Записи
// неизменяемы (только INSERT). Все функции записи — best-effort: сбой журнала не
// должен ронять обработку канала (журнал — наблюдаемость, не поведение).
//
// Design: docs/design/channel-operations-history/architecture.md.

import Database from "better-sqlite3";
import { channelOperationsDbPath } from "../config";
import type { Logger } from "../logger";

// ─── Types ────────────────────────────────────────────────────────────

/** Источник (актор) операции — фиксированный перечень (R6). */
export type OperationSource = "operator" | "monitor" | "timer" | "module";

/** Тип операции журнала (R3); расширяем. */
export type OperationType = "status_change" | "assigned" | "joined" | "write_access";

/**
 * Полезная нагрузка события `write_access` (channel-write-access-proactive):
 * обнаруженный статус права записи, его уровень и применённое действие + поля
 * препятствия (для `participant_banned` — `kicked_by`/`date`/`banned_rights`; для
 * `channel_restricted` — `restriction_reason`). Пишется на месте обнаружения
 * (проактивная проверка перед отправкой ЛИБО реактивный разбор ошибки).
 */
export interface WriteAccessEventPayload {
    status: string;
    level: "channel" | "account";
    action: "autorotate" | "suspend" | "suspend_temporary" | "join" | "join_request";
    kickedBy?: string;
    date?: number;
    bannedRights?: { sendMessages: boolean; untilDate: number | null };
    restrictionReason?: { platform: string; reason: string; text: string }[];
}

/** Вид учитываемого перехода статуса (белый список R8). */
export type TransitionKind = "ban" | "suspend" | "suspend_lift" | "leave_banned" | "leave_manual";

// ─── Helpers ──────────────────────────────────────────────────────────

const initializedDbs = new Set<string>();

function openDb(adminAgentId: string, readonly = false): Database.Database {
    const db = new Database(channelOperationsDbPath(adminAgentId), { readonly });
    // busy_timeout — на каждое (короткоживущее) соединение: много агентских
    // писателей в один файл (R-5). WAL включается один раз в ensureSchema.
    db.pragma("busy_timeout = 5000");
    if (!readonly) ensureSchema(db, adminAgentId);
    return db;
}

function ensureSchema(db: Database.Database, key: string): void {
    if (initializedDbs.has(key)) return;
    db.pragma("journal_mode = WAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS operations (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      INTEGER NOT NULL,
            type    TEXT    NOT NULL,
            chat_id TEXT,
            persona TEXT,
            source  TEXT    NOT NULL,
            attrs   TEXT    NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_ops_chat_type_ts ON operations(chat_id, type, ts);
        CREATE INDEX IF NOT EXISTS idx_ops_type_ts      ON operations(type, ts);

        CREATE TABLE IF NOT EXISTS channel_identity (
            canonical_link TEXT PRIMARY KEY,
            chat_id        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS journal_meta (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            started_at INTEGER NOT NULL
        );
    `);
    // Колонка persona (channel-multipersona): первоклассный разрез владения —
    // один chat_id может иметь assigned-события разных владельцев из разных персон,
    // тайм-линия строится по (chat_id, persona). Аддитивная миграция для БД,
    // созданных до колонки; nullable — исторические записи персону не знают.
    const cols = (db.prepare(`PRAGMA table_info(operations)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("persona")) db.exec(`ALTER TABLE operations ADD COLUMN persona TEXT`);
    // Граница доступности данных (R19): момент старта сбора. Пишется один раз.
    db.prepare(
        `INSERT OR IGNORE INTO journal_meta (id, started_at) VALUES (1, strftime('%s','now'))`,
    ).run();
    initializedDbs.add(key);
}

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

function appendOperation(
    db: Database.Database,
    op: { type: OperationType; chatId: string | null; persona: string | null; source: OperationSource; attrs: Record<string, unknown> },
): void {
    db.prepare(`INSERT INTO operations (ts, type, chat_id, persona, source, attrs) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(nowSec(), op.type, op.chatId, op.persona, op.source, JSON.stringify(op.attrs));
}

// ─── Schema ───────────────────────────────────────────────────────────

/** Идемпотентно создаёт схему журнала. Безопасно вызывать на каждом прогоне. */
export function ensureChannelOperationsSchema(adminAgentId: string): void {
    openDb(adminAgentId).close();
}

// ─── Белый список переходов статуса (R8) ──────────────────────────────

/**
 * Единственное место белого списка R8. Возвращает вид учитываемого перехода
 * либо null для всего прочего (`format_error`/`only_comment`/`sleep`/`not_found`/
 * `should_leave`, а также `banned→активный` при повторном вступлении — не
 * событие R8). Активное состояние (снятие статуса) представляется newStatus=null.
 */
export function classifyStatusTransition(
    oldStatus: string | null,
    newStatus: string | null,
): TransitionKind | null {
    if (newStatus === "banned" && oldStatus !== "banned") return "ban";
    if (newStatus === "suspend" && oldStatus !== "suspend") return "suspend";
    if (oldStatus === "suspend" && newStatus !== "suspend") return "suspend_lift";
    if (newStatus === "leaved_from_banned") return "leave_banned";
    if (newStatus === "leaved_manual") return "leave_manual";
    return null;
}

// ─── Функции записи (best-effort) ─────────────────────────────────────

/**
 * Собирает `attrs` события `status_change` (чистая функция — тестируется
 * изолированно). `reason` (причина права записи, channel-write-access) кладётся в
 * attrs ТОЛЬКО когда передан: баны вне пути права записи ключа `reason` не несут.
 * Схема таблицы `operations` не меняется — расширяется JSON `attrs`.
 */
export function buildStatusChangeAttrs(params: {
    agentId: string;
    oldStatus: string | null;
    newStatus: string | null;
    reason?: string;
}): Record<string, unknown> {
    const attrs: Record<string, unknown> = {
        oldAgentId: params.agentId,
        newAgentId: params.agentId,
        oldStatus: params.oldStatus,
        newStatus: params.newStatus,
    };
    if (params.reason !== undefined) attrs.reason = params.reason;
    return attrs;
}

/**
 * Фиксирует операцию смены статуса, если это учитываемый переход (R8). Повтор
 * того же состояния (например banned→banned) даёт classifyStatusTransition=null
 * и не пишется — этим закрывается дедуп R9 и правило «нового бана» R10.
 * `oldStatus`/`newStatus` берутся из живого состояния channels.status вызывающим.
 * `reason` (channel-write-access) — причина права записи для событий бана; при
 * отсутствии в attrs не пишется.
 */
export function recordStatusChange(
    params: {
        adminAgentId: string;
        chatId: string;
        agentId: string;
        oldStatus: string | null;
        newStatus: string | null;
        source: OperationSource;
        reason?: string;
    },
    log?: Logger,
): void {
    if (classifyStatusTransition(params.oldStatus, params.newStatus) === null) return;
    try {
        const db = openDb(params.adminAgentId);
        try {
            appendOperation(db, {
                type: "status_change",
                chatId: params.chatId,
                persona: null,
                source: params.source,
                attrs: buildStatusChangeAttrs(params),
            });
        } finally {
            db.close();
        }
    } catch (err: any) {
        log?.error(`[channel-operations] recordStatusChange failed — chatId=${params.chatId}: ${err?.message ?? err}`);
    }
}

/**
 * Фиксирует операцию смены владельца канала (assigned). `chatId` резолвится из
 * моста channel_identity по ссылке (может быть NULL, если канал ещё ни разу не
 * вступался — первичное назначение до join). `oldAgentId` пуст при первичном
 * назначении.
 */
export function recordAssigned(
    params: {
        adminAgentId: string;
        canonicalLink: string;
        persona: string;
        oldAgentId: string | null;
        newAgentId: string | null;
        source: OperationSource;
    },
    log?: Logger,
): void {
    try {
        const db = openDb(params.adminAgentId);
        try {
            const row = db.prepare(`SELECT chat_id FROM channel_identity WHERE canonical_link = ?`)
                .get(params.canonicalLink) as { chat_id: string } | undefined;
            appendOperation(db, {
                type: "assigned",
                chatId: row?.chat_id ?? null,
                persona: params.persona,
                source: params.source,
                attrs: {
                    oldAgentId: params.oldAgentId,
                    newAgentId: params.newAgentId,
                    canonicalLink: params.canonicalLink,
                },
            });
        } finally {
            db.close();
        }
    } catch (err: any) {
        log?.error(`[channel-operations] recordAssigned failed — link=${params.canonicalLink}: ${err?.message ?? err}`);
    }
}

/**
 * Фиксирует вступление агента в канал (joined) и наполняет мост
 * channel_identity(canonical_link, chat_id) — единственная точка, где известны
 * и ссылка, и chatId (связывает реестровые assigned с журналом по chatId, R17).
 */
export function recordJoined(
    params: {
        adminAgentId: string;
        chatId: string;
        agentId: string;
        canonicalLink: string | null;
        source: OperationSource;
    },
    log?: Logger,
): void {
    try {
        const db = openDb(params.adminAgentId);
        try {
            db.transaction(() => {
                appendOperation(db, {
                    type: "joined",
                    chatId: params.chatId,
                    persona: null,
                    source: params.source,
                    attrs: { agentId: params.agentId },
                });
                if (params.canonicalLink) {
                    db.prepare(`
                        INSERT INTO channel_identity (canonical_link, chat_id) VALUES (?, ?)
                        ON CONFLICT(canonical_link) DO UPDATE SET chat_id = excluded.chat_id
                    `).run(params.canonicalLink, params.chatId);
                }
            })();
        } finally {
            db.close();
        }
    } catch (err: any) {
        log?.error(`[channel-operations] recordJoined failed — chatId=${params.chatId}: ${err?.message ?? err}`);
    }
}

/**
 * Фиксирует событие `write_access` — обнаруженное препятствие к записи с деталями
 * (channel-write-access-proactive §5). Best-effort: сбой журнала не роняет
 * обработку канала. Отдельно от `status_change` («один факт — один дом»): здесь —
 * «обнаружено препятствие с деталями», там — «статус канала изменился».
 */
export function recordWriteAccessEvent(
    params: {
        adminAgentId: string;
        chatId: string;
        agentId: string;
        persona?: string | null;
        source: OperationSource;
        payload: WriteAccessEventPayload;
    },
    log?: Logger,
): void {
    try {
        const db = openDb(params.adminAgentId);
        try {
            appendOperation(db, {
                type: "write_access",
                chatId: params.chatId,
                persona: params.persona ?? null,
                source: params.source,
                attrs: { agentId: params.agentId, ...params.payload },
            });
        } finally {
            db.close();
        }
    } catch (err: any) {
        log?.error(`[channel-operations] recordWriteAccessEvent failed — chatId=${params.chatId}: ${err?.message ?? err}`);
    }
}

// ─── Функции чтения (выгрузки) ────────────────────────────────────────

/** Моменты (unix-сек) банов канала (по chatId) у агента (R16). */
export function getChannelBanTimes(adminAgentId: string, chatId: string, agentId: string): number[] {
    const db = openDb(adminAgentId, true);
    try {
        const rows = db.prepare(`
            SELECT ts FROM operations
            WHERE chat_id = ? AND type = 'status_change'
              AND json_extract(attrs,'$.newStatus') = 'banned'
              AND json_extract(attrs,'$.newAgentId') = ?
            ORDER BY ts
        `).all(chatId, agentId) as { ts: number }[];
        return rows.map((r) => r.ts);
    } finally {
        db.close();
    }
}

export interface OwnershipEvent {
    ts: number;
    oldAgentId: string | null;
    newAgentId: string;
}

/**
 * Тайм-линия владения каналом (R17): операции assigned по chatId, включая
 * первичные записи с chat_id=NULL, смостованные через channel_identity. При
 * заданной `persona` выборка сужается до этой персоны (channel-multipersona) —
 * события владения разных персон над одним каналом не смешиваются; исторические
 * записи с persona=NULL в сужение не попадают.
 */
export function getOwnershipTimeline(adminAgentId: string, chatId: string, persona?: string): OwnershipEvent[] {
    const db = openDb(adminAgentId, true);
    try {
        const rows = db.prepare(`
            SELECT ts,
                   json_extract(attrs,'$.oldAgentId') AS oldAgentId,
                   json_extract(attrs,'$.newAgentId') AS newAgentId
            FROM operations
            WHERE type = 'assigned'
              AND ( chat_id = @chatId
                    OR json_extract(attrs,'$.canonicalLink') IN
                         (SELECT canonical_link FROM channel_identity WHERE chat_id = @chatId) )
              AND (@persona IS NULL OR persona = @persona)
            ORDER BY ts
        `).all({ chatId, persona: persona ?? null }) as OwnershipEvent[];
        return rows;
    } finally {
        db.close();
    }
}

/**
 * Число прошлых `assigned`-событий по каналу (`chatId`) на каждого агента-получателя
 * в разрезе персоны (channel-rotation-visit-history) — visit-count для выбора цели
 * ротации. Тот же мост `chat_id ↔ canonical_link` и фильтр `persona`, что в
 * `getOwnershipTimeline`, + `GROUP BY newAgentId` + `COUNT(*)` (как `aggregateBansByAgent`).
 * `newAgentId IS NULL` (пустой слот) в счёт не идёт — это не визит к агенту.
 * Отсутствующий в результате агент трактуется вызывающим как 0 (нули не материализуем).
 */
export function getChannelVisitCounts(adminAgentId: string, chatId: string, persona?: string): Record<string, number> {
    const db = openDb(adminAgentId, true);
    try {
        const rows = db.prepare(`
            SELECT json_extract(attrs,'$.newAgentId') AS agent, COUNT(*) AS visits
            FROM operations
            WHERE type = 'assigned'
              AND ( chat_id = @chatId
                    OR json_extract(attrs,'$.canonicalLink') IN
                         (SELECT canonical_link FROM channel_identity WHERE chat_id = @chatId) )
              AND (@persona IS NULL OR persona = @persona)
              AND json_extract(attrs,'$.newAgentId') IS NOT NULL
            GROUP BY agent
        `).all({ chatId, persona: persona ?? null }) as { agent: string; visits: number }[];
        return Object.fromEntries(rows.map((r) => [r.agent, r.visits]));
    } finally {
        db.close();
    }
}

/** Число банов по каждому агенту за период [startSec, endSec) (R18). */
export function aggregateBansByAgent(adminAgentId: string, startSec: number, endSec: number): Record<string, number> {
    const db = openDb(adminAgentId, true);
    try {
        const rows = db.prepare(`
            SELECT json_extract(attrs,'$.newAgentId') AS agent, COUNT(*) AS bans
            FROM operations
            WHERE type = 'status_change'
              AND json_extract(attrs,'$.newStatus') = 'banned'
              AND ts >= @startSec AND ts < @endSec
            GROUP BY agent
        `).all({ startSec, endSec }) as { agent: string; bans: number }[];
        return Object.fromEntries(rows.map((r) => [r.agent, r.bans]));
    } finally {
        db.close();
    }
}

/**
 * Число банов по каждой причине права записи за период [startSec, endSec)
 * (channel-write-access). Разрез по `json_extract(attrs,'$.reason')`; баны без
 * причины (вне пути права записи, `reason` в attrs нет) в разрез не попадают.
 */
export function aggregateBansByReason(adminAgentId: string, startSec: number, endSec: number): Record<string, number> {
    const db = openDb(adminAgentId, true);
    try {
        const rows = db.prepare(`
            SELECT json_extract(attrs,'$.reason') AS reason, COUNT(*) AS bans
            FROM operations
            WHERE type = 'status_change'
              AND json_extract(attrs,'$.newStatus') = 'banned'
              AND json_extract(attrs,'$.reason') IS NOT NULL
              AND ts >= @startSec AND ts < @endSec
            GROUP BY reason
        `).all({ startSec, endSec }) as { reason: string; bans: number }[];
        return Object.fromEntries(rows.map((r) => [r.reason, r.bans]));
    } finally {
        db.close();
    }
}

/** Момент старта сбора журнала (R19), null если журнала ещё нет. */
export function getJournalStartedAt(adminAgentId: string): number | null {
    const db = openDb(adminAgentId, true);
    try {
        const row = db.prepare(`SELECT started_at FROM journal_meta WHERE id = 1`).get() as
            | { started_at: number }
            | undefined;
        return row?.started_at ?? null;
    } finally {
        db.close();
    }
}
