// features/channel-distribution/run.ts — оркестрация распределения списка каналов
// по агентам (channel-distribution). Разбирает CSV и набор агентов, классифицирует
// исход каждой строки (added/skipped/error), балансирует новые каналы (plan.ts),
// регистрирует их в реестре с метриками, ставит в очередь вступления батчем и
// включает задачу join-queue у целевых агентов. Только SQLite — Telegram не
// трогает (фактическое вступление делает отдельный прогон join-queue).

import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import {
    normalizeChannelLink,
    getAssignment,
    assignToPersona,
    assignmentCountsForPersona,
    setChannelMetricsJson,
} from "../../core/db/discovery";
import { addJoinQueue } from "../../core/db/join-queue";
import { listTasks, upsertTask, computeDefaultSchedule } from "../../core/db/tasks";
import { planDistribution } from "./plan";

// ─── Types ────────────────────────────────────────────────────────────

export interface CsvRow {
    /** Значение колонки `link` (пустая строка, если ячейка пуста). */
    rawLink: string;
    /** Прочие колонки как метрики: имя = заголовок колонки. */
    metrics: Record<string, string>;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface DistributionCounts {
    added: number;
    skipped: number;
    error: number;
}

export interface DistributionResult {
    counts: DistributionCounts;
    /** Число каналов, доставшихся каждому целевому агенту (для лога/сводки). */
    byAgent: Record<string, number>;
}

interface Candidate {
    canonicalLink: string;
    metrics: Record<string, string>;
}

// ─── Разбор CSV ───────────────────────────────────────────────────────

const CSV_DELIMITERS = [",", ";", "\t"] as const;
const LINK_COLUMN = "link";

/** Делимитр строки-заголовка: тот из поддерживаемых, что даёт больше всего колонок. */
function detectDelimiter(headerLine: string): string {
    let best: string = CSV_DELIMITERS[0];
    let bestCount = -1;
    for (const d of CSV_DELIMITERS) {
        const count = headerLine.split(d).length;
        if (count > bestCount) {
            best = d;
            bestCount = count;
        }
    }
    return best;
}

/**
 * Разбирает CSV: колонка ссылок — по заголовку `link` (R20), прочие колонки —
 * метрики. Поддерживает разделители `,` `;` `\t` (R21). Отклоняет пустой файл
 * или отсутствие колонки `link` (R16). Значения не валидируются здесь — формат
 * ссылки и исход строки классифицирует runDistribution.
 */
export function parseCsv(csvText: string): ParseResult<CsvRow[]> {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return { ok: false, reason: "файл пуст" };

    const delimiter = detectDelimiter(lines[0]);
    const headers = lines[0].split(delimiter).map((h) => h.trim());
    const linkIdx = headers.findIndex((h) => h.toLowerCase() === LINK_COLUMN);
    if (linkIdx === -1) return { ok: false, reason: `нет колонки «${LINK_COLUMN}»` };

    const rows: CsvRow[] = [];
    for (const line of lines.slice(1)) {
        const cells = line.split(delimiter).map((c) => c.trim());
        const metrics: Record<string, string> = {};
        for (let i = 0; i < headers.length; i += 1) {
            if (i === linkIdx) continue;
            const key = headers[i];
            const value = cells[i] ?? "";
            if (key.length > 0 && value.length > 0) metrics[key] = value;
        }
        rows.push({ rawLink: cells[linkIdx] ?? "", metrics });
    }

    if (rows.length === 0) return { ok: false, reason: "в файле нет строк с данными" };
    return { ok: true, value: rows };
}

// ─── Разбор ссылок ─────────────────────────────────────────────────────

/** Зарезервированные пути t.me, ошибочно проходящие проверку username по длине/символам. */
const RESERVED_USERNAMES = new Set(["joinchat", "c", "s", "proxy", "socks", "addstickers", "addemoji", "addlist"]);
const CANONICAL_PREFIX = "https://t.me/";

/**
 * Поддерживается ли ссылка для распределения (R15): только публичная
 * `t.me/<channelusername>`. Пригласительные (`t.me/+…`, `t.me/joinchat/…`) и
 * приватные (`t.me/c/…`) — не поддерживаются. Проверяется username после
 * канонизации: разрешённые символы Telegram-username и не зарезервированный путь.
 */
export function isSupportedChannelLink(rawLink: string): boolean {
    const canonical = normalizeChannelLink(rawLink);
    if (!canonical.startsWith(CANONICAL_PREFIX)) return false;
    const username = canonical.slice(CANONICAL_PREFIX.length);
    if (!/^[a-z0-9_]{4,32}$/.test(username)) return false;
    if (RESERVED_USERNAMES.has(username)) return false;
    return true;
}

// ─── Классификация исходов ────────────────────────────────────────────

interface Classification {
    candidates: Candidate[];
    skipped: number;
    error: number;
}

function classifyRows(rows: readonly CsvRow[], adminAgentId: string, persona: string, log: Logger): Classification {
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    let skipped = 0;
    let error = 0;

    for (const row of rows) {
        if (row.rawLink.length === 0) {
            skipped += 1;
            log.info(`[channel-distribution] skipped (нет ссылки)`);
            continue;
        }
        if (!isSupportedChannelLink(row.rawLink)) {
            error += 1;
            log.info(`[channel-distribution] error (неподдерживаемый формат) «${row.rawLink}»`);
            continue;
        }
        const canonicalLink = normalizeChannelLink(row.rawLink);
        if (seen.has(canonicalLink)) {
            skipped += 1;
            log.info(`[channel-distribution] skipped (дубликат в файле) «${canonicalLink}»`);
            continue;
        }
        seen.add(canonicalLink);
        // Дедуп в рамках целевой персоны: канал, закреплённый в ЭТОЙ персоне,
        // пропускаем; тот же канал в другой персоне — валидный кандидат (R4).
        if (getAssignment(adminAgentId, persona, canonicalLink) !== null) {
            skipped += 1;
            log.info(`[channel-distribution] skipped (уже закреплён в персоне «${persona}») «${canonicalLink}»`);
            continue;
        }
        candidates.push({ canonicalLink, metrics: row.metrics });
    }

    return { candidates, skipped, error };
}

// ─── Оркестрация ──────────────────────────────────────────────────────

/**
 * Распределяет уже разобранные строки CSV на целевую персону по уже
 * провалидированному (непустому) набору её активных агентов. Дедуп в рамках
 * персоны, балансирует новые каналы (water-fill по `assignmentCountsForPersona`),
 * закрепляет их с метриками, ставит в очередь батчем и включает join-queue у
 * целевых агентов. Пустой `targetAgentIds` — ответственность вызывающего (отказ до
 * вызова, R12), поэтому пустая раскладка здесь означала бы потерю входа; вызывающий
 * это исключает. Частичный успех (R25) — идемпотентные записи (`INSERT OR IGNORE`).
 */
export function runDistribution(
    rows: readonly CsvRow[],
    persona: string,
    targetAgentIds: readonly string[],
    log: Logger,
    adminAgentId: string = FUNNEL_ADMIN_AGENT_ID,
): DistributionResult {
    const { candidates, skipped, error } = classifyRows(rows, adminAgentId, persona, log);

    const startLoad = new Map<string, number>(Object.entries(assignmentCountsForPersona(adminAgentId, persona)));
    const metricsByLink = new Map(candidates.map((c) => [c.canonicalLink, c.metrics] as const));
    const assignments = planDistribution(
        candidates.map((c) => c.canonicalLink),
        targetAgentIds,
        startLoad,
    );

    const linksByAgent = new Map<string, string[]>();
    let added = 0;
    for (const { canonicalLink, targetAgentId } of assignments) {
        assignToPersona(adminAgentId, { persona, canonicalLink, agentId: targetAgentId });
        setChannelMetricsJson(adminAgentId, canonicalLink, metricsByLink.get(canonicalLink) ?? {});
        const links = linksByAgent.get(targetAgentId) ?? [];
        links.push(canonicalLink);
        linksByAgent.set(targetAgentId, links);
        added += 1;
    }

    const byAgent: Record<string, number> = {};
    for (const [agentId, links] of linksByAgent) {
        addJoinQueue(agentId, links, log);
        ensureJoinQueueEnabled(agentId, log);
        byAgent[agentId] = links.length;
    }

    const result: DistributionResult = { counts: { added, skipped, error }, byAgent };
    log.info(
        `[channel-distribution] done — added=${added} skipped=${skipped} error=${error} byAgent=${JSON.stringify(byAgent)}`,
    );
    return result;
}

/**
 * Гарантирует, что задача `join-queue` целевого агента включена (R8). Если задача
 * уже включена — не трогает её расписание (не мешает работающему агенту); если
 * отсутствует или выключена — создаёт/включает с дефолтным расписанием.
 */
function ensureJoinQueueEnabled(agentId: string, log: Logger): void {
    const existing = listTasks(agentId).find((t) => t.type === "join-queue");
    if (existing && existing.enabled === 1) return;
    const { schedule, tz } = computeDefaultSchedule("join-queue");
    upsertTask({ agentId, type: "join-queue", schedule, tz });
    log.info(`[channel-distribution] join-queue включена для agentId=${agentId}`);
}
