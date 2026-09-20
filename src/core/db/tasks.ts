// core/db/tasks.ts — таблица расписания задач агента (architecture.md §3.3).
//
// Расписание хранится в БД, а не в systemd-таймере: один heartbeat-таймер не
// описывает разные периоды задач. Поле `schedule` — cron-выражение + `tz` (R-A1).
// Уникальность по (agentId, type); выборка назревших по (enabled, nextRun).
// Лежит в ~/.openclaw/workspace-<agentId>/tasks.db рядом с прочими БД агента.
//
// Потребители (создаются в следующих разделах): диспетчер (раздел 4) читает
// назревшие задачи и сдвигает nextRun; OpenClaw-скилл-пульт (раздел 6) делает
// upsert расписания и внеплановый запуск (setTaskDueNow).

import * as fs from "fs";
import Database from "better-sqlite3";
import { parseExpression } from "cron-parser";
import {
    tasksDbPath,
    listAgentIds,
    DISPATCHER_TICK_MINUTES,
    V5_WAKE_GAP_MIN_SEC,
    V5_WAKE_GAP_MAX_SEC,
} from "../config";

/** Типы задач = портированные скиллы (раздел 2). */
export type TaskType = "monitor" | "monitor-v2" | "monitor-v3" | "monitor-v4" | "monitor-v5" | "dm-send" | "dm-replies" | "account-warmup" | "join-queue" | "leave-banned" | "channel-context";

// ─── Дефолтное расписание по типу (agent-schedule-offset) ─────────────

/**
 * Базовый период (минуты) и `tz` по умолчанию для периодических задач —
 * перенесены 1:1 из бывшей таблицы дефолтов `skills/scheduler-control/SKILL.md`
 * (Шаг 3-A). Единственный источник истины теперь код, а не markdown — нужен
 * машиночитаемо для вычисления round-robin фазы (`computeDefaultSchedule`).
 * `leave-banned` — периодическая с 180 мин (leave-banned-human-pacing;
 * раньше была календарной, раз в сутки). Календарная суточная задача
 * (`dm-send`) сюда не входит — её дефолт остаётся фиксированной строкой без
 * фазового смещения (design.md agent-schedule-offset, Non-Goals).
 */
export const DEFAULT_PERIODIC_SCHEDULE: Partial<Record<TaskType, { periodMinutes: number; tz: string }>> = {
    "monitor":         { periodMinutes: 180, tz: "Asia/Yekaterinburg" },
    "monitor-v2":      { periodMinutes: 180, tz: "Asia/Yekaterinburg" },
    "monitor-v3":      { periodMinutes: 300, tz: "Asia/Yekaterinburg" },
    "monitor-v4":      { periodMinutes: 300, tz: "Asia/Yekaterinburg" },
    "monitor-v5":      { periodMinutes: 180, tz: "Asia/Yekaterinburg" },
    "join-queue":      { periodMinutes: 240, tz: "Asia/Yekaterinburg" },
    "leave-banned":    { periodMinutes: 180, tz: "Asia/Yekaterinburg" },
    "account-warmup": { periodMinutes: 300, tz: "UTC" },
    "dm-replies":     { periodMinutes: 30, tz: "Asia/Yekaterinburg" },
    "channel-context": { periodMinutes: 480, tz: "Asia/Yekaterinburg" },
};

export const DEFAULT_CALENDAR_SCHEDULE: Partial<Record<TaskType, { schedule: string; tz: string }>> = {
    "dm-send": { schedule: "0 14 * * *", tz: "Asia/Yekaterinburg" },
};

export interface TaskRow {
    agentId: string;
    type: TaskType;
    schedule: string;
    tz: string;
    lastRun: number | null;
    nextRun: number;
    enabled: number; // 0 | 1 (SQLite не имеет boolean)
}

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(dbPath: string, readonly = false): Database.Database {
    return new Database(dbPath, { readonly });
}

const initializedDbs = new Set<string>();

/**
 * Возвращает, есть ли таблица `tasks` после вызова (readonly не может её создать).
 *
 * `readonly=true` — вызывающий открыл БД read-only (getDueTasks/listTasks/
 * countActiveTasks): для только что созданного агента (диспетчер/пульт ни разу
 * не писали в tasks.db, задач ещё не назначено) таблицы может не быть, а на
 * readonly-соединении её создать нельзя. Раньше здесь безусловно шёл
 * `CREATE TABLE IF NOT EXISTS` — для уже существующей схемы SQLite молча
 * no-op'ает его и на readonly-соединении, но если таблицы ДЕЙСТВИТЕЛЬНО нет,
 * SQLite пытается её реально создать и падает `SQLITE_READONLY: attempt to
 * write a readonly database` (funnel-tracker.ts, 2026-07-23/24 — читает чужие
 * tasks.db через isAgentActive readonly). Для readonly в этом случае просто
 * считаем, что задач нет — создаст владеющий процесс через ensureTasksSchema.
 *
 * Это НЕ покрывает случай, когда самого файла `tasks.db` ещё нет (агент только
 * что создан, ни диспетчер, ни пульт ни разу не писали): readonly-соединение
 * не может даже открыть несуществующий файл и падает `SQLITE_CANTOPEN: unable
 * to open database file` до того, как эта функция вообще вызвана — поэтому
 * вызывающие readonly-функции сами проверяют `fs.existsSync` перед `openDb`.
 */
