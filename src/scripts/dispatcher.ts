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
//      сдвиг nextRun ВСЕГДА (R-D1), при терминальном статусе enabled=0 (R-A3)
//      (отчёт в Saved Messages не отправляется — stop-agent-run-reports)
//   6. disconnect, выйти

import * as fs from "fs";

import type { Logger } from "../core/logger";
import { formatError } from "../core/errors";
import { TelegramService } from "../core/telegram/service";
import { ClientNotConnectedError, SessionRevokedError, AccountBannedError } from "../core/telegram/errors";
import { personaSoulPath, REPORT_AGENT_ID, FUNNEL_ADMIN_AGENT_ID } from "../core/config";
import {
    ensureTasksSchema,
    getDueTasks,
    advanceTask,
    disableTask,
    type TaskRow,
    type TaskType,
} from "../core/db/tasks";
import { ensureRunsSchema, insertRun } from "../core/db/runs";
import { ensureDispatcherRunsSchema, insertDispatcherRun } from "../core/db/dispatcher-runs";
import { ensureProxyHealthSchema } from "../core/db/proxy-health";
import { getActiveRestriction, upsertRestriction } from "../core/db/agent-restrictions";
import { recordAccountError } from "../core/db/error-log";
import { withLlmLogging } from "../core/db/llm-log";
import { createLlmClient } from "../llm/client";
import type { SkillContext, SkillStatus } from "../skills/types";
import { runMonitor } from "../skills/monitor";
import { runMonitorV2 } from "../skills/monitor-v2";
import { runMonitorV3 } from "../skills/monitor-v3";
import { runMonitorV4 } from "../skills/monitor-v4";
import { runMonitorV5 } from "../skills/monitor-v5";
import { runDmSend } from "../skills/dm-send";
import { runDmReplies } from "../skills/dm-replies";
import { runAccountWarmup } from "../skills/account-warmup";
import { runJoinQueue } from "../skills/join-queue";
import { runLeaveBannedChannels } from "../skills/leave-banned-channels";
import { runChannelContext } from "../skills/channel-context";

// ─── Логгер: stdout → journald (12-factor, R: системное логирование) ──────

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

// ─── Реестр скиллов: TaskType → run-функция ───────────────────────────────

const SKILLS: Record<TaskType, (ctx: SkillContext) => Promise<SkillStatus>> = {
    "monitor": runMonitor,
    "monitor-v2": runMonitorV2,
    "monitor-v3": runMonitorV3,
    "monitor-v4": runMonitorV4,
    "monitor-v5": runMonitorV5,
    "dm-send": runDmSend,
    "dm-replies": runDmReplies,
    "account-warmup": runAccountWarmup,
    "join-queue": runJoinQueue,
    "leave-banned": runLeaveBannedChannels,
    "channel-context": runChannelContext,
};

// ─── LLM-клиент (codex OAuth primary + openai fallback) ───────────────────
const llm = createLlmClient();

// ─── Лог LLM-вызовов monitor-v3/v4/channel-context ────────────────────────
// Пишет только финальный успешный результат complete/completeObject —
// неудачные попытки (ретраи невалидного JSON внутри client.ts) сюда не
// долетают, это не про содержание ответа. Ставится точечно только для
// monitor-v3/monitor-v4 (monitor-v3-post-comment-scoring) и channel-context
// (тяжёлый промпт — до 100 постов с комментариями на канал, полезно видеть
// фактический запрос/ответ при отладке), остальные скиллы используют `llm`
// как есть. Сама обёртка — `core/db/llm-log.ts` (общая для диспетчера и
// OpenClaw-плагина, не дублируется).

// ─── Аргументы ─────────────────────────────────────────────────────────────

function parseAgentId(argv: string[]): string {
    const idx = argv.indexOf("--agent");
    const value = idx !== -1 ? argv[idx + 1] : undefined;
    if (!value || value.startsWith("--")) {
        throw new Error("Usage: dispatcher.ts --agent <agentId>");
    }
    return value;
}

// ─── Персона (agent-persona-template) ──────────────────────────────────────

/**
 * Читает SOUL.md шаблона персоны заново на каждый прогон — не кэшируется и не
 * копируется в workspace агента. Отсутствие персоны/файла — фатальная ошибка,
 * пробрасывается в main().catch() (агент не должен работать с пустым промптом).
 */
