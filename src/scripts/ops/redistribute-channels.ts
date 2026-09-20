// scripts/ops/redistribute-channels.ts — принудительное распределение списка
// каналов на персону (channel-multipersona).
//
// После перехода на мультиперсонность redistribute сливается с distribution
// (R11): пиннинг канала на КОНКРЕТНОГО агента и колонки assigned_agent/pool из
// входа убраны — цель задаётся ИМЕНЕМ ПЕРСОНЫ, целевые агенты берутся как её
// активные агенты, раскладка идёт тем же water-fill в рамках персоны. Скрипт —
// тонкая обёртка над runDistribution (та же логика, что бот distribution-listener
// и distribute-channels).
//
// Формат входного файла: один канонический линк канала на строку.
// Запуск: tsx src/scripts/ops/redistribute-channels.ts --file <path> --persona <name> [--admin agent1]

import * as fs from "fs";
import { FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { resolvePersonaTargets } from "../../core/persona-targets";
import { runDistribution, type CsvRow } from "../../features/channel-distribution/run";
import type { Logger } from "../../core/logger";

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
    const persona = parseArg(argv, "--persona");
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;

    if (!filePath || !persona) {
        log.error("usage: tsx src/scripts/ops/redistribute-channels.ts --file <path> --persona <name> [--admin agent1]");
        process.exit(1);
    }

    const targets = resolvePersonaTargets(persona, adminAgentId);
    if (targets.length === 0) {
        log.error(`[redistribute-channels] в персоне «${persona}» нет активных агентов — распределять некому`);
        process.exit(1);
    }

    const rows: CsvRow[] = fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((rawLink) => ({ rawLink, metrics: {} }));

    log.info(`[redistribute-channels] каналов на входе: ${rows.length}, персона: ${persona}, активных агентов: ${targets.length}`);

    const result = runDistribution(rows, persona, targets, log, adminAgentId);
    log.info(
        `[redistribute-channels] готово: added=${result.counts.added} skipped=${result.counts.skipped} ` +
            `error=${result.counts.error} byAgent=${JSON.stringify(result.byAgent)}`,
    );
}

main();
