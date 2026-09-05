// scripts/daily-summary.ts — дневная сводка прогонов по всем агентам в Saved
// Messages получателя отчётов (run-status-tracking §5).
//
// Запускается systemd-таймером раз в день на границе дня UTC+5 (19:00 UTC) и
// сводит ЗАВЕРШИВШИЙСЯ день. Окно/агрегацию даёт features/funnel/runs-summary; здесь —
// только разбор --send-as, загрузка аккаунта-получателя и отправка текста.
// Запуск: `tsx daily-summary.ts --send-as <agentId>` (по умолчанию REPORT_AGENT_ID).

import type { Logger } from "../core/logger";
import { TelegramService } from "../core/telegram/service";
import { buildDailySummary, finishedDayWindow } from "../features/funnel/runs-summary";
import { REPORT_AGENT_ID } from "../core/config";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

function parseSendAsAgentId(argv: string[]): string {
    const idx = argv.indexOf("--send-as");
    const value = idx !== -1 ? argv[idx + 1] : undefined;
    if (idx !== -1 && (!value || value.startsWith("--"))) {
        throw new Error("Usage: daily-summary.ts --send-as <agentId>");
    }
    return value ?? REPORT_AGENT_ID;
}

async function main(): Promise<void> {
    const sendAsAgentId = parseSendAsAgentId(process.argv.slice(2));

    // Завершившийся день UTC+5 (вчерашние сутки относительно запуска на границе дня).
    const window = finishedDayWindow();
    const { text } = buildDailySummary(window);

    const tg = new TelegramService(log);
    tg.loadAccount(sendAsAgentId);
    try {
        await tg.sendSavedMessage(text);
        log.info(`[daily-summary] sent summary for ${window.label} to ${sendAsAgentId}`);
    } finally {
        await tg.disconnect();
    }
}

main().catch((err) => {
    log.error(`[daily-summary] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
