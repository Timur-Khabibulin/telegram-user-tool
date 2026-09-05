// scripts/activate-leave-banned-for-agents.ts — разовый скрипт (leave-banned-human-pacing):
// создаёт/включает задачу leave-banned для явно перечисленных агентов.
//
// Не backfill существующих строк (см. backfill-schedule-defaults.ts) — эти
// агенты не имели строки leave-banned вообще. Используется createOrUpdateTask
// (не upsertTask напрямую), чтобы получить round-robin фазу через
// computeDefaultSchedule и, при необходимости, поднять heartbeat-таймер.
//
// Запуск: tsx src/scripts/activate-leave-banned-for-agents.ts

import type { Logger } from "../core/logger";
import { createOrUpdateTask } from "../core/scheduler-control";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const AGENT_IDS = [
    "agent123", "agent129", "agent130", "agent132", "agent133", "agent134",
    "agent136", "agent137", "agent139", "agent140", "agent141", "agent142",
    "agent144", "agent147", "agent148", "agent149", "agent151", "agent152",
    "agent153", "agent154", "agent188", "agent194", "agent196", "agent197",
    "agent198", "agent199", "agent200", "agent201", "agent202", "agent204",
    "agent205", "agent206", "agent207", "agent208", "agent209", "agent210",
    "agent211", "agent212",
];

async function main(): Promise<void> {
    for (const agentId of AGENT_IDS) {
        const result = await createOrUpdateTask({ agentId, type: "leave-banned" }, log);
        log.info(
            `[activate-leave-banned] ${agentId}: schedule="${result.schedule}" tz=${result.tz} timerEnabled=${result.timerEnabled}` +
                (result.systemctl ? ` systemctl.ok=${result.systemctl.ok}` : ""),
        );
    }
}

main();
