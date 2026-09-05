// scripts/disable-join-queue-all.ts — разовый скрипт: выключает задачу
// join-queue у всех агентов платформы.
//
// removeTask (не прямой disableTask) — если join-queue была единственной
// активной задачей агента, это же гасит его heartbeat-таймер (6.4,
// scheduler-control.ts), а не только саму задачу. Идемпотентно: агент без
// join-queue или уже выключенной — no-op.
//
// Запуск: tsx src/scripts/disable-join-queue-all.ts

import type { Logger } from "../core/logger";
import { listAgentIds } from "../core/config";
import { removeTask } from "../core/scheduler-control";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

async function main(): Promise<void> {
    const agents = listAgentIds();
    let timerDisabledCount = 0;

    for (const agentId of agents) {
        const result = await removeTask({ agentId, type: "join-queue" }, log);
        if (result.timerDisabled) timerDisabledCount += 1;
        log.info(
            `[disable-join-queue-all] ${agentId}: timerDisabled=${result.timerDisabled}` +
                (result.systemctl ? ` systemctl.ok=${result.systemctl.ok}` : ""),
        );
    }

    log.info(`[disable-join-queue-all] done — agents=${agents.length} timerDisabled=${timerDisabledCount}`);
}

main();
