// features/funnel/funnel-report.ts — рендер отчёта-воронки (funnel-tracking, этапы 1-7).
//
// Отчёт состоит из двух частей (см. docs/design/funnel-tracking/funnel-tracking-v2.md §3,
// docs/design/funnel-tracking/architecture-v3.md):
//  • Текст сообщения (renderFunnel) — узкая таблица этапов 1-4 + заявки по агенту
//    (US-3, funnel-tracking v3) + строка этапа 5 + блок ошибок.
//    Узкая, потому что мобильный Telegram переносит моноширинную строку после
//    ~40 знаков и ломает таблицу; отсюда короткие заголовки колонок + легенда
//    под таблицей.
//  • CSV-вложение (buildFunnelCsv) — полная таблица по всем агентам + вторая
//    таблица с разбивкой отправленных сообщений по каналам (US-5); не
//    ограничена шириной экрана.
//
// Платформенные требования к тексту (см. openclaw#36323 и Telegram entities):
//  1. Таблица идёт в код-блоке (``` + parseMode="md") — иначе колонки не
//     моноширинные.
//  2. Отступы — НЕРАЗРЫВНЫМ пробелом ( ): markdown схлопывает прогоны обычных
//     пробелов в один даже внутри блока, NBSP — нет.

import * as path from "path";

import type { FunnelResult, AgentFunnelRow } from "./funnel-collect";
import type { DayWindow } from "./runs-summary";
import { reportsDir } from "../../core/config";

const NBSP = " ";

function signed(n: number): string {
    return n >= 0 ? `+${n}` : `${n}`;
}

/** Значок статуса агента в таблице отчёта: ❌ — banned, ⚠️ — need_update_session/suspend, 🔧 — manual_reauth. */
function restrictionIcon(type: AgentFunnelRow["restrictionType"]): string {
    if (type === "banned") return " ❌";
    if (type === "manual_reauth") return " 🔧";
    if (type === "need_update_session" || type === "suspend") return " ⚠️";
    return "";
}

/** Метрика-дельта: «дельта (абсолют)» — формат funnel-tracking-v2. «—», если абсолют неизвестен (нет снапшота/ссылки). */
function fmtDeltaAbs(delta: number | null, abs: number | null): string {
    if (abs == null) return "—";
    if (delta == null) return String(abs);
    return `${signed(delta)}${NBSP}(${abs})`;
}

// ─── Текстовый отчёт ──────────────────────────────────────────────────

