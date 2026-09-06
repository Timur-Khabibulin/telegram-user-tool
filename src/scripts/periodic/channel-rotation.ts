// scripts/periodic/channel-rotation.ts — суточная кросс-агентная ротация
// каналов, покинутых из-за бана (channel-rotation). Зеркало
// src/scripts/periodic/daily-summary.ts по структуре запуска.
//
// Oneshot, запускается systemd-таймером раз в сутки, с отступом ≥12 часов от
// цикла leave-banned-channels (per-agent, период ~180 мин, без фиксированного
// времени суток). Только SQLite — Telegram не трогает, фактическое
// вступление в канал выполняет join-queue отдельным прогоном.
// Запуск: `tsx channel-rotation.ts [--admin <agentId>]`.

import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { runChannelRotation } from "../../features/channel-rotation/run";

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

function main(): void {
    const argv = process.argv.slice(2);
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;

    const summary = runChannelRotation(log, adminAgentId);
    log.info(`[channel-rotation] done — rotated=${summary.rotated}/${summary.candidatesTotal}`);
}

try {
    main();
    process.exit(0);
} catch (err: any) {
    log.error(`[channel-rotation] fatal: ${err?.message ?? err}`);
    if (err?.stack) log.error(`[channel-rotation] stack: ${err.stack}`);
    process.exit(1);
}
