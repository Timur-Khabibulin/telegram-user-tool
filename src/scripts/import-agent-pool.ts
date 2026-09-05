// scripts/import-agent-pool.ts — массовый импорт канал→агент из готового CSV
// (agentId;link;pool_name), с прямым назначением агента (без round-robin).
//
// Отдельный путь от discovery-add-pool.ts/distribute-pool.ts (тот — для
// автоматического discovery-similar пула без агента и round-robin раскладки).
// Здесь агент уже известен по строке CSV — источник, как правило, внешний
// сегментационный анализ (пример: channels/health_segmented.csv), где весь
// пул одного сегмента закреплён за одним агентом.
//
// Запуск: tsx src/scripts/import-agent-pool.ts --file <path> [--admin agent1]

import * as fs from "fs";
import { listAgentIds, FUNNEL_ADMIN_AGENT_ID } from "../core/config";
import {
    normalizeChannelLink,
    registerChannel,
    getChannelStatus,
    trySetAgentPool,
} from "../core/db/discovery";
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
    agentId: string;
    link: string;
    poolName?: string;
}

/** Строки CSV `agentId;link;pool_name` — pool_name опционален (пусто/отсутствует допустимо).
 *  Первая строка — заголовок (пропускается, если первое поле не похоже на agentId из платформы —
 *  проверяется позже за счёт listAgentIds(), здесь просто безусловно пропускаем строку 1). */
function parseCsv(text: string): ImportRow[] {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows: ImportRow[] = [];
    for (const line of lines.slice(1)) {
        const parts = line.split(";").map((p) => p.trim());
        const [agentId, link, poolName] = parts;
        if (!agentId || !link) continue;
        rows.push({ agentId, link, poolName: poolName || undefined });
    }
    return rows;
}

function main(): void {
    const argv = process.argv.slice(2);
    const filePath = parseArg(argv, "--file");
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;

    if (!filePath) {
        log.error("usage: tsx src/scripts/import-agent-pool.ts --file <path> [--admin agent1]");
        process.exit(1);
    }

    const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
    const knownAgents = new Set(listAgentIds());

    let registered = 0;
    let skippedUnknownAgent = 0;
    let skippedPoolConflict = 0;
    let skippedAlreadyActive = 0;

    for (const row of rows) {
        if (!knownAgents.has(row.agentId)) {
            log.warn(`[import-agent-pool] ${row.agentId}: неизвестный агент — строка пропущена (link=${row.link})`);
            skippedUnknownAgent += 1;
            continue;
        }

        if (row.poolName) {
            const poolResult = trySetAgentPool(adminAgentId, row.agentId, row.poolName);
            if (!poolResult.ok) {
                log.warn(
                    `[import-agent-pool] ${row.agentId}: конфликт пула — сохранён "${poolResult.existing}", в строке "${row.poolName}" — строка пропущена (link=${row.link})`,
                );
                skippedPoolConflict += 1;
                continue;
            }
        }

        const canonical = normalizeChannelLink(row.link);
        const status = getChannelStatus(adminAgentId, canonical);

        if (status === null) {
            registerChannel(adminAgentId, canonical, row.agentId);
            addJoinQueue(row.agentId, [canonical], log);
            registered += 1;
            continue;
        }

        log.info(`[import-agent-pool] ${row.agentId}: канал «${canonical}» уже размещён (agent=${status.assignedAgent}) — пропущен`);
        skippedAlreadyActive += 1;
    }

    log.info(
        `[import-agent-pool] готово: строк=${rows.length} зарегистрировано=${registered} ` +
            `пропущено(неизв.агент)=${skippedUnknownAgent} пропущено(конфликт пула)=${skippedPoolConflict} пропущено(уже активен)=${skippedAlreadyActive}`,
    );
}

main();
