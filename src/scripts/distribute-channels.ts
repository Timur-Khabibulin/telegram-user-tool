// scripts/distribute-channels.ts — round-robin распределение «сырого» списка каналов
// (без готового назначения агента, один линк на строку) по заданному подмножеству
// агентов, с пропуском уже известных реестру discovery каналов.
//
// Отличие от distribute-pool.ts (тот берёт уже зарегистрированные, но
// неназначенные каналы из discovery.db) и import-agent-pool.ts (там агент
// приходит per-row из CSV) — здесь входной список каналов без агента, а агент
// выбирается round-robin из явного --agents списка.
//
// Запуск: tsx src/scripts/distribute-channels.ts --file <path> --agents agent6,agent8,... [--admin agent1]

import * as fs from "fs";
import { listAgentIds, FUNNEL_ADMIN_AGENT_ID } from "../core/config";
import { normalizeChannelLink, registerChannel, getChannelStatus } from "../core/db/discovery";
import { addJoinQueue } from "../core/db/join-queue";
import type { Logger } from "../core/logger";

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
    const filePath = parseArg(argv, "--file");
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;
    const agentsArg = parseArg(argv, "--agents");

    if (!filePath || !agentsArg) {
        log.error("usage: tsx src/scripts/distribute-channels.ts --file <path> --agents agent6,agent8,... [--admin agent1]");
        process.exit(1);
    }

    const knownAgents = new Set(listAgentIds());
    const agents = agentsArg.split(",").map((s) => s.trim()).filter(Boolean);
    for (const a of agents) {
        if (!knownAgents.has(a)) {
            log.error(`[distribute-channels] неизвестный агент: ${a}`);
            process.exit(1);
        }
    }

    const links = fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

    log.info(`[distribute-channels] каналов на входе: ${links.length}, агентов: ${agents.length}`);

    const added: Record<string, number> = {};
    for (const a of agents) added[a] = 0;

    let i = 0;
    let registered = 0;
    let skippedKnown = 0;

    for (const rawLink of links) {
        const canonical = normalizeChannelLink(rawLink);
        const status = getChannelStatus(adminAgentId, canonical);
        if (status !== null) {
            skippedKnown += 1;
            continue;
        }

        const agent = agents[i % agents.length];
        i += 1;

        registerChannel(adminAgentId, canonical, agent);
        addJoinQueue(agent, [canonical], log);
        added[agent] += 1;
        registered += 1;
    }

    log.info("[distribute-channels] готово:");
    for (const [agent, count] of Object.entries(added)) {
        log.info(`  ${agent}: +${count}`);
    }
    log.info(`[distribute-channels] всего зарегистрировано=${registered} пропущено(уже известен)=${skippedKnown}`);
}

main();
