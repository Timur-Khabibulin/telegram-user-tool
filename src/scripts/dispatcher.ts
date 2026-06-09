// scripts/dispatcher.ts — точка входа диспетчера на агента (architecture.md §3.2).
//
// Один процесс на прогон агента: по таблице `tasks` определяет, какие задачи
// назрели, и выполняет их последовательно на одной сессии Telegram. Так как
// точка сериализации одна (на агента), параллельных задач внутри агента не
// бывает по построению — внешний лок не нужен (R: «не более одной задачи на
// агента»). Запуск: `tsx dispatcher.ts --agent <agentId>`.
//
// Поток (design.md §3.2):
//   0. создать схему tasks (идемпотентно)
//   1. загрузить tg-account.json агента
//   2. SELECT задачи где enabled=1 AND nextRun <= now()
//   3. если пусто → выйти (за секунду, без подключения к Telegram и LLM)
//   4. connect к Telegram (ленивый, один клиент на весь прогон)
//   5. для каждой назревшей задачи последовательно: выполнить skills/*,
//      отчёт в Saved Messages (R-D1), сдвиг nextRun ВСЕГДА (R-D1),
//      при терминальном статусе enabled=0 (R-A3)
//   6. disconnect, выйти

import * as fs from "fs";

import type { Logger } from "../core/logger";
import { formatError } from "../core/errors";
import { TelegramService } from "../core/telegram/service";
import { soulPath } from "../core/config";
import {
    ensureTasksSchema,
    getDueTasks,
    advanceTask,
    disableTask,
    type TaskRow,
    type TaskType,
} from "../core/db/tasks";
import { ensureRunsSchema, insertRun } from "../core/db/runs";
import { createLlmClient } from "../llm/client";
import type { SkillContext, SkillStatus } from "../skills/types";
import { runMonitor } from "../skills/monitor";
import { runDmSend } from "../skills/dm-send";
import { runDmReplies } from "../skills/dm-replies";
import { runAccountWarmup } from "../skills/account-warmup";
import { runJoinQueue } from "../skills/join-queue";

// ─── Логгер: stdout → journald (12-factor, R: системное логирование) ──────

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

// ─── Реестр скиллов: TaskType → run-функция ───────────────────────────────

const SKILLS: Record<TaskType, (ctx: SkillContext) => Promise<SkillStatus>> = {
    "monitor": runMonitor,
    "dm-send": runDmSend,
    "dm-replies": runDmReplies,
    "account-warmup": runAccountWarmup,
    "join-queue": runJoinQueue,
};

// ─── LLM-клиент (codex OAuth primary + openai fallback) ───────────────────
const llm = createLlmClient();

// ─── Аргументы ─────────────────────────────────────────────────────────────

function parseAgentId(argv: string[]): string {
    const idx = argv.indexOf("--agent");
    const value = idx !== -1 ? argv[idx + 1] : undefined;
    if (!value || value.startsWith("--")) {
        throw new Error("Usage: dispatcher.ts --agent <agentId>");
    }
    return value;
}

// ─── Персона (R-E2) ────────────────────────────────────────────────────────

function readPersona(agentId: string): string {
    try {
        return fs.readFileSync(soulPath(agentId), "utf-8");
    } catch {
        log.warn(`[dispatcher] SOUL.md not found for agent ${agentId} — empty persona`);
        return "";
    }
}

// ─── Запись прогона (run-status-tracking §2) ─────────────────────────────────

const RUN_ERROR_LIMIT = 500;

/**
 * Текст ошибки для записи `runs`/отчёта: первое непустое из error/reason/step,
 * иначе сериализованные details. Обрезается до RUN_ERROR_LIMIT. Вызывается только
 * при status=error (при success в БД пишется null).
 */
function extractError(details: Record<string, unknown>): string | null {
    for (const key of ["error", "reason", "step"]) {
        const v = details[key];
        if (typeof v === "string" && v.trim()) return v.trim().slice(0, RUN_ERROR_LIMIT);
    }
    try {
        const s = JSON.stringify(details);
        return s && s !== "{}" ? s.slice(0, RUN_ERROR_LIMIT) : null;
    } catch {
        return null;
    }
}

// ─── Отчёт в Saved Messages (R-D1) ───────────────────────────────────────────

// Предел длины текстового значения в отчёте — чтобы тексты ответов/сообщений
// не разрастали отчёт (design.md §2).
const REPORT_TEXT_LIMIT = 280;

function truncate(s: string): string {
    return s.length > REPORT_TEXT_LIMIT ? s.slice(0, REPORT_TEXT_LIMIT) + "…" : s;
}

/**
 * Человекочитаемый рендер `details`: построчно `Ключ: значение`; вложенные
 * объекты — подсписком с отступом; длинные тексты обрезаются. Единый для всех
 * скиллов (нетронутые получают читаемый вид «бесплатно»).
 */
