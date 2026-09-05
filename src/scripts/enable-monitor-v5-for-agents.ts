// scripts/enable-monitor-v5-for-agents.ts — разовый скрипт: включает задачу
// monitor-v5 для явно перечисленных агентов (тот же приём, что
// activate-leave-banned-for-agents.ts) — createOrUpdateTask вместо upsertTask
// напрямую, чтобы получить round-robin фазу через computeDefaultSchedule и,
// при необходимости, поднять heartbeat-таймер (у этих агентов таймер уже
// работает — join-queue/leave-banned включены, systemctl не понадобится).
//
// Запуск: tsx src/scripts/enable-monitor-v5-for-agents.ts

import type { Logger } from "../core/logger";
import { createOrUpdateTask } from "../core/scheduler-control";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const AGENT_IDS = [
    "agent36", "agent39", "agent155", "agent175", "agent204", "agent209", "agent211",
];

async function main(): Promise<void> {
    for (const agentId of AGENT_IDS) {
        const result = await createOrUpdateTask({ agentId, type: "monitor-v5" }, log);
        log.info(
            `[enable-monitor-v5] ${agentId}: schedule="${result.schedule}" tz=${result.tz} timerEnabled=${result.timerEnabled}` +
                (result.systemctl ? ` systemctl.ok=${result.systemctl.ok}` : ""),
        );
    }
}

main();