export function renderFunnel(r: FunnelResult): string {
    // Короткие заголовки — чтобы строка таблицы влезала в ~40 символов на мобиле;
    // расшифровка — в легенде под таблицей.
    const header = ["Агент", "Кан", "Просм", "Актив", "Отпр", "Заяв", "Охват"];

    const dataRows = r.agents.map((a) => [
        a.agentId + restrictionIcon(a.restrictionType),
        String(a.channelsTotal),
        String(a.channelsVisited),
        String(a.channelsActive),
        String(a.channelsWithSending),
        fmtDeltaAbs(a.privateRequestsDelta, a.privateRequestsAbs),
        String(Math.round(a.potentialReach)),
    ]);

    const totChannels = r.agents.reduce((s, a) => s + a.channelsTotal, 0);
    const totVisited = r.agents.reduce((s, a) => s + a.channelsVisited, 0);
    const totActive = r.agents.reduce((s, a) => s + a.channelsActive, 0);
    const totSent = r.agents.reduce((s, a) => s + a.channelsWithSending, 0);
    const totReach = r.agents.reduce((s, a) => s + a.potentialReach, 0);
    const totalRow = [
        "Итого",
        String(totChannels),
        String(totVisited),
        String(totActive),
        String(totSent),
        fmtDeltaAbs(r.privateRequestsDelta, r.privateRequestsAbs),
        String(Math.round(totReach)),
    ];

    // Ширины колонок по самой длинной ячейке; разделитель — один NBSP.
    const all = [header, ...dataRows, totalRow];
    const widths = header.map((_, c) => Math.max(...all.map((row) => row[c].length)));
    const fmtRow = (row: string[]) =>
        row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c], NBSP) : cell.padStart(widths[c], NBSP))).join(NBSP);
    const divider = "─".repeat(widths.reduce((s, w) => s + w, 0) + (widths.length - 1));

    // ── Код-блок: только таблица ──
    const table: string[] = [];
    table.push(fmtRow(header));
    table.push(divider);
    for (const row of dataRows) table.push(fmtRow(row));
    table.push(divider);
    table.push(fmtRow(totalRow));

    // ── Сумма просмотров поста по агентам (этап 5) ──
    const viewsDeltas = r.agents.map((a) => a.postViewsDelta).filter((v): v is number => v != null);
    const viewsAbs = r.agents.map((a) => a.postViewsAbs).filter((v): v is number => v != null);
    const totViewsDelta = viewsDeltas.length ? viewsDeltas.reduce((s, v) => s + v, 0) : null;
    const totViewsAbs = viewsAbs.length ? viewsAbs.reduce((s, v) => s + v, 0) : null;

    // ── Проза вне блока ──
    const out: string[] = [];
    out.push(`📊 Воронка · ${r.window.label} (UTC+5)`);
    out.push("");
    out.push("```");
    out.push(...table);
    out.push("```");
    out.push("");
    if (r.privateNote) {
        out.push(`Заявки в приватный канал: ${r.privateNote}`);
    }
    out.push(`Просмотры публичных каналов (сумма по агентам): ${fmtDeltaAbs(totViewsDelta, totViewsAbs)}`);
    out.push("");
    out.push("Кан — каналов у агента, Просм — просмотрено за день");
    out.push("Актив — активных каналов");
    out.push("Отпр — каналов с отправкой хотя бы одного сообщения за день; полная разбивка — в CSV");
    out.push("Заяв — заявки в приватный канал по ссылке агента; «—» — ссылка не настроена");
    out.push("Охват — потенциальный охват (avg_views каналов с ответами)");
    out.push("❌ — banned, ⚠️ — need_update_session/suspend, 🔧 — manual_reauth");

    // ── Ошибки за день (агрегат по всем агентам) ──
    const errorTotals = new Map<string, number>();
    for (const a of r.agents) {
        for (const e of a.errorBreakdown) {
            errorTotals.set(e.errorCode, (errorTotals.get(e.errorCode) ?? 0) + e.count);
        }
    }
    if (errorTotals.size > 0) {
        const parts = [...errorTotals.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([code, n]) => `${code}×${n}`);
        out.push("");
        out.push(`Ошибки за день: ${parts.join(", ")}`);
    }

    // ── Ограничения за день (telegram-error-handling) ──
    out.push("");
    out.push(`Ограничений наложено сегодня: ${r.restrictedAgents.length}`);

    // ── Пометки о сбоях сбора ──
    const skips = r.agents.filter((a) => a.note1to4 || a.note5to7);
    if (skips.length > 0) {
        out.push("");
        out.push("Сбои сбора:");
        for (const a of skips) {
            if (a.note1to4) out.push(`• ${a.agentId} — ${a.note1to4}`);
            if (a.note5to7) out.push(`• ${a.agentId} — ${a.note5to7}`);
        }
    }

    return out.join("\n");
}

/**
 * Путь к CSV-файлу отчёта: день данных (`window.label`) + время вызова (UTC,
 * `HH-mm-ss`). Второй вызов за те же сутки (ручной `tg_funnel_report` поверх
 * уже отработавшего таймера, или два ручных подряд) пишет отдельный файл, а не
 * молча перезатирает предыдущий снапшот на диске — раньше оба пути делили одно
 * имя `funnel-{window.label}.csv`.
 */
export function funnelCsvPath(adminAgentId: string, window: DayWindow, now: Date = new Date()): string {
    const time = now.toISOString().slice(11, 19).replace(/:/g, "-");
    return path.join(reportsDir(adminAgentId), `funnel-${window.label}_${time}.csv`);
}

// ─── CSV-вложение ─────────────────────────────────────────────────────

/** Число или пусто (для отсутствующих метрик-снапшотов). */
function csvNum(n: number | null): string {
    return n == null ? "" : String(n);
}

/** RFC 4180: оборачивает в кавычки и удваивает внутренние кавычки, если поле
 *  содержит запятую/кавычку/перевод строки. Нужно только для названий каналов —
 *  остальные поля отчёта (agent_id, числа, URL) не требуют экранирования. */
