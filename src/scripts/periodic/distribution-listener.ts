// scripts/periodic/distribution-listener.ts — персистентный слушатель бота
// распределения каналов (channel-distribution). Один процесс на платформу —
// единственный потребитель getUpdates этого бота, запускается как persistent
// systemd-сервис (Restart=always), не по таймеру.
//
// Поток command-initiated: /distribute → режим приёма → CSV (+ диапазоны
// agentId подписью или отдельным сообщением) → распределение инлайн → сводка.
// /status — состояние последней задачи. Авторизация по чату обеспечена на уровне
// distribution-bot-api (default-deny), сюда доходят только сообщения из
// уполномоченного чата.

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type { Logger } from "../../core/logger";
import {
    FUNNEL_ADMIN_AGENT_ID,
    buildPersonaIndex,
    distributionUploadsDir,
    metricsPipelineDir,
    listAgentIds,
} from "../../core/config";
import { resolvePersonaTargets, isKnownPersona } from "../../core/persona-targets";
import {
    getDistributionUpdates,
    downloadDocument,
    sendDistributionMessage,
    type DistributionMessage,
} from "../../core/distribution-bot-api";
import {
    parseCsv,
    runDistribution,
    type CsvRow,
} from "../../features/channel-distribution/run";
import {
    hasUnfinishedTask,
    createDistributionTask,
    finishDistributionTask,
    getLatestDistributionTask,
} from "../../core/db/distribution";
import {
    hasUnfinishedPipelineTask,
    createPipelineTask,
    getLatestPipelineTask,
} from "../../core/db/metrics-pipeline";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const POLL_ERROR_BACKOFF_MS = 5000;
const START_COMMAND = "/distribute";
const STATUS_COMMAND = "/status";
// Конвейер метрик (channel-metrics-pipeline): запуск одним сообщением (CSV +
// параметры в подписи) и отдельный статус — независимы от потока /distribute.
const METRICS_COMMAND = "/metrics";
const METRICS_STATUS_COMMAND = "/metrics_status";
/** Колонки, по которым допустим фильтр — только числовые метрики прогона. */
const NUMERIC_FILTER_COLUMNS = ["subs_count", "avg_views", "posts_30d", "total_comments", "comments_per_day"] as const;
const METRICS_USAGE =
    "Формат: пришлите CSV (колонка «link») одним сообщением с подписью, например:\n" +
    "/metrics agents: agent40,agent41 | filter: comments_per_day > 0.5\n" +
    `Колонка фильтра — одна из: ${NUMERIC_FILTER_COLUMNS.join(", ")}.`;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const START_MESSAGE =
    "Пришлите CSV-файл (не более 20 МБ) с колонкой «link». Имя целевой персоны укажите " +
    "подписью к файлу или отдельным сообщением, например: maria.";

const adminAgentId = FUNNEL_ADMIN_AGENT_ID;

// ─── Состояние диалога (единственный уполномоченный чат, один процесс) ──

type ListenerState =
    | { phase: "idle" }
    | { phase: "awaiting_file" }
    | { phase: "awaiting_persona"; filePath: string; rows: CsvRow[] };

let state: ListenerState = { phase: "idle" };

// ─── Обработка сообщений ──────────────────────────────────────────────

function commandOf(text: string | null): string | null {
    if (!text) return null;
    const first = text.trim().split(/\s+/)[0];
    if (!first.startsWith("/")) return null;
    return first.split("@")[0].toLowerCase();
}

async function handleStatus(): Promise<void> {
    const task = getLatestDistributionTask(adminAgentId);
    if (!task) {
        await sendDistributionMessage("Задач распределения ещё не было.", log);
        return;
    }
    if (task.status !== "done") {
        await sendDistributionMessage(`Задача #${task.id} идёт.`, log);
        return;
    }
    await sendDistributionMessage(
        `Задача #${task.id} завершена. Добавлено: ${task.addedCount}, пропущено: ${task.skippedCount}, с ошибкой: ${task.errorCount}.`,
        log,
    );
}