function ensureTable(db: Database.Database, dbPath: string, readonly = false): boolean {
    if (initializedDbs.has(dbPath)) return true;
    if (readonly) {
        const exists = db.prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`,
        ).get();
        if (exists) initializedDbs.add(dbPath);
        return exists !== undefined;
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            agentId  TEXT    NOT NULL,
            type     TEXT    NOT NULL,
            schedule TEXT    NOT NULL,
            tz       TEXT    NOT NULL,
            lastRun  INTEGER,
            nextRun  INTEGER NOT NULL,
            enabled  INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (agentId, type)
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(enabled, nextRun);
    `);
    initializedDbs.add(dbPath);
    return true;
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

// ─── Schema (3.1) ─────────────────────────────────────────────────────

/**
 * Идемпотентно создаёт схему `tasks`. Диспетчер вызывает на старте (шаг 0),
 * пульт-скилл — перед upsert. Безопасно вызывать на каждом прогоне.
 */
export function ensureTasksSchema(agentId: string): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
    } finally {
        db.close();
    }
}

// ─── Пересчёт срока (3.2) ─────────────────────────────────────────────

/**
 * Следующий плановый момент по cron-выражению и часовому поясу.
 * Возвращает Unix-время в секундах. R-A1: cron-выражение + tz полностью
 * описывают период (и интервальные, и календарные расписания).
 */
export function computeNextRun(schedule: string, tz: string, from: Date = new Date()): number {
    const interval = parseExpression(schedule, { tz, currentDate: from });
    return Math.floor(interval.next().toDate().getTime() / 1000);
}

// ─── Тихие часы (нерабочее окно) ───────────────────────────────────────

/**
 * Нерабочее окно: с QUIET_HOURS_START_HOUR текущего дня до QUIET_HOURS_END_HOUR
 * следующего по QUIET_HOURS_TZ — nextRun не назначается внутрь окна ни одной
 * задаче, кроме перечисленных в QUIET_HOURS_EXEMPT_TASKS. Сбор статистики
 * (funnel-tracker) — отдельный systemd-таймер вне таблицы `tasks`, этим не
 * затрагивается и в списке исключений не нуждается.
 */
export const QUIET_HOURS_START_HOUR = 23;
export const QUIET_HOURS_END_HOUR = 3;
export const QUIET_HOURS_TZ = "Asia/Yekaterinburg";
export const QUIET_HOURS_EXEMPT_TASKS: TaskType[] = ["leave-banned"];

function isQuietHour(date: Date): boolean {
    const hour = Number(
        new Intl.DateTimeFormat("en-US", {
            hour: "2-digit",
            hourCycle: "h23",
            timeZone: QUIET_HOURS_TZ,
        }).format(date),
    );
    return hour >= QUIET_HOURS_START_HOUR || hour < QUIET_HOURS_END_HOUR;
}

/**
 * Следующий срок по расписанию, гарантированно вне тихих часов (кроме типов
 * из QUIET_HOURS_EXEMPT_TASKS). Период не меняется — пересчитывает вперёд по
 * тому же cron-выражению, пока результат не окажется вне окна, вместо того
 * чтобы откладывать уже назревшую задачу до конца окна (не копит backlog).
 */
/**
 * Случайный следующий запуск (human-pacing monitor-v5): вместо жёсткого cron —
 * «сейчас + случайные V5_WAKE_GAP_MIN_SEC..MAX». При окне бодрствования
 * 03:00-23:00 это 5-8 прогонов в сутки, и агенты автоматически расходятся во
 * времени, а не стартуют все в одну минуту. Попадание в тихие часы сдвигается
 * вперёд случайным шагом (10-30 мин), чтобы отложенные прогоны не собирались
 * все ровно на 03:00.
 */
export function randomNextRun(fromSec: number): number {
    let candidate = fromSec + Math.round(V5_WAKE_GAP_MIN_SEC + Math.random() * (V5_WAKE_GAP_MAX_SEC - V5_WAKE_GAP_MIN_SEC));
    let guard = 0;
    while (isQuietHour(new Date(candidate * 1000)) && guard < 200) {
        candidate += Math.round(600 + Math.random() * 1200);
        guard += 1;
    }
    return candidate;
}

