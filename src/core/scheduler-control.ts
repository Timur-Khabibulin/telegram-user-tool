// core/scheduler-control.ts — пульт управления расписанием (architecture.md §3.6).
//
// Связывает таблицу `tasks` (БД) с heartbeat-таймером агента в systemd. Скилл
// OpenClaw не запускает задачи напрямую и не решает, дёргать ли таймер — эти
// решения детерминированы и потому живут здесь, в коде, а не в натуральном
// языке скилла:
//   • первая активная задача агента  → systemctl enable --now ...timer  (6.2)
//   • внеплановый запуск              → nextRun=now + systemctl start ...service (6.3)
//   • не осталось активных задач      → systemctl disable --now ...timer (6.4)
//
// Модуль относится к core/ — от OpenClaw не зависит (только child_process + БД).
// Требует прав на управление systemd-юнитами (gateway работает от root).

import { execFile } from "child_process";
import { promisify } from "util";

import type { Logger } from "./logger";
import {
    ensureTasksSchema,
    upsertTask,
    setTaskDueNow,
    disableTask,
    countActiveTasks,
    listTasks,
    type TaskType,
    type TaskRow,
} from "./db/tasks";

const execFileAsync = promisify(execFile);

// ─── systemd-юниты агента ─────────────────────────────────────────────

function timerUnit(agentId: string): string {
    return `tg-agent@${agentId}.timer`;
}

function serviceUnit(agentId: string): string {
    return `tg-agent@${agentId}.service`;
}

export interface SystemctlResult {
    ok: boolean;
    /** Аргументы вызова — для прозрачности в отчёте пульта. */
    cmd: string;
    error?: string;
}

/**
 * Вызов systemctl. Не бросает — возвращает структурированный результат, чтобы
 * сбой управления таймером не ронял операцию с БД (строка задачи уже записана).
 */
async function systemctl(args: string[], log: Logger): Promise<SystemctlResult> {
    const cmd = `systemctl ${args.join(" ")}`;
    try {
        await execFileAsync("systemctl", args);
        log.info(`[scheduler-control] ${cmd} — ok`);
        return { ok: true, cmd };
    } catch (err: any) {
        const error = (err?.stderr?.toString?.().trim() || err?.message || String(err)) as string;
        log.error(`[scheduler-control] ${cmd} — failed: ${error}`);
        return { ok: false, cmd, error };
    }
}

// ─── 6.1 + 6.2 — создать/обновить задачу, при необходимости поднять таймер ──

export interface UpsertTaskResult {
    agentId: string;
    type: TaskType;
    schedule: string;
    tz: string;
    /** Был ли это первый активный таск агента (→ таймер включался). */
    timerEnabled: boolean;
    systemctl?: SystemctlResult;
}

/**
 * Создать или обновить задачу (6.1) и, если это первая активная задача агента,
 * включить heartbeat-таймер (6.2). При наличии других активных задач таймер уже
 * крутится — его не трогаем.
 */
export async function createOrUpdateTask(
    params: { agentId: string; type: TaskType; schedule: string; tz: string },
    log: Logger,
): Promise<UpsertTaskResult> {
    const { agentId, type, schedule, tz } = params;

    ensureTasksSchema(agentId);

    // «Первая задача» = до upsert нет ни одной активной (enabled=1). Этот же
    // сигнал верен и когда все прежние задачи были выключены (терминальный
    // join-queue) — таймер мог быть погашен, его нужно поднять заново.
    const activeBefore = countActiveTasks(agentId);

    upsertTask({ agentId, type, schedule, tz });

    let systemctlResult: SystemctlResult | undefined;
    const timerEnabled = activeBefore === 0;
    if (timerEnabled) {
        systemctlResult = await systemctl(["enable", "--now", timerUnit(agentId)], log);
    }

    return { agentId, type, schedule, tz, timerEnabled, systemctl: systemctlResult };
}

// ─── 6.3 — внеплановый запуск ────────────────────────────────────────────

export interface TriggerNowResult {
    agentId: string;
    type: TaskType;
    systemctl: SystemctlResult;
}

/**
 * Внеплановый запуск (6.3): выставить nextRun=now и пнуть сервис. Свободен —
 * диспетчер стартует сразу и увидит назревшую задачу; занят — start-job
 * коалесцируется и выполнится после текущего прогона.
 */
export async function triggerTaskNow(
    params: { agentId: string; type: TaskType },
    log: Logger,
): Promise<TriggerNowResult> {
    const { agentId, type } = params;

    ensureTasksSchema(agentId);
    setTaskDueNow(agentId, type);

    const systemctlResult = await systemctl(["start", serviceUnit(agentId)], log);
    return { agentId, type, systemctl: systemctlResult };
}

// ─── 6.4 — удалить задачу, при необходимости погасить таймер ──────────────

export interface RemoveTaskResult {
    agentId: string;
    type: TaskType;
    /** Не осталось активных задач (→ таймер гасился). */
    timerDisabled: boolean;
    systemctl?: SystemctlResult;
}

/**
 * Остановить задачу (enabled=0). Если активных задач у агента не осталось —
 * погасить heartbeat-таймер (6.4), чтобы не будить пустой диспетчер.
 */
export async function removeTask(
    params: { agentId: string; type: TaskType },
    log: Logger,
): Promise<RemoveTaskResult> {
    const { agentId, type } = params;

    ensureTasksSchema(agentId);
    disableTask(agentId, type);

    let systemctlResult: SystemctlResult | undefined;
    const timerDisabled = countActiveTasks(agentId) === 0;
    if (timerDisabled) {
        systemctlResult = await systemctl(["disable", "--now", timerUnit(agentId)], log);
    }

    return { agentId, type, timerDisabled, systemctl: systemctlResult };
}

// ─── Статус расписания ────────────────────────────────────────────────────

/** Все задачи агента с их расписанием/статусом — для отображения в пульте. */
export function getSchedule(agentId: string): TaskRow[] {
    ensureTasksSchema(agentId);
    return listTasks(agentId);
}