/** Сохраняет загруженный файл в каталог аудита (R26), возвращает путь. */
function saveUpload(fileName: string, content: Buffer): string {
    const dir = distributionUploadsDir(adminAgentId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = path.basename(fileName).replace(/[^\w.-]/g, "_");
    const filePath = path.join(dir, `${stamp}-${safeName}`);
    fs.writeFileSync(filePath, content);
    return filePath;
}

/** Принимает документ: проверка размера, скачивание, сохранение (R26), разбор CSV (R16). */
async function handleDocument(msg: DistributionMessage): Promise<void> {
    const doc = msg.document;
    if (!doc) return;
    if (doc.fileSize > MAX_FILE_BYTES) {
        await sendDistributionMessage("Файл больше 20 МБ — не принят. Уменьшите список и пришлите снова.", log);
        return;
    }

    const content = await downloadDocument(doc.fileId, log);
    const filePath = saveUpload(doc.fileName, content);

    const parsed = parseCsv(content.toString("utf-8"));
    if (!parsed.ok) {
        state = { phase: "idle" };
        await sendDistributionMessage(`Файл отклонён: ${parsed.reason}. Начните заново командой ${START_COMMAND}.`, log);
        return;
    }

    // Имя персоны могло прийти подписью к файлу — тогда сразу запускаем.
    const captionPersona = msg.text?.trim();
    if (captionPersona && captionPersona.length > 0) {
        await processDistribution(filePath, parsed.value, captionPersona, msg.fromId);
        return;
    }

    state = { phase: "awaiting_persona", filePath, rows: parsed.value };
    await sendDistributionMessage(
        `Файл получен (${parsed.value.length} строк). Пришлите имя целевой персоны, например: maria.`,
        log,
    );
}

/** Валидирует персону (известна + есть активные агенты), проверяет R24, создаёт задачу, распределяет инлайн, отдаёт сводку. */
async function processDistribution(filePath: string, rows: CsvRow[], persona: string, requesterId: string): Promise<void> {
    const personaIndex = buildPersonaIndex();
    if (!isKnownPersona(persona, personaIndex)) {
        // Файл валиден — оставляем режим приёма персоны, чтобы можно было исправить ввод.
        state = { phase: "awaiting_persona", filePath, rows };
        const known = [...new Set(personaIndex.values())].join(", ") || "—";
        await sendDistributionMessage(`Неизвестная персона «${persona}». Известные: ${known}. Пришлите имя персоны ещё раз.`, log);
        return;
    }

    const targets = resolvePersonaTargets(persona, adminAgentId, personaIndex);
    if (targets.length === 0) {
        state = { phase: "awaiting_persona", filePath, rows };
        await sendDistributionMessage(`В персоне «${persona}» нет активных агентов — распределять некому. Пришлите другую персону.`, log);
        return;
    }

    if (hasUnfinishedTask(adminAgentId)) {
        state = { phase: "idle" };
        await sendDistributionMessage("Уже идёт другая задача распределения — дождитесь её завершения.", log);
        return;
    }

    const taskId = createDistributionTask(adminAgentId, { filePath, persona, requesterId });
    state = { phase: "idle" };
    await sendDistributionMessage(`Задача #${taskId} запущена (персона: ${persona}, активных агентов: ${targets.length}).`, log);

    const result = runDistribution(rows, persona, targets, log, adminAgentId);
    finishDistributionTask(adminAgentId, taskId, result.counts);

    const byAgent = Object.entries(result.byAgent)
        .map(([agent, n]) => `${agent}: ${n}`)
        .join(", ");
    const tail = byAgent.length > 0 ? `\nПо агентам: ${byAgent}` : "";
    await sendDistributionMessage(
        `Задача #${taskId} завершена. Добавлено: ${result.counts.added}, пропущено: ${result.counts.skipped}, ` +
            `с ошибкой: ${result.counts.error}.${tail}`,
        log,
    );
}

// ─── Конвейер метрик (channel-metrics-pipeline) ────────────────────────

interface MetricsParams {
    agents: string[];
    column: string;
    threshold: number;
}

/** Разбирает подпись `/metrics agents: a1,a2 | filter: <колонка> > <порог>` с валидацией до старта. */
function parseMetricsParams(caption: string): MetricsParams | { error: string } {
    const text = caption.replace(/^\/metrics(@\S+)?/i, "").trim();
    const agentsMatch = text.match(/agents?\s*:\s*([^|\n]+)/i);
    const filterMatch = text.match(/filter\s*:\s*([a-z_]+)\s*>\s*(-?\d+(?:[.,]\d+)?)/i);
    if (!agentsMatch || !filterMatch) return { error: "Не разобрал параметры.\n" + METRICS_USAGE };

    const agents = agentsMatch[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const column = filterMatch[1].trim();
    const threshold = Number(filterMatch[2].replace(",", "."));

    if (agents.length === 0) return { error: "Не указан ни один агент.\n" + METRICS_USAGE };
    const known = new Set(listAgentIds());
    const unknown = agents.filter((a) => !known.has(a));
    if (unknown.length > 0) return { error: `Неизвестные агенты: ${unknown.join(", ")}.` };
    if (!(NUMERIC_FILTER_COLUMNS as readonly string[]).includes(column)) {
        return { error: `Колонка «${column}» не поддерживается. Допустимые: ${NUMERIC_FILTER_COLUMNS.join(", ")}.` };
    }
    if (!Number.isFinite(threshold)) return { error: "Порог не число." };
    return { agents, column, threshold };
}

/** Запускает воркер конвейера отдельным detached-процессом (бот остаётся отзывчивым). */
function spawnMetricsWorker(taskId: number): void {
    const dir = metricsPipelineDir(adminAgentId);
    const tsxBin = path.resolve(process.cwd(), "node_modules", ".bin", "tsx");
    const scriptPath = path.resolve(process.cwd(), "src", "scripts", "ops", "metrics-pipeline-worker.ts");
    const logFd = fs.openSync(path.join(dir, `worker-${taskId}.log`), "a");
    const child = spawn(tsxBin, [scriptPath, "--task", String(taskId)], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    log.info(`[distribution-listener] воркер метрик запущен pid=${child.pid} task=${taskId}`);
}

/** Приём задачи конвейера метрик одним сообщением: CSV + параметры в подписи. */
async function handleMetricsStart(msg: DistributionMessage): Promise<void> {
    const doc = msg.document;
    if (!doc) {
        await sendDistributionMessage("Команда /metrics требует прикреплённый CSV одним сообщением.\n" + METRICS_USAGE, log);
        return;
    }
    if (doc.fileSize > MAX_FILE_BYTES) {
        await sendDistributionMessage("Файл больше 20 МБ — не принят. Уменьшите список.", log);
        return;
    }

    const parsed = parseMetricsParams(msg.text ?? "");
    if ("error" in parsed) {
        await sendDistributionMessage(parsed.error, log);
        return;
    }

    if (hasUnfinishedPipelineTask(adminAgentId)) {
        await sendDistributionMessage("Уже идёт прогон метрик — дождитесь его завершения (/metrics_status).", log);
        return;
    }

    const content = await downloadDocument(doc.fileId, log);
    const dir = metricsPipelineDir(adminAgentId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = path.basename(doc.fileName).replace(/[^\w.-]/g, "_");
    const inputPath = path.join(dir, `${stamp}-${safeName}`);
    fs.writeFileSync(inputPath, content);
    const outputPath = path.join(dir, `${stamp}-metrics.csv`);

    const taskId = createPipelineTask(adminAgentId, {
        agents: parsed.agents,
        filterColumn: parsed.column,
        filterThreshold: parsed.threshold,
        inputPath,
        outputPath,
        requesterId: msg.fromId,
    });

    spawnMetricsWorker(taskId);
    await sendDistributionMessage(
        `Задача #${taskId} запущена: агентов ${parsed.agents.length}, фильтр ${parsed.column} > ${parsed.threshold}. ` +
        "Идёт расчёт (может занять часы). Прогресс — /metrics_status.",
        log,
    );
}

/** Статус последнего прогона конвейера — читается из БД (переживает рестарт слушателя). */
async function handleMetricsStatus(): Promise<void> {
    const task = getLatestPipelineTask(adminAgentId);
    if (!task) {
        await sendDistributionMessage("Прогонов метрик ещё не было.", log);
        return;
    }
    if (task.status === "running") {
        await sendDistributionMessage(`Задача #${task.id} идёт: посчитано ${task.processed} из ${task.total}.`, log);
        return;
    }
    if (task.status === "error") {
        await sendDistributionMessage(`Задача #${task.id} упала: ${task.error ?? "неизвестно"}.`, log);
        return;
    }
    await sendDistributionMessage(
        `Задача #${task.id} завершена. Посчитано ${task.processed}, прошло фильтр: ${task.passedCount}.`,
        log,
    );
}

async function handleMessage(msg: DistributionMessage): Promise<void> {
    const command = commandOf(msg.text);

    if (command === STATUS_COMMAND) {
        await handleStatus();
        return;
    }
    if (command === METRICS_STATUS_COMMAND) {
        await handleMetricsStatus();
        return;
    }
    if (command === METRICS_COMMAND) {
        await handleMetricsStart(msg);
        return;
    }
    if (command === START_COMMAND) {
        state = { phase: "awaiting_file" };
        await sendDistributionMessage(START_MESSAGE, log);
        return;
    }

    if (state.phase === "awaiting_file") {
        if (msg.document) {
            await handleDocument(msg);
            return;
        }
        await sendDistributionMessage("Жду CSV-файл. Пришлите документ или начните заново командой /distribute.", log);
        return;
    }

    if (state.phase === "awaiting_persona") {
        if (msg.document) {
            // Прислали новый файл вместо имени персоны — заменяем и переспрашиваем.
            await handleDocument(msg);
            return;
        }
        if (msg.text && msg.text.trim().length > 0) {
            await processDistribution(state.filePath, state.rows, msg.text.trim(), msg.fromId);
            return;
        }
        await sendDistributionMessage("Жду имя целевой персоны (например: maria).", log);
        return;
    }

    // idle и не команда — подсказываем точку входа.
    if (!command) {
        await sendDistributionMessage(
            `Команды: ${START_COMMAND} — распределение, ${STATUS_COMMAND} — его статус; ` +
            `${METRICS_COMMAND} — расчёт метрик (CSV + параметры одним сообщением), ${METRICS_STATUS_COMMAND} — его статус.`,
            log,
        );
    }
}

// ─── Главный цикл ─────────────────────────────────────────────────────

async function main(): Promise<void> {
    log.info("[distribution-listener] started");
    let offset = 0;

    for (;;) {
        let messages: DistributionMessage[] = [];
        try {
            const result = await getDistributionUpdates(offset, log);
            offset = result.nextOffset;
            messages = result.messages;
        } catch (err) {
            log.error(`[distribution-listener] poll failed: ${(err as Error)?.message ?? err}`);
            await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
            continue;
        }

        for (const msg of messages) {
            try {
                await handleMessage(msg);
            } catch (err) {
                log.error(`[distribution-listener] handleMessage failed updateId=${msg.updateId}: ${(err as Error)?.message ?? err}`);
                await sendDistributionMessage("Внутренняя ошибка при обработке. Попробуйте снова.", log).catch(() => {});
            }
        }
    }
}

main().catch((err) => {
    log.error(`[distribution-listener] fatal: ${(err as Error)?.message ?? err}`);
    process.exit(1);
});
