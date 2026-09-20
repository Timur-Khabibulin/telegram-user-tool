// scripts/ops/metrics-pipeline-worker.ts — детач-процесс конвейера метрик
// (channel-metrics-pipeline). Запускается слушателем (distribution-listener) как
// отдельный процесс: слушатель остаётся отзывчивым, пока воркер часами считает.
//
// Поток по строке задачи (channel-metrics-pipeline.db):
//   1. дедуп входа против Google-листа (fail-fast при недоступности Sheets);
//   2. runFullMetrics — все метрики волнами по пулу агентов задачи, прогресс → БД;
//   3. фильтр: числовая колонка > порог; пустая метрика → не прошёл;
//   4. запись ВСЕХ посчитанных в лист одним пакетом (метрики + источник_* = дата +
//      прошёл_фильтр TRUE/FALSE; assigned_agent не трогаем);
//   5. итоговый CSV прошедших → в чат; строка задачи → done.
//
// Запуск: tsx src/scripts/ops/metrics-pipeline-worker.ts --task <id>

import * as fs from "fs";
import * as path from "path";

import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { normalizeChannelLink } from "../../core/db/discovery";
import {
    getPipelineTask,
    updatePipelineProgress,
    finishPipelineTask,
} from "../../core/db/metrics-pipeline";
import { fetchExistingLinks, ensureColumns, appendRecords, type SheetValue } from "../../core/google-sheets";
import { runFullMetrics, FULL_METRICS_COLUMNS } from "../../features/channel-full-metrics/run";
import { parseCsv } from "../../features/channel-distribution/run";
import { createLlmClient } from "../../llm/client";
import { sendDistributionMessage, sendDistributionDocument } from "../../core/distribution-bot-api";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const adminAgentId = FUNNEL_ADMIN_AGENT_ID;
const FILTER_COLUMN = "passed_filter";
/**
 * Колонки, которые скил пишет в лист (только английские имена). Существующие
 * английские (`link/title/niche/avg_views/comments_open/comments_per_day`) мапятся
 * по имени; недостающие (`date_updated/subs_count/posts_30d/total_comments/
 * passed_filter`) добавляются `ensureColumns`. Намеренно НЕ пишем: `is_broadcast`,
 * старые русские `источник_*`, а также существующие `статус`/`в_discovery_db`.
 */
const SHEET_WRITE_COLUMNS = [
    "link", "title", "niche", "date_updated", "subs_count", "avg_views",
    "comments_open", "posts_30d", "total_comments", "comments_per_day", FILTER_COLUMN,
];

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

// ─── CSV ──────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
            } else cur += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") { cells.push(cur); cur = ""; }
        else cur += c;
    }
    cells.push(cur);
    return cells;
}

function readCsvRows(text: string): string[][] {
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.map(parseCsvLine);
}

