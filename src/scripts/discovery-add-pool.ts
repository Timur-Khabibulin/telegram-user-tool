// scripts/discovery-add-pool.ts — разовое ручное добавление списка каналов в пул
// реестра discovery (assigned_agent = NULL), откуда их потом заберёт
// distribute-pool.ts. Источник — файл с одной канонической ссылкой на строку.
//
// Запуск: tsx src/scripts/discovery-add-pool.ts --file <path> [--admin agent1]

import * as fs from "fs";
import { FUNNEL_ADMIN_AGENT_ID } from "../core/config";
import { normalizeChannelLink, registerChannel } from "../core/db/discovery";

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

    if (!filePath) {
        console.error("usage: tsx src/scripts/discovery-add-pool.ts --file <path> [--admin agent1]");
        process.exit(1);
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let inserted = 0;
    let alreadyKnown = 0;
    for (const raw of lines) {
        const canonical = normalizeChannelLink(raw);
        const { inserted: isNew } = registerChannel(adminAgentId, canonical);
        if (isNew) inserted += 1;
        else alreadyKnown += 1;
    }

    console.log(`[discovery-add-pool] total=${lines.length} inserted=${inserted} alreadyKnown=${alreadyKnown}`);
}

main();