function readPersona(personName: string): string {
    return fs.readFileSync(personaSoulPath(personName), "utf-8");
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

// ─── Главный поток ───────────────────────────────────────────────────────

async function main(): Promise<void> {
    const agentId = parseAgentId(process.argv.slice(2));

    // REPORT_AGENT_ID зарезервирован для получения отчётов и не выполняет
    // рабочих задач — отказ до подключения к Telegram и до обращения к БД.
    if (agentId === REPORT_AGENT_ID) {
        throw new Error(
            `agent=${agentId} is REPORT_AGENT_ID — reserved for reports, dispatcher refuses to run tasks for it`,
        );
    }

    // Шаг 0 — схемы tasks, runs, dispatcher_runs и proxy_health (идемпотентно).
    ensureTasksSchema(agentId);
    ensureRunsSchema(agentId);
    ensureDispatcherRunsSchema(agentId);
    ensureProxyHealthSchema(agentId);

    const tg = new TelegramService(log);
    // proxy-failure-rotation: диспетчер — плановый прогон, ведёт счётчик провалов прокси.
    tg.enableProxyHealthTracking();

    // Шаг 1 — загрузить tg-account.json (без сети; падает рано при отсутствии).
    tg.loadAccount(agentId);

    // Шаг 2 — назревшие задачи.
    const due: TaskRow[] = getDueTasks(agentId);

    // Шаг 3 — ничего не назрело: холостой выход, Telegram/LLM не трогаем.
    if (due.length === 0) {
        log.info(`[dispatcher] agent=${agentId} — no due tasks, exiting`);
        return;
    }

    // Шаг 3.5 — активное ограничение агента (telegram-error-handling,
    // agent-restrictions): холостой выход без подключения к Telegram, до вызова
    // LLM — тот же приём, что и холостой выход при пустом расписании выше.
    const restriction = getActiveRestriction(FUNNEL_ADMIN_AGENT_ID, agentId);
    if (restriction) {
        log.info(
            `[dispatcher] agent=${agentId} — restricted (${restriction.restriction_type}: ${restriction.reason}), exiting without connecting`,
        );
        return;
    }

    log.info(`[dispatcher] agent=${agentId} — ${due.length} due task(s): ${due.map((t) => t.type).join(", ")}`);

    const runStartedAt = Math.floor(Date.now() / 1000);
    const persona = readPersona(tg.getAccountConfig().persona);

    try {
        // Шаг 5 — выполнить назревшие задачи последовательно (один клиент на прогон,
        // подключается лениво при первой операции — шаг 4).
        for (const task of due) {
            const type = task.type;
            const skill = SKILLS[type];
            log.info(`[dispatcher] agent=${agentId} — running ${type}`);

            // Сдвиг nextRun ДО выполнения скилла (R-D1) — не блокируется убийством
            // процесса во время скилла (таймаут, OOM); исход скилла на сам сдвиг не
            // влияет, задача не может застрять назревшей.
            advanceTask(agentId, type);

            // Замер длительности, CPU и LLM-запросов вокруг скилла (R: единая точка
            // для всех отчётов, код скиллов не трогаем).
            const t0 = Date.now();
            const cpuBefore = process.cpuUsage();
            const llmCallsBefore = llm.requestCount;
            const usageBefore = llm.tokenUsage;

            let status: SkillStatus;
            let clientDisconnected = false;
            try {
                const ctxLlm = type === "monitor-v3" || type === "monitor-v4" || type === "monitor-v5" || type === "channel-context"
                    ? withLlmLogging(llm, agentId, type, log)
                    : llm;
                const ctx: SkillContext = { agentId, persona, tg, llm: ctxLlm, log };
                status = await skill(ctx);
            } catch (err: any) {
                if (err instanceof SessionRevokedError) {
                    upsertRestriction(FUNNEL_ADMIN_AGENT_ID, agentId, "need_update_session", formatError(err), null);
                    recordAccountError(agentId, type, formatError(err));
                    log.error(`[dispatcher] agent=${agentId} — ${type}: ${formatError(err)}, session revoked — restricted (need_update_session)`);
                    clientDisconnected = true;
                } else if (err instanceof AccountBannedError) {
                    upsertRestriction(FUNNEL_ADMIN_AGENT_ID, agentId, "banned", formatError(err), null);
                    recordAccountError(agentId, type, formatError(err));
                    log.error(`[dispatcher] agent=${agentId} — ${type}: ${formatError(err)}, account banned/frozen — restricted (banned)`);
                    clientDisconnected = true;
                } else if (err instanceof ClientNotConnectedError) {
                    clientDisconnected = true;
                    log.error(`[dispatcher] agent=${agentId} — ${type}: ${formatError(err)}, stopping agent run`);
                } else {
                    log.error(`[dispatcher] agent=${agentId} — ${type} threw: ${formatError(err)}`);
                }
                status = { status: "error", details: { error: formatError(err) } };
            }

            const durationMs = Date.now() - t0;
            const cpuUsed = process.cpuUsage(cpuBefore);
            const llmCalls = llm.requestCount - llmCallsBefore;
            const usageAfter = llm.tokenUsage;
            const inputTokens = usageAfter.inputTokens - usageBefore.inputTokens;
            const outputTokens = usageAfter.outputTokens - usageBefore.outputTokens;
            const totalTokens = usageAfter.totalTokens - usageBefore.totalTokens;

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
                    cpuUserMs: Math.round(cpuUsed.user / 1000),
                    cpuSystemMs: Math.round(cpuUsed.system / 1000),
                    inputTokens,
                    outputTokens,
                    totalTokens,
                });
            } catch (err: any) {
                log.error(`[dispatcher] agent=${agentId} — failed to record run for ${type}: ${err?.message ?? err}`);
            }
            log.info(`[run] agent=${agentId} type=${type} status=${status.status} durationMs=${durationMs} llmCalls=${llmCalls}${errorText ? ` error=${errorText}` : ""}`);

            // Терминальный статус задачи → enabled=0 (R-A3). Сейчас ни один скилл
            // его не выставляет (join-queue стал периодическим) — задел на будущее.
            if (status.terminal) {
                disableTask(agentId, type);
                log.info(`[dispatcher] agent=${agentId} — ${type} terminal, disabled`);
            }

            if (clientDisconnected) break;
        }

        // Пиковая память прогона (dispatcher-peak-memory-tracking): maxRSS — пик
        // резидентной памяти процесса с момента его старта, та же сущность, что
        // убивает cgroup OOM-killer (весь процесс, не отдельный скилл). Один замер
        // на весь прогон, после всех задач — сбой записи не должен валить прогон.
        const peakRssKb = process.resourceUsage().maxRSS;
        try {
            insertDispatcherRun(agentId, {
                startedAt: runStartedAt,
                taskTypes: due.map((t) => t.type).join(", "),
                peakRssKb,
            });
        } catch (err: any) {
            log.error(`[dispatcher] agent=${agentId} — failed to record dispatcher run: ${err?.message ?? err}`);
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
