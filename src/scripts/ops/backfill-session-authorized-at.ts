// scripts/ops/backfill-session-authorized-at.ts — разовый бэкафилл
// AccountConfig.sessionAuthorizedAt для агентов, созданных до появления поля
// (monitor-v5-hash-driven-sync / tg-peer-identity-model).
//
// Зачем: свежесть access_hash оценивается по правилу
// `chat_access_hash_updated_at >= sessionAuthorizedAt` (core/db/channels
// accessHashFresh) и триггер полного прохода `hasStaleAccessHashes` — оба требуют,
// чтобы момент авторизации был задан. У legacy-конфигов поля нет → предикаты не
// определены (агент не сидирует хэши из БД / не форсирует проход). Проставляем
// `sessionAuthorizedAt = now`: на первом же прогоне все сохранённые хэши окажутся
// «старше авторизации» → один полный проход диалогов переполучит их под текущей
// сессией и проставит свежий `chat_access_hash_updated_at` (разовый thundering-herd,
// размазан диспетчером по агентам).
//
// Идемпотентен: агент с уже заданным `sessionAuthorizedAt` пропускается (если не
// передан --force). Чистая файловая операция, Telegram не трогается.
//
// Запуск:
//   tsx backfill-session-authorized-at.ts [--agents agent1,agent2,...] [--force]
// Без --agents — обходит всех агентов (listAgentIds()).

import * as fs from "fs";

import type { Logger } from "../../core/logger";
import { accountConfigPath, listAgentIds } from "../../core/config";

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
    const agentsArg = parseArg(argv, "--agents");
    const force = argv.includes("--force");
    const now = Math.floor(Date.now() / 1000);

    const agentIds = agentsArg
        ? agentsArg.split(",").map((s) => s.trim()).filter(Boolean)
        : listAgentIds();

    let updated = 0, skipped = 0, errored = 0;
    for (const agentId of agentIds) {
        const filePath = accountConfigPath(agentId);
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (raw.sessionAuthorizedAt != null && !force) {
                skipped += 1;
                continue;
            }
            raw.sessionAuthorizedAt = now;
            fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf8");
            log.info(`[backfill-session-authorized-at] ${agentId} — sessionAuthorizedAt=${now}`);
            updated += 1;
        } catch (err: any) {
            log.warn(`[backfill-session-authorized-at] ${agentId} — ошибка: ${err?.message ?? err}`);
            errored += 1;
        }
    }

    log.info("");
    log.info(`=== Итог: updated=${updated} skipped=${skipped} errored=${errored} (всего ${agentIds.length}) ===`);
}

main();
