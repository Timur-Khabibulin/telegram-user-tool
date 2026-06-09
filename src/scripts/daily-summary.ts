// scripts/daily-summary.ts — дневная сводка прогонов по всем агентам в Saved
// Messages админ-аккаунта (run-status-tracking §5).
//
// Запускается systemd-таймером раз в день на границе дня UTC+5 (19:00 UTC) и
// сводит ЗАВЕРШИВШИЙСЯ день. Окно/агрегацию даёт core/runs-summary; здесь —
// только разбор --admin, загрузка админ-аккаунта и отправка текста.
// Запуск: `tsx daily-summary.ts --admin <agentId>`.

import type { Logger } from "../core/logger";
import { TelegramService } from "../core/telegram/service";
import { buildDailySummary, finishedDayWindow } from "../core/runs-summary";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

function parseAdminAgentId(argv: string[]): string {
    const idx = argv.indexOf("--admin");
    const value = idx !== -1 ? argv[idx + 1] : undefined;
    if (!value || value.startsWith("--")) {
        throw new Error("Usage: daily-summary.ts --admin <agentId>");
    }
    return value;
}

async function main(): Promise<void> {
    const adminAgentId = parseAdminAgentId(process.argv.slice(2));

    // Завершившийся день UTC+5 (вчерашние сутки относительно запуска на границе дня).
    const window = finishedDayWindow();
    const { text } = buildDailySummary(window);

    const tg = new TelegramService(log);
    tg.loadAccount(adminAgentId);
    try {
        await tg.sendSavedMessage(text);
        log.info(`[daily-summary] sent summary for ${window.label} to admin ${adminAgentId}`);
    } finally {
        await tg.disconnect();
    }
}

main().catch((err) => {
    log.error(`[daily-summary] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
