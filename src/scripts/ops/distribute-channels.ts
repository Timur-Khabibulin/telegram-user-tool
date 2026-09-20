// scripts/ops/distribute-channels.ts — распределение «сырого» списка каналов
// (один линк на строку) на персону (channel-multipersona).
//
// Тонкая обёртка над общей логикой распределения: ссылки оборачиваются в CsvRow[]
// (без метрик), цель — имя персоны, целевые агенты — её активные агенты. Дедуп в
// рамках персоны, water-fill в рамках персоны, постановка в очередь — всё в
// runDistribution (тот же путь, что бот и redistribute). Пиннинг на конкретного
// агента и раскладка по явному списку агентов убраны.
//
// Запуск: tsx src/scripts/ops/distribute-channels.ts --file <path> --persona <name> [--admin agent1]

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
        log.error("usage: tsx src/scripts/ops/distribute-channels.ts --file <path> --persona <name> [--admin agent1]");
        process.exit(1);
    }

    const targets = resolvePersonaTargets(persona, adminAgentId);
    if (targets.length === 0) {
        log.error(`[distribute-channels] в персоне «${persona}» нет активных агентов — распределять некому`);
        process.exit(1);
    }

    const rows: CsvRow[] = fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((rawLink) => ({ rawLink, metrics: {} }));

    log.info(`[distribute-channels] каналов на входе: ${rows.length}, персона: ${persona}, активных агентов: ${targets.length}`);

    const result = runDistribution(rows, persona, targets, log, adminAgentId);
    log.info(
        `[distribute-channels] готово: added=${result.counts.added} skipped=${result.counts.skipped} ` +
            `error=${result.counts.error} byAgent=${JSON.stringify(result.byAgent)}`,
    );
}

main();
