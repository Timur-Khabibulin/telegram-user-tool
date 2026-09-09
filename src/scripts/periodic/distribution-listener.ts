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
import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID, listAgentIds, distributionUploadsDir } from "../../core/config";
import {
    getDistributionUpdates,
    downloadDocument,
    sendDistributionMessage,
    type DistributionMessage,
} from "../../core/distribution-bot-api";
import {
    parseCsv,
    parseAgentSpec,
    runDistribution,
    type CsvRow,
} from "../../features/channel-distribution/run";
import {
    hasUnfinishedTask,
    createDistributionTask,
    finishDistributionTask,
    getLatestDistributionTask,
} from "../../core/db/distribution";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const POLL_ERROR_BACKOFF_MS = 5000;
const START_COMMAND = "/distribute";
const STATUS_COMMAND = "/status";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const START_MESSAGE =
    "Пришлите CSV-файл (не более 20 МБ) с колонкой «link». Диапазоны agentId укажите " +
    "подписью к файлу или отдельным сообщением, например: agent6-agent10, agent15.";

const adminAgentId = FUNNEL_ADMIN_AGENT_ID;

// ─── Состояние диалога (единственный уполномоченный чат, один процесс) ──

type ListenerState =
    | { phase: "idle" }
    | { phase: "awaiting_file" }
    | { phase: "awaiting_agents"; filePath: string; rows: CsvRow[] };

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

    // Диапазоны агентов могли прийти подписью к файлу — тогда сразу запускаем.
    const captionSpec = msg.text?.trim();
    if (captionSpec && captionSpec.length > 0) {
        await processDistribution(filePath, parsed.value, captionSpec, msg.fromId);
        return;
    }

    state = { phase: "awaiting_agents", filePath, rows: parsed.value };
    await sendDistributionMessage(
        `Файл получен (${parsed.value.length} строк). Пришлите диапазоны agentId, например: agent6-agent10, agent15.`,
        log,
    );
}

/** Валидирует набор агентов (R17), проверяет R24, создаёт задачу, распределяет инлайн, отдаёт сводку. */
async function processDistribution(filePath: string, rows: CsvRow[], agentsSpec: string, requesterId: string): Promise<void> {
    const agents = parseAgentSpec(agentsSpec, new Set(listAgentIds()));
    if (!agents.ok) {
        // Файл валиден — оставляем режим приёма агентов, чтобы можно было исправить ввод.
        state = { phase: "awaiting_agents", filePath, rows };
        await sendDistributionMessage(`Набор агентов отклонён: ${agents.reason}. Пришлите диапазоны ещё раз.`, log);
        return;
    }

    if (hasUnfinishedTask(adminAgentId)) {
        state = { phase: "idle" };
        await sendDistributionMessage("Уже идёт другая задача распределения — дождитесь её завершения.", log);
        return;
    }

    const taskId = createDistributionTask(adminAgentId, { filePath, agentsSpec, requesterId });
    state = { phase: "idle" };
    await sendDistributionMessage(`Задача #${taskId} запущена (агентов: ${agents.value.length}).`, log);

    const result = runDistribution(rows, agents.value, log, adminAgentId);
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

async function handleMessage(msg: DistributionMessage): Promise<void> {
    const command = commandOf(msg.text);

    if (command === STATUS_COMMAND) {
        await handleStatus();
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

    if (state.phase === "awaiting_agents") {
        if (msg.document) {
            // Прислали новый файл вместо диапазонов — заменяем и переспрашиваем.
            await handleDocument(msg);
            return;
        }
        if (msg.text && msg.text.trim().length > 0) {
            await processDistribution(state.filePath, state.rows, msg.text.trim(), msg.fromId);
            return;
        }
        await sendDistributionMessage("Жду диапазоны agentId (например agent6-agent10, agent15).", log);
        return;
    }

    // idle и не команда — подсказываем точку входа.
    if (!command) {
        await sendDistributionMessage(`Команды: ${START_COMMAND} — начать распределение, ${STATUS_COMMAND} — статус.`, log);
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