export function nextRunOutsideQuietHours(schedule: string, tz: string, from: Date, type: TaskType): number {
    let candidate = computeNextRun(schedule, tz, from);
    if (QUIET_HOURS_EXEMPT_TASKS.includes(type)) return candidate;
    while (isQuietHour(new Date(candidate * 1000))) {
        candidate = computeNextRun(schedule, tz, new Date(candidate * 1000));
    }
    return candidate;
}

// ─── Выборка и обновление ─────────────────────────────────────────────

/**
 * Назревшие задачи: enabled=1 AND nextRun <= now, отсортированные по nextRun.
 * Используется диспетчером (раздел 4, шаг 2).
 */
export function getDueTasks(agentId: string, now: number = nowSeconds()): TaskRow[] {
    const dbPath = tasksDbPath(agentId);
    if (!fs.existsSync(dbPath)) return [];
    const db = openDb(dbPath, true);
    try {
        if (!ensureTable(db, dbPath, true)) return [];
        return db.prepare(`
            SELECT agentId, type, schedule, tz, lastRun, nextRun, enabled
            FROM tasks
            WHERE enabled = 1 AND nextRun <= @now
            ORDER BY nextRun ASC
        `).all({ now }) as TaskRow[];
    } finally {
        db.close();
    }
}

/**
 * Сдвигает nextRun ДО выполнения скилла (R-D1) — база отсчёта предыдущий
 * плановый nextRun (не факт вызова, не накапливает дрейф). Вызывается до
 * `skill(ctx)`, поэтому убийство процесса во время скилла (таймаут, OOM) уже
 * не блокирует продвижение расписания — задача не может застрять назревшей.
 * Возвращает новый nextRun (Unix-время в секундах).
 */
export function advanceTask(agentId: string, type: TaskType, now: number = nowSeconds()): number {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        const row = db.prepare(`SELECT schedule, tz, nextRun FROM tasks WHERE agentId = @agentId AND type = @type`)
            .get({ agentId, type }) as { schedule: string; tz: string; nextRun: number } | undefined;
        if (!row) {
            throw new Error(`Task not found: agentId=${agentId} type=${type}`);
        }
        // monitor-v5 живёт на случайном интервале (human-pacing), остальные
        // задачи — по своему cron, как раньше.
        const nextRun =
            type === "monitor-v5"
                ? randomNextRun(now)
                : nextRunOutsideQuietHours(row.schedule, row.tz, new Date(row.nextRun * 1000), type);
        db.prepare(`
            UPDATE tasks SET lastRun = @now, nextRun = @nextRun
            WHERE agentId = @agentId AND type = @type
        `).run({ now, nextRun, agentId, type });
        return nextRun;
    } finally {
        db.close();
    }
}

/**
 * Отключить задачу (enabled = 0). Конечные задачи (join-queue) вызывают это при
 * терминальном статусе прогона (R-A3) — задача перестаёт выбираться планировщиком.
 */
export function disableTask(agentId: string, type: TaskType): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        db.prepare(`UPDATE tasks SET enabled = 0 WHERE agentId = @agentId AND type = @type`)
            .run({ agentId, type });
    } finally {
        db.close();
    }
}

// ─── Управление расписанием (пульт, раздел 6) ─────────────────────────

/**
 * Создать/обновить задачу (§3.6): при конфликте (agentId, type) обновляет
 * расписание/tz и включает задачу. Начальный nextRun считается из cron-выражения.
 */
export function upsertTask(params: { agentId: string; type: TaskType; schedule: string; tz: string }): void {
    const { agentId, type, schedule, tz } = params;
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        const nextRun = nextRunOutsideQuietHours(schedule, tz, new Date(), type);
        db.prepare(`
            INSERT INTO tasks (agentId, type, schedule, tz, nextRun, enabled)
            VALUES (@agentId, @type, @schedule, @tz, @nextRun, 1)
            ON CONFLICT(agentId, type) DO UPDATE SET
                schedule = excluded.schedule,
                tz       = excluded.tz,
                enabled  = 1
        `).run({ agentId, type, schedule, tz, nextRun });
    } finally {
        db.close();
    }
}

/**
 * Внеплановый запуск (§3.6): выставляет nextRun = now, чтобы ближайший прогон
 * диспетчера подхватил задачу немедленно.
 */
export function setTaskDueNow(agentId: string, type: TaskType, now: number = nowSeconds()): void {
    const dbPath = tasksDbPath(agentId);
    const db = openDb(dbPath);
    try {
        ensureTable(db, dbPath);
        db.prepare(`UPDATE tasks SET nextRun = @now WHERE agentId = @agentId AND type = @type`)
            .run({ now, agentId, type });
    } finally {
        db.close();
    }
}