function renderDetails(value: Record<string, unknown>, indent: string): string[] {
    const lines: string[] = [];
    for (const [key, v] of Object.entries(value)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            lines.push(`${indent}${key}:`);
            lines.push(...renderDetails(v as Record<string, unknown>, indent + "  "));
        } else if (Array.isArray(v)) {
            lines.push(`${indent}${key}: ${truncate(JSON.stringify(v))}`);
        } else if (typeof v === "string") {
            lines.push(`${indent}${key}: ${truncate(v)}`);
        } else {
            lines.push(`${indent}${key}: ${String(v)}`);
        }
    }
    return lines;
}

function formatReport(
    agentId: string,
    type: TaskType,
    status: SkillStatus,
    nextRun: number,
    durationMs: number,
    llmCalls: number,
): string {
    const icon = status.status === "success" ? "✅" : "❌";
    const terminal = status.terminal ? " · 🛑 terminal (enabled=0)" : "";
    const nextRunIso = new Date(nextRun * 1000).toISOString();
    const durationSec = (durationMs / 1000).toFixed(1);
    return [
        `${icon} ${agentId} · ${type} · ${status.status}${terminal}`,
        `длительность: ${durationSec} с · запросов к LLM: ${llmCalls}`,
        `nextRun: ${nextRunIso}`,
        "",
        ...renderDetails(status.details, ""),
    ].join("\n");
}

// ─── Главный поток ───────────────────────────────────────────────────────

async function main(): Promise<void> {
    const agentId = parseAgentId(process.argv.slice(2));

    // Шаг 0 — схемы tasks и runs (идемпотентно).
    ensureTasksSchema(agentId);
    ensureRunsSchema(agentId);

    const tg = new TelegramService(log);

    // Шаг 1 — загрузить tg-account.json (без сети; падает рано при отсутствии).
    tg.loadAccount(agentId);

    // Шаг 2 — назревшие задачи.
    const due: TaskRow[] = getDueTasks(agentId);

    // Шаг 3 — ничего не назрело: холостой выход, Telegram/LLM не трогаем.
    if (due.length === 0) {
        log.info(`[dispatcher] agent=${agentId} — no due tasks, exiting`);
        return;
    }

    log.info(`[dispatcher] agent=${agentId} — ${due.length} due task(s): ${due.map((t) => t.type).join(", ")}`);

    const persona = readPersona(agentId);

    try {
        // Шаг 5 — выполнить назревшие задачи последовательно (один клиент на прогон,
        // подключается лениво при первой операции — шаг 4).
        for (const task of due) {
            const type = task.type;
            const skill = SKILLS[type];
            log.info(`[dispatcher] agent=${agentId} — running ${type}`);

            // Замер длительности и LLM-запросов вокруг скилла (R: единая точка для
            // всех отчётов, код скиллов не трогаем).
            const t0 = Date.now();
            const llmCallsBefore = llm.requestCount;

            let status: SkillStatus;
            try {
                const ctx: SkillContext = { agentId, persona, tg, llm, log };
                status = await skill(ctx);
            } catch (err: any) {
                // Непредвиденная ошибка скилла → статус error (R-D1: nextRun всё
                // равно сдвигается, задача не застревает назревшей).
                const error = formatError(err);
                status = { status: "error", details: { error } };
                log.error(`[dispatcher] agent=${agentId} — ${type} threw: ${error}`);
            }

            const durationMs = Date.now() - t0;
            const llmCalls = llm.requestCount - llmCallsBefore;

            // Запись прогона в runs + строка статуса в journald (§2). Сбой записи
            // не должен валить прогон — оборачиваем в try/catch.
            const errorText = status.status === "error" ? extractError(status.details) : null;
            try {
                insertRun(agentId, {
                    type,
                    startedAt: Math.floor(t0 / 1000),
                    durationMs,
                    status: status.status,
                    error: errorText,
                    llmCalls,
                });
            } catch (err: any) {
                log.error(`[dispatcher] agent=${agentId} — failed to record run for ${type}: ${err?.message ?? err}`);
            }
            log.info(`[run] agent=${agentId} type=${type} status=${status.status} durationMs=${durationMs} llmCalls=${llmCalls}${errorText ? ` error=${errorText}` : ""}`);

            // Сдвиг nextRun ВСЕГДА — и при success, и при error (R-D1).
            const nextRun = advanceTask(agentId, type);

            // Терминальный статус (join-queue, очередь исчерпана) → enabled=0 (R-A3).
            if (status.terminal) {
                disableTask(agentId, type);
                log.info(`[dispatcher] agent=${agentId} — ${type} terminal, disabled`);
            }

            // Отчёт в Saved Messages (R-D1). Сбой отправки не должен валить прогон.
            try {
                await tg.sendSavedMessage(formatReport(agentId, type, status, nextRun, durationMs, llmCalls));
            } catch (err: any) {
                log.error(`[dispatcher] agent=${agentId} — failed to send report for ${type}: ${err?.message ?? err}`);
            }
        }
    } finally {
        // Шаг 6 — disconnect (всегда, даже при ошибке), чтобы процесс завершился.
        await tg.disconnect();
    }

    log.info(`[dispatcher] agent=${agentId} — run complete`);
}

main().catch((err) => {
    log.error(`[dispatcher] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
