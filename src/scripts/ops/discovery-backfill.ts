// scripts/ops/discovery-backfill.ts — разовый ручной backfill реестра discovery.
//
// Заносит в реестр уже известные каналы, чтобы discovery не назначил уже
// вступлённый канал другому агенту (иначе пересечение). Источник ссылок —
// join_queue каждого агента, только успешно вступлённые (status='joined');
// публичные каналы, не прошедшие через очередь,
// оператор добавляет флагом --manual. Идемпотентно (INSERT OR IGNORE по
// canonical_link), но необратимо для реестра — запускать осознанно, один раз.
//
// Запуск:
//   tsx discovery-backfill.ts [--admin agent1] [--agents a,b]
//   tsx discovery-backfill.ts --manual "t.me/foo,t.me/bar" --manual-agent agent1
//
// Design: docs/design/channel-discovery/channel-discovery-v1.md §5.3.

import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID, listAgentIds, buildPersonaIndex } from "../../core/config";
import { normalizeChannelLink, assignToPersona } from "../../core/db/discovery";
import { getJoinedLinks } from "../../core/db/join-queue";

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

function parseList(argv: string[], flag: string): string[] {
    const raw = parseArg(argv, flag);
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Закрепляет ссылки за agentId в рамках его персоны; возвращает число новых строк. */
function seed(adminAgentId: string, links: string[], agentId: string, persona: string): number {
    let inserted = 0;
    for (const link of links) {
        if (!link) continue;
        const canonical = normalizeChannelLink(link);
        if (assignToPersona(adminAgentId, { persona, canonicalLink: canonical, agentId }, "operator", log).assigned) inserted += 1;
    }
    return inserted;
}

function main(): void {
    const argv = process.argv.slice(2);
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;
    const agentsArg = parseList(argv, "--agents");
    const agents = agentsArg.length > 0 ? agentsArg : listAgentIds();
    const personaIndex = buildPersonaIndex();

    const perAgent: Record<string, number> = {};

    // 1) Из join_queue каждого агента — только успешно вступлённые (status='joined').
    for (const agentId of agents) {
        const persona = personaIndex.get(agentId);
        if (!persona) {
            log.warn(`[discovery-backfill] персона агента ${agentId} не определена — пропуск`);
            continue;
        }
        const links = getJoinedLinks(agentId, log);
        perAgent[agentId] = (perAgent[agentId] ?? 0) + seed(adminAgentId, links, agentId, persona);
    }

    // 2) Ручные публичные каналы (не прошедшие через очередь).
    const manual = parseList(argv, "--manual");
    if (manual.length > 0) {
        const manualAgent = parseArg(argv, "--manual-agent");
        if (!manualAgent) {
            log.error("[discovery-backfill] --manual требует --manual-agent <agentId>");
            process.exit(1);
        }
        const manualPersona = personaIndex.get(manualAgent);
        if (!manualPersona) {
            log.error(`[discovery-backfill] персона агента ${manualAgent} не определена`);
            process.exit(1);
        }
        perAgent[manualAgent] = (perAgent[manualAgent] ?? 0) + seed(adminAgentId, manual, manualAgent, manualPersona);
    }

    log.info(`[discovery-backfill] done — seeded perAgent=${JSON.stringify(perAgent)}`);
}

main();