/** Все задачи агента (любой enabled) — пульт показывает статус расписания. */
export function listTasks(agentId: string): TaskRow[] {
    const dbPath = tasksDbPath(agentId);
    if (!fs.existsSync(dbPath)) return [];
    const db = openDb(dbPath, true);
    try {
        if (!ensureTable(db, dbPath, true)) return [];
        return db.prepare(`
            SELECT agentId, type, schedule, tz, lastRun, nextRun, enabled
            FROM tasks
            ORDER BY type ASC
        `).all() as TaskRow[];
    } finally {
        db.close();
    }
}

/** Активен ли агент: включён хотя бы один монитор (monitor/monitor-v2…v5) ИЛИ account-warmup. */
export function isAgentActive(agentId: string): boolean {
    return listTasks(agentId).some(
        (t) =>
            (t.type === "monitor" ||
                t.type === "monitor-v2" ||
                t.type === "monitor-v3" ||
                t.type === "monitor-v4" ||
                t.type === "monitor-v5" ||
                t.type === "account-warmup") &&
            t.enabled === 1,
    );
}

/** Число активных (enabled=1) задач агента — пульт решает, гасить ли таймер. */
export function countActiveTasks(agentId: string): number {
    const dbPath = tasksDbPath(agentId);
    if (!fs.existsSync(dbPath)) return 0;
    const db = openDb(dbPath, true);
    try {
        if (!ensureTable(db, dbPath, true)) return 0;
        const row = db.prepare(`SELECT COUNT(*) AS cnt FROM tasks WHERE enabled = 1`).get() as { cnt: number };
        return row.cnt;
    } finally {
        db.close();
    }
}

// ─── Дефолтная фаза старта — round-robin (agent-schedule-offset) ──────

/**
 * Сколько существующих агентов уже имеют включённую задачу данного `type`.
 * Источник — сами `tasks.db` агентов (`listAgentIds()` + `listTasks()`), без
 * отдельного реестра. Используется как счётчик round-robin: следующий агент
 * получает слот `count % N_SLOTS`, а не случайный/хэшированный — так после
 * каждого полного круга каждый слот использован ровно одинаковое число раз.
 */
export function countAgentsWithEnabledTask(type: TaskType): number {
    return listAgentIds().filter((agentId) =>
        listTasks(agentId).some((t) => t.type === type && t.enabled === 1),
    ).length;
}

/**
 * cron-строка периодической задачи со сдвигом на `slot` тиков от базовой фазы.
 * Период (интервал между запусками) не меняется — сдвигается только момент
 * первого срабатывания внутри периода (agent-schedule-offset design.md §2).
 *
 * `periodMinutes` кратен часу (180, 300, …) → сдвиг кодируется и в минутном, и
 * в часовом поле (`{hourOffset}-23/{stepHours}`), т.к. шаговая форма `N/M` в
 * cron (напр. `0/3`) всегда анкерует старт к 0 и не умеет стартовать с
 * произвольного часа. `periodMinutes` короче часа (30, …) → сдвиг только в
 * минутном поле (`{minute}-59/{период}`).
 */
export function buildOffsetCron(periodMinutes: number, tickMinutes: number, slot: number): string {
    const offsetMin = slot * tickMinutes;
    if (periodMinutes % 60 === 0) {
        const stepHours = periodMinutes / 60;
        const hourOffset = Math.floor(offsetMin / 60);
        const minute = offsetMin % 60;
        return `${minute} ${hourOffset}-23/${stepHours} * * *`;
    }
    return `${offsetMin}-59/${periodMinutes} * * * *`;
}

/**
 * Дефолтное расписание задачи `type`, если пользователь не задал `schedule`
 * явно. Периодические типы (`DEFAULT_PERIODIC_SCHEDULE`) получают round-robin
 * фазу; календарные (`DEFAULT_CALENDAR_SCHEDULE`) — фиксированное время без
 * смещения (вне охвата agent-schedule-offset, design.md Non-Goals).
 */
export function computeDefaultSchedule(type: TaskType): { schedule: string; tz: string } {
    const periodic = DEFAULT_PERIODIC_SCHEDULE[type];
    if (periodic) {
        const nSlots = periodic.periodMinutes / DISPATCHER_TICK_MINUTES;
        const slot = countAgentsWithEnabledTask(type) % nSlots;
        return { schedule: buildOffsetCron(periodic.periodMinutes, DISPATCHER_TICK_MINUTES, slot), tz: periodic.tz };
    }
    const calendar = DEFAULT_CALENDAR_SCHEDULE[type];
    if (calendar) {
        return { schedule: calendar.schedule, tz: calendar.tz };
    }
    throw new Error(`No default schedule known for task type: ${type}`);
}