function csvCell(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(values: readonly string[]): string {
    return values.map(csvCell).join(",") + "\n";
}

/**
 * Ссылки из входного CSV (колонка `link` обязательна). Через `parseCsv`
 * channel-distribution — он устойчив к BOM (заголовок тримится), к разделителям
 * `,`/`;`/tab и к регистру имени колонки; иначе UTF-8 BOM в начале файла ломал
 * распознавание `link` (наблюдалось на выгрузках из Google Sheets/Excel).
 */
function readInputLinks(inputPath: string): string[] {
    const parsed = parseCsv(fs.readFileSync(inputPath, "utf8"));
    if (!parsed.ok) throw new Error(`во входном CSV: ${parsed.reason}: ${inputPath}`);
    return parsed.value.map((r) => r.rawLink.trim()).filter((v) => v.length > 0);
}

// ─── Разбор output-CSV расчёта в записи ────────────────────────────────

/** Число из ячейки или "" (пустая ячейка листа), если значение не число. */
function num(v: string): SheetValue {
    if (v.trim().length === 0) return "";
    const n = Number(v);
    return Number.isFinite(n) ? n : "";
}

/** "true"/"false" → boolean; иначе пустая ячейка. */
function boolOrEmpty(v: string): SheetValue {
    if (v === "true") return true;
    if (v === "false") return false;
    return "";
}

interface OutputRow {
    cells: Record<string, string>;
}

function readOutputRows(outputPath: string): OutputRow[] {
    const rows = readCsvRows(fs.readFileSync(outputPath, "utf8"));
    if (rows.length <= 1) return [];
    const header = rows[0];
    return rows.slice(1).map((r) => {
        const cells: Record<string, string> = {};
        header.forEach((h, i) => { cells[h] = r[i] ?? ""; });
        return { cells };
    });
}

// ─── Прогон ───────────────────────────────────────────────────────────

async function runPipeline(taskId: number): Promise<void> {
    const task = getPipelineTask(adminAgentId, taskId);
    if (!task) {
        log.error(`[metrics-pipeline-worker] задача #${taskId} не найдена`);
        process.exit(1);
    }

    const agentIds = task.agents.split(",").map((s) => s.trim()).filter(Boolean);
    const dateUpdated = new Date().toISOString().slice(0, 10); // дата обновления, YYYY-MM-DD

    // 1. Дедуп входа против листа (fail-fast: без листа не начинаем расчёт).
    const existing = await fetchExistingLinks(log);
    const allInput = readInputLinks(task.inputPath);
    const links = allInput.filter((raw) => !existing.has(normalizeChannelLink(raw)));
    log.info(`[metrics-pipeline-worker] вход ${allInput.length}, уже в листе ${allInput.length - links.length}, к расчёту ${links.length}`);
    updatePipelineProgress(adminAgentId, taskId, links.length, 0);

    // 2. Расчёт всех метрик волнами по пулу агентов.
    const llm = createLlmClient();
    await runFullMetrics(
        {
            links,
            agentIds,
            outputPath: task.outputPath,
            llm,
            onProcessed: (processed) => updatePipelineProgress(adminAgentId, taskId, links.length, processed),
        },
        log,
    );

    // 3. Фильтр + 4. запись в лист + 5. итоговый CSV.
    const outputRows = readOutputRows(task.outputPath);
    const header = await ensureColumns(SHEET_WRITE_COLUMNS, log);

    const resultPath = path.join(path.dirname(task.outputPath), `result-${taskId}.csv`);
    const resultColumns = FULL_METRICS_COLUMNS.filter((c) => c !== "error");
    fs.writeFileSync(resultPath, csvRow(resultColumns));

    const records: Record<string, SheetValue>[] = [];
    let passedCount = 0;
    for (const { cells } of outputRows) {
        const raw = cells[task.filterColumn] ?? "";
        const value = Number(raw);
        const passed = raw.trim().length > 0 && Number.isFinite(value) && value > task.filterThreshold;
        if (passed) {
            passedCount++;
            fs.appendFileSync(resultPath, csvRow(resultColumns.map((c) => cells[c] ?? "")));
        }
        records.push({
            link: cells.link ?? "",
            title: cells.title ?? "",
            niche: cells.niche ?? "",
            date_updated: dateUpdated,
            subs_count: num(cells.subs_count ?? ""),
            avg_views: num(cells.avg_views ?? ""),
            comments_open: boolOrEmpty(cells.comments_open ?? ""),
            posts_30d: num(cells.posts_30d ?? ""),
            total_comments: num(cells.total_comments ?? ""),
            comments_per_day: num(cells.comments_per_day ?? ""),
            [FILTER_COLUMN]: passed,
        });
    }

    await appendRecords(records, header, log);
    finishPipelineTask(adminAgentId, taskId, { status: "done", passedCount, resultPath });

    // 6. Итог в чат.
    const summary =
        `Задача #${taskId} завершена. Посчитано: ${outputRows.length}, прошло фильтр ` +
        `(${task.filterColumn} > ${task.filterThreshold}): ${passedCount}. Все каналы записаны в лист.`;
    if (passedCount > 0) {
        await sendDistributionDocument(resultPath, summary, log);
    } else {
        await sendDistributionMessage(summary + " Прошедших нет — CSV не отправляю.", log);
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const taskIdRaw = parseArg(argv, "--task");
    const taskId = taskIdRaw ? Number(taskIdRaw) : NaN;
    if (!Number.isFinite(taskId)) {
        log.error("usage: tsx src/scripts/ops/metrics-pipeline-worker.ts --task <id>");
        process.exit(1);
    }

    try {
        await runPipeline(taskId);
    } catch (err: any) {
        const message = err?.message ?? String(err);
        log.error(`[metrics-pipeline-worker] задача #${taskId} упала: ${message}`);
        finishPipelineTask(adminAgentId, taskId, { status: "error", error: message });
        await sendDistributionMessage(`Задача #${taskId} упала: ${message}`, log).catch(() => {});
        process.exit(1);
    }
    // GramJS не всегда отпускает хэндлы после disconnect — явный выход (как channel-metrics.ts).
    process.exit(0);
}

main();
