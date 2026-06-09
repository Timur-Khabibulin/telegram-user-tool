// scripts/funnel-tracker.ts — дневной сбор метрик воронки по всем агентам
// (funnel-tracking). Зеркало src/scripts/daily-summary.ts.
//
// Oneshot, запускается systemd-таймером раз в день на границе дня UTC+5
// (19:00 UTC). Собирает завершившийся день (persist=true: пишет снапшоты и
// дневные агрегаты), рендерит отчёт-воронку и шлёт в Saved Messages админ-агента.
// Запуск: `tsx funnel-tracker.ts --admin agent1 --private-channel <id>`.

import type { Logger } from "../core/logger";
import { TelegramService } from "../core/telegram/service";
import { finishedDayWindow } from "../core/runs-summary";
import { FUNNEL_ADMIN_AGENT_ID, FUNNEL_PRIVATE_CHANNEL_ID } from "../core/config";
import { ensureFunnelSchema } from "../core/db/funnel";
import { collectFunnel } from "../core/funnel-collect";
import { renderFunnel } from "../core/funnel-report";

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
    const privateChannelId = parseArg(argv, "--private-channel") ?? FUNNEL_PRIVATE_CHANNEL_ID;

    ensureFunnelSchema(adminAgentId);

    // Завершившийся день UTC+5 (как daily-summary).
    const window = finishedDayWindow();

    const tg = new TelegramService(log);
    try {
        const result = await collectFunnel(
            tg,
            { window, persist: true, adminAgentId, privateChannelId },
            log,
        );

        if (result.agents.length === 0) {
            log.info("[funnel-tracker] no agents found — nothing to report");
            return;
        }

        const text = renderFunnel(result);

        tg.loadAccount(adminAgentId);
        await tg.sendSavedMessage(text, "md");
        log.info(`[funnel-tracker] sent funnel for ${window.label} to admin ${adminAgentId}`);
    } finally {
        await tg.disconnect();
    }
}

main().catch((err) => {
    log.error(`[funnel-tracker] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
