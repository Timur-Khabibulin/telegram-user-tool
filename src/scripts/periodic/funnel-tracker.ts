// scripts/periodic/funnel-tracker.ts — дневной сбор метрик воронки по всем агентам
// (funnel-tracking). Зеркало src/scripts/periodic/daily-summary.ts.
//
// Oneshot, запускается systemd-таймером раз в день на границе дня UTC+5
// (19:00 UTC). Собирает завершившийся день (persist=true: пишет снапшоты и
// дневные агрегаты), рендерит отчёт-воронку и шлёт в Saved Messages получателя.
// --admin задаёт владельца данных (funnel.db/reports/, по умолчанию agent1),
// --send-as — получателя отчёта (по умолчанию REPORT_AGENT_ID) — независимые
// параметры, не обязаны совпадать.
// Запуск: `tsx funnel-tracker.ts --admin agent1 --send-as agent27 --private-channel <id>`.

import * as fs from "fs";
import * as path from "path";

import type { Logger } from "../../core/logger";
import { TelegramService } from "../../core/telegram/service";
import { finishedDayWindow } from "../../features/funnel/runs-summary";
import { FUNNEL_ADMIN_AGENT_ID, FUNNEL_PRIVATE_CHANNEL_ID, REPORT_AGENT_ID } from "../../core/config";
import { ensureFunnelSchema } from "../../core/db/funnel";
import { collectFunnel, withTimeout } from "../../features/funnel/funnel-collect";
import { renderFunnel, buildFunnelCsv, funnelCsvPath } from "../../features/funnel/funnel-report";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;
    const sendAsAgentId = parseArg(argv, "--send-as") ?? REPORT_AGENT_ID;
    const privateChannelId = parseArg(argv, "--private-channel") ?? FUNNEL_PRIVATE_CHANNEL_ID;

    ensureFunnelSchema(adminAgentId);

    // Завершившийся день UTC+5 (как daily-summary).
    const window = finishedDayWindow();

    const tg = new TelegramService(log);
    try {
        const result = await collectFunnel(
            tg,
            { window, persist: true, adminAgentId, privateChannelId, disconnectAfterEachAgent: true },
            log,
        );

        if (result.agents.length === 0) {
            log.info("[funnel-tracker] no agents found — nothing to report");
            return;
        }

        const text = renderFunnel(result);

        // CSV со всеми 7 этапами — в каталог отчётов (конвенция channel-analysis).
        const csvPath = funnelCsvPath(adminAgentId, window);
        fs.mkdirSync(path.dirname(csvPath), { recursive: true });
        fs.writeFileSync(csvPath, buildFunnelCsv(result), "utf-8");

        // Таймаут: это тот же MTProto-путь, что зависал у агентов в collectFunnel
        // (agent4, 2026-07-05) — без границы зависшая отправка админу так же
        // блокирует finally (disconnect + process.exit) навсегда.
        await withTimeout(
            (async () => {
                tg.loadAccount(sendAsAgentId);
                await tg.sendSavedMessage(text, "md");
                await tg.sendSavedDocument(csvPath, `Воронка · ${window.label} — полная таблица по агентам`);
            })(),
            90_000,
            "send report to recipient",
        );
        log.info(`[funnel-tracker] sent funnel for ${window.label} (data: ${adminAgentId}) to ${sendAsAgentId}`);
    } finally {
        // Таймаут: зависший disconnect() одного из ~20+ открытых за прогон клиентов
        // держал процесс живым до убийства по systemd TimeoutStartSec (2026-07 —
        // сервис каждый день падал в failed через 30 мин уже после отправки отчёта).
        // disconnect() внутри идёт последовательно по клиентам (TelegramService.disconnect),
        // поэтому граница даёт запас на десятки агентов, а не только на один зависший.
        await withTimeout(tg.disconnect(), 30_000, "tg.disconnect()").catch((err: any) => {
            log.warn(`[funnel-tracker] disconnect — ${err?.message ?? err}`);
        });
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[funnel-tracker] fatal: ${err?.message ?? err}`);
        if (err?.stack) log.error(`[funnel-tracker] stack: ${err.stack}`);
        process.exit(1);
    });
