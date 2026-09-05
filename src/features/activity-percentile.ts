// features/activity-percentile.ts — расчёт p50/p90 уникальных отправителей сообщений
// в сутки за скользящее окно 7 дней (channel-activity-percentiles).
//
// Чистая функция без побочных эффектов: вход — список {fromId, date} сообщений
// чата, выход — перцентили. Источник сообщений (MTProto) и сохранение
// результата — забота вызывающего (src/scripts/channel-activity-update.ts).
//
// Окно — 7 дней; TTL пересчёта (activity_updated_at) при этом остаётся 30 дней
// (ACTIVITY_CACHE_TTL_SECONDS в channel-activity-update.ts), как у avg_views/
// subs_count — окно данных и частота пересчёта не обязаны совпадать.

import { startOfUtcPlus5Day } from "../core/runs-summary";

const DAY_SECONDS = 86400;
const WINDOW_DAYS = 7;

export interface ActivityMessage {
    fromId: string;
    date: number;
}

export interface ActivityPercentiles {
    p50: number;
    p90: number;
}

/** [начало, конец) окна — 7 полных суток UTC+5, заканчивающихся вчера (сегодня ещё не завершено). */
export function activityWindow(nowSec: number = Math.floor(Date.now() / 1000)): { startSec: number; endSec: number } {
    const endSec = startOfUtcPlus5Day(nowSec);
    return { startSec: endSec - WINDOW_DAYS * DAY_SECONDS, endSec };
}

/** Перцентиль линейной интерполяцией между рангами (numpy.percentile / Excel PERCENTILE.INC). */
function interpolatedPercentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 1) return sortedAsc[0];
    const rank = p * (sortedAsc.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sortedAsc[lower];
    const frac = rank - lower;
    return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * frac;
}

/**
 * Раскладывает сообщения по суткам окна инкрементально — по одному сообщению
 * за раз, без накопления полного списка в памяти (channel-activity-percentiles,
 * инцидент 2026-08-25: канал с 42690 сообщениями за 30 дней истории ронял
 * процесс по OOM при накоплении всей истории в массиве перед подсчётом —
 * актуально независимо от текущей ширины окна). Источник сообщений
 * (`TelegramService.iterChatHistorySince`) отдаёт их постранично; аккумулятор
 * держит только `WINDOW_DAYS` множеств `fromId` — на порядки меньше, чем
 * исходные сообщения, независимо от того, сколько их было на самом деле.
 * Сутки без сообщений всё равно входят в итоговый ряд как 0 — полнота окна
 * не приносится в жертву экономии памяти, обрезается только пиковое
 * потребление, не данные.
 */
export class ActivityAccumulator {
    private readonly startSec: number;
    private readonly endSec: number;
    private readonly sendersByDay: Set<string>[];
    private messageCount = 0;

    constructor(nowSec: number = Math.floor(Date.now() / 1000)) {
        const { startSec, endSec } = activityWindow(nowSec);
        this.startSec = startSec;
        this.endSec = endSec;
        this.sendersByDay = Array.from({ length: WINDOW_DAYS }, () => new Set<string>());
    }

    add(message: ActivityMessage): void {
        if (message.date < this.startSec || message.date >= this.endSec) return;
        const dayIndex = Math.floor((message.date - this.startSec) / DAY_SECONDS);
        this.sendersByDay[dayIndex].add(message.fromId);
        this.messageCount++;
    }

    /** Число сообщений, учтённых в окне (для логирования — не влияет на расчёт). */
    get count(): number {
        return this.messageCount;
    }

    finalize(): ActivityPercentiles {
        const dailyCounts = this.sendersByDay.map((s) => s.size).sort((a, b) => a - b);
        return {
            p50: interpolatedPercentile(dailyCounts, 0.5),
            p90: interpolatedPercentile(dailyCounts, 0.9),
        };
    }
}

/**
 * Строит ряд из `WINDOW_DAYS` значений — по одному на каждые сутки окна, равных
 * числу уникальных `fromId` за эти сутки (сутки без сообщений = 0, не
 * исключаются), и возвращает p50/p90 этого ряда. Удобная обёртка над `ActivityAccumulator`
 * для случаев, когда сообщения уже собраны целиком (тесты) — реальный сбор
 * (`channel-activity-update.ts`) использует `ActivityAccumulator` напрямую,
 * потоково, без промежуточного массива.
 */
export function computeActivityPercentiles(
    messages: ActivityMessage[],
    nowSec: number = Math.floor(Date.now() / 1000),
): ActivityPercentiles {
    const acc = new ActivityAccumulator(nowSec);
    for (const m of messages) acc.add(m);
    return acc.finalize();
}
