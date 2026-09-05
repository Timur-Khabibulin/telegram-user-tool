// scripts/ops/distribute-pool.ts — ручное распределение нераспределённых каналов из discovery.db.
//
// Читает каналы с assigned_agent IS NULL (пул незавершённого прогона discovery-similar)
// и раскладывает их round-robin по агентам платформы (до target каждому).
//
// Запуск: tsx src/scripts/ops/distribute-pool.ts --target <n> [--admin agent1] [--exclude agent6,agent13]

import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID, listAgentIds } from "../../core/config";
import { getUnassignedChannels, assignChannel } from "../../core/db/discovery";
import { addJoinQueue } from "../../core/db/join-queue";

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
    const target = Number(parseArg(argv, "--target"));

    if (!Number.isFinite(target) || target <= 0) {
        log.error("usage: tsx src/scripts/ops/distribute-pool.ts --target <n> [--admin agent1]");
        process.exit(1);
    }

    const exclude = new Set((parseArg(argv, "--exclude") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const allAgents = listAgentIds().filter((a) => !exclude.has(a));
    if (allAgents.length === 0) {
        log.error("[distribute-pool] нет агентов платформы (listAgentIds() пуст после --exclude)");
        process.exit(1);
    }

    const pool = getUnassignedChannels(adminAgentId);
    if (pool.length === 0) {
        log.info("[distribute-pool] нераспределённых каналов нет");
        return;
    }

    log.info(`[distribute-pool] пул: ${pool.length} каналов, агентов: ${allAgents.length}, target: ${target} на агента`);

    const assigned: Record<string, number> = {};
    for (const a of allAgents) assigned[a] = 0;

    let i = 0;
    for (const canonical of pool) {
        let tries = 0;
        while (assigned[allAgents[i]] >= target && tries < allAgents.length) {
            i = (i + 1) % allAgents.length;
            tries += 1;
        }
        if (tries >= allAgents.length) break;

        const agent = allAgents[i];
        const { assigned: ok } = assignChannel(adminAgentId, canonical, agent);
        if (ok) {
            addJoinQueue(agent, [canonical], log);
            assigned[agent] += 1;
            log.info(`[distribute-pool] ${agent}: +1 «${canonical}»`);
        }
        i = (i + 1) % allAgents.length;
    }

    log.info("[distribute-pool] готово:");
    for (const [agent, count] of Object.entries(assigned).filter(([, n]) => n > 0)) {
        log.info(`  ${agent}: +${count}`);
    }

    const remaining = getUnassignedChannels(adminAgentId).length;
    if (remaining > 0) log.warn(`[distribute-pool] осталось нераспределённых: ${remaining} (все агенты достигли target)`);
}

main();
