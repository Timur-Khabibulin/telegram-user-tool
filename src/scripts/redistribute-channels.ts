// scripts/redistribute-channels.ts — принудительное перераспределение уже известных
// каналов на новых агентов по готовому CSV (agent-pool-redistribution).
//
// Отличие от import-agent-pool.ts/distribute-channels.ts: те защищают уже активные
// назначения от перезаписи (чтобы не перехватить чужой рабочий канал случайно).
// Здесь переназначение — сама цель прогона (внешний пересчёт распределения),
// поэтому discovery.db и agent_pools перезаписываются безусловно, а канал кладётся
// в tg-join-queue.db нового агента вне зависимости от прежнего состояния.
//
// Формат входного CSV: channel_link,assigned_agent,pool,subs_count,avg_views
// (заголовок обязателен, разделитель — запятая; лишние колонки не парсятся).
//
// Запуск: tsx src/scripts/redistribute-channels.ts --file <path> [--admin agent1]

import * as fs from "fs";
import { listAgentIds, FUNNEL_ADMIN_AGENT_ID } from "../core/config";
import { normalizeChannelLink, forceAssignChannel, setAgentPool } from "../core/db/discovery";
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

interface ImportRow {
    link: string;
    agentId: string;
    pool: string;
}

function parseCsv(text: string): ImportRow[] {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows: ImportRow[] = [];
    for (const line of lines.slice(1)) {
        const parts = line.split(",");
        const [link, agentId, pool] = parts;
        if (!link || !agentId) continue;
        rows.push({ link: link.trim(), agentId: agentId.trim(), pool: (pool ?? "").trim() });
    }
    return rows;
}

function main(): void {
    const argv = process.argv.slice(2);
    const filePath = parseArg(argv, "--file");
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;

    if (!filePath) {
        log.error("usage: tsx src/scripts/redistribute-channels.ts --file <path> [--admin agent1]");
        process.exit(1);
    }

    const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
    const knownAgents = new Set(listAgentIds());

    let skippedUnknownAgent = 0;
    let poolsSet = 0;
    const seenPoolForAgent = new Map<string, string>();
    const linksByAgent = new Map<string, string[]>();

    for (const row of rows) {
        if (!knownAgents.has(row.agentId)) {
            log.warn(`[redistribute-channels] ${row.agentId}: неизвестный агент — строка пропущена (link=${row.link})`);
            skippedUnknownAgent += 1;
            continue;
        }

        const canonical = normalizeChannelLink(row.link);
        forceAssignChannel(adminAgentId, canonical, row.agentId);

        if (!linksByAgent.has(row.agentId)) linksByAgent.set(row.agentId, []);
        linksByAgent.get(row.agentId)!.push(canonical);

        if (row.pool && seenPoolForAgent.get(row.agentId) !== row.pool) {
            setAgentPool(adminAgentId, row.agentId, row.pool);
            seenPoolForAgent.set(row.agentId, row.pool);
            poolsSet += 1;
        }
    }

    let queued = 0;
    for (const [agentId, links] of linksByAgent) {
        const { added, skipped } = addJoinQueue(agentId, links, log);
        queued += added;
        log.info(`[redistribute-channels] ${agentId}: +${added} в очередь (дублей в CSV пропущено: ${skipped}), пул="${seenPoolForAgent.get(agentId) ?? ""}"`);
    }

    log.info(
        `[redistribute-channels] готово: строк=${rows.length} агентов=${linksByAgent.size} ` +
            `поставлено_в_очередь=${queued} пропущено(неизв.агент)=${skippedUnknownAgent} пулов_записано=${poolsSet}`,
    );
}

main();