function csvEscapeField(s: string): string {
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV с двумя таблицами: основная — строка на агента + строка ИТОГО (все
 * метрики отчёта, дельта и абсолют отдельными столбцами, ИТОГО заполнен в
 * обоих столбцах метрик-снапшотов — сумма по агентам); вторая, после пустой
 * строки, — построчная разбивка отправленных сообщений по каналам (US-5).
 */
export function buildFunnelCsv(r: FunnelResult): string {
    const header = [
        "agent_id",
        "персона",
        "каналов_у_агента",
        "каналов_просмотрено",
        "каналов_активно",
        "каналов_с_отправкой",
        "ошибок_отправки",
        "каналов_забанено_сегодня",
        "каналов_приостановлено_сегодня",
        "потенциальный_охват",
        "просмотры_поста_дельта",
        "просмотры_поста_абс",
        "подписчики_канала_дельта",
        "подписчики_канала_абс",
        "заявки_в_приватный_канал_дельта",
        "заявки_в_приватный_канал_абс",
    ];

    const rows: string[][] = r.agents.map((a) => [
        a.agentId,
        a.persona ?? "—",
        String(a.channelsTotal),
        String(a.channelsVisited),
        String(a.channelsActive),
        String(a.channelsWithSending),
        String(a.sendErrors),
        String(a.channelsBannedToday),
        String(a.channelsSuspendedToday),
        String(Math.round(a.potentialReach)),
        csvNum(a.postViewsDelta),
        csvNum(a.postViewsAbs),
        csvNum(a.publicSubsDelta),
        csvNum(a.publicSubsAbs),
        csvNum(a.privateRequestsDelta),
        csvNum(a.privateRequestsAbs),
    ]);

    const sum = (pick: (a: AgentFunnelRow) => number) => r.agents.reduce((s, a) => s + pick(a), 0);
    const sumNonNull = (pick: (a: AgentFunnelRow) => number | null) =>
        r.agents.map(pick).filter((v): v is number => v != null);
    const sumOrEmpty = (vals: number[]) => (vals.length ? String(vals.reduce((s, v) => s + v, 0)) : "");

    const total = [
        "ИТОГО",
        "",
        String(sum((a) => a.channelsTotal)),
        String(sum((a) => a.channelsVisited)),
        String(sum((a) => a.channelsActive)),
        String(sum((a) => a.channelsWithSending)),
        String(sum((a) => a.sendErrors)),
        String(sum((a) => a.channelsBannedToday)),
        String(sum((a) => a.channelsSuspendedToday)),
        String(Math.round(sum((a) => a.potentialReach))),
        sumOrEmpty(sumNonNull((a) => a.postViewsDelta)),
        sumOrEmpty(sumNonNull((a) => a.postViewsAbs)),
        sumOrEmpty(sumNonNull((a) => a.publicSubsDelta)),
        sumOrEmpty(sumNonNull((a) => a.publicSubsAbs)),
        csvNum(r.privateRequestsDelta),
        csvNum(r.privateRequestsAbs),
    ];

    const mainTable = [header, ...rows, total].map((row) => row.join(",")).join("\n");

    // ── Вторая таблица: разбивка отправленных сообщений по каналам (US-5) ──
    // active_writers_p50/p90 — активность канала (channel-activity-percentiles);
    // пусто, если ещё не посчитано.
    const breakdownHeader = ["agent_id", "канал", "ссылка", "ссылка_на_канал", "сообщений_за_день", "active_writers_p50", "active_writers_p90"];
    const breakdownRows: string[][] = r.agents.flatMap((a) =>
        a.channelBreakdown.map((c) => [
            a.agentId,
            csvEscapeField(c.title),
            c.url ?? "",
            c.channelUrl ?? "",
            String(c.msgCount),
            csvNum(c.activeWritersP50),
            csvNum(c.activeWritersP90),
        ]),
    );
    const breakdownTable = [breakdownHeader, ...breakdownRows].map((row) => row.join(",")).join("\n");

    // ── Третья таблица: агенты, получившие ограничение за отчётные сутки (telegram-error-handling) ──
    const restrictionsHeader = ["agent_id", "restriction_type"];
    const restrictionsRows: string[][] = r.restrictedAgents.map((ra) => [ra.agentId, ra.restrictionType]);
    const restrictionsTable = [restrictionsHeader, ...restrictionsRows].map((row) => row.join(",")).join("\n");

    return `${mainTable}\n\n${breakdownTable}\n\n${restrictionsTable}`;
}
