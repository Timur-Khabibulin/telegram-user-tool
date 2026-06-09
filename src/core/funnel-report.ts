// core/funnel-report.ts — рендер текстового отчёта-воронки (funnel-tracking).
//
// Рендер с двумя требованиями платформы (см. openclaw#36323 и Telegram entities):
//  1. Таблица идёт в код-блоке (``` + parseMode="md") — иначе колонки не
//     моноширинные. Ширина строк держится ≤40 символов: мобильный Telegram
//     переносит моноширинную строку после ~40 знаков и ломает таблицу.
//  2. Отступы делаются НЕРАЗРЫВНЫМ пробелом ( ): markdown-обработка агента
//     схлопывает прогоны обычных пробелов в один (даже внутри блока), а NBSP —
//     нет, и в моноширинном шрифте он той же ширины.
// Проза (заголовок, заявки, легенда, сбои) — вне код-блока: она читается обычным
// шрифтом и переносится естественно, без горизонтального скролла.

import type { FunnelResult } from "./funnel-collect";

const NBSP = " ";

function signed(n: number): string {
    return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * Метрика охвата: абсолют, в скобках прирост за день. NBSP внутри — чтобы значение
 * не схлопывалось и не разрывалось.
 *   "769 (+12)" — сейчас 769, за сегодня +12;
 *   "769"       — первый прогон, базы для дельты ещё нет;
 *   "—"         — данных нет (у аккаунта не задан канал в профиле).
 */
function fmtMetric(delta: number | null, abs: number | null): string {
    if (abs == null) return "—";
    if (delta == null) return String(abs);
    return `${abs}${NBSP}(${signed(delta)})`;
}

export function renderFunnel(r: FunnelResult): string {
    // Короткие заголовки — чтобы строка таблицы влезала в ~40 символов на мобиле.
    const header = ["Агент", "Отв", "DM", "Просм", "Подп"];

    const dataRows = r.agents.map((a) => [
        a.agentId,
        String(a.groupReplies),
        String(a.dmsSent),
        fmtMetric(a.postViewsDelta, a.postViewsAbs),
        fmtMetric(a.publicSubsDelta, a.publicSubsAbs),
    ]);

    const totReplies = r.agents.reduce((s, a) => s + a.groupReplies, 0);
    const totDms = r.agents.reduce((s, a) => s + a.dmsSent, 0);
    const viewsDeltas = r.agents.map((a) => a.postViewsDelta).filter((v): v is number => v != null);
    const subsDeltas = r.agents.map((a) => a.publicSubsDelta).filter((v): v is number => v != null);
    const totViews = viewsDeltas.length ? signed(viewsDeltas.reduce((s, v) => s + v, 0)) : "—";
    const totSubs = subsDeltas.length ? signed(subsDeltas.reduce((s, v) => s + v, 0)) : "—";
    const totalRow = ["Итого", String(totReplies), String(totDms), totViews, totSubs];

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

    // ── Проза вне блока ──
    const out: string[] = [];
    out.push(`📊 Воронка · ${r.window.label} (UTC+5)`);
    out.push("");
    out.push("```");
    out.push(...table);
    out.push("```");
    out.push("");
    out.push(
        r.privateNote
            ? `Заявки в приватный канал: ${r.privateNote}`
            : `Заявки в приватный канал: ${fmtMetric(r.privateRequestsDelta, r.privateRequestsAbs)}`,
    );
    out.push("");
    out.push("Отв / DM — отправлено за сегодня (UTC+5)");
    out.push("Просм — просмотры поста, Подп — подписчики канала");
    out.push("в скобках — прирост за сегодня; — нет канала в профиле");

    // Пометки — только реальные сбои. «Нет канала» виден по «—» в таблице.
    const errors = r.agents.filter((a) => a.note && a.note.startsWith("пропущен"));
    if (errors.length > 0) {
        out.push("");
        out.push("Сбои:");
        for (const a of errors) out.push(`• ${a.agentId} — ${a.note}`);
    }

    return out.join("\n");
}
