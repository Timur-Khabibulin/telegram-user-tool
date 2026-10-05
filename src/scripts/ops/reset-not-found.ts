// scripts/ops/reset-not-found.ts — разовый операторский сброс статуса not_found
// у всех агентов, чтобы каналы перепроверились.
//
// Что делает: для каждого агента находит каналы с `status='not_found'` (и/или
// `membership='not_found'`) и возвращает их в активное состояние:
//   status → NULL (+ statusUpdatedAt/statusDurationSeconds/status_description → NULL),
//   membership → 'member' (+ membership_updated_at = now),
//   chat_access_hash_updated_at → NULL — форсит полный проход диалогов
//     (hasStaleAccessHashes), который переклассифицирует канал по диалогам:
//     реально потерянный снова станет not_found (syncChannels/CHANNEL_PRIVATE),
//     залипший (агент снова участник) останется рабочим.
//
// Обратимо и самокорректируемо: система сама вернёт not_found тем, кого агент
// действительно потерял. Колонки membership/chat_access_hash_updated_at есть не у
// всех БД (миграция раскатывается по агентам) — трогаем их только если существуют.
//
// Идемпотентно (повторный запуск просто не найдёт not_found). Печатает сброшенные
// chatId по агентам — это аудит-след операции.
//
// Запуск:
//   tsx reset-not-found.ts [--agents agent1,agent2,...] [--dry-run]

import * as fs from "fs";
import Database from "better-sqlite3";

import type { Logger } from "../../core/logger";
import { channelsDbPath, listAgentIds } from "../../core/config";

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

function hasColumn(db: Database.Database, col: string): boolean {
    return (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).some((c) => c.name === col);
}

function main(): void {
    const argv = process.argv.slice(2);
    const agentsArg = parseArg(argv, "--agents");
    const dryRun = argv.includes("--dry-run");
    const now = Math.floor(Date.now() / 1000);

    const agentIds = agentsArg
        ? agentsArg.split(",").map((s) => s.trim()).filter(Boolean)
        : listAgentIds();

    let totalReset = 0, agentsAffected = 0;
    for (const agentId of agentIds) {
        const dbPath = channelsDbPath(agentId);
        if (!fs.existsSync(dbPath)) continue;
        const db = new Database(dbPath);
        try {
            const hasMembership = hasColumn(db, "membership");
            const hasHashTs = hasColumn(db, "chat_access_hash_updated_at");
            const where = hasMembership
                ? `status = 'not_found' OR membership = 'not_found'`
                : `status = 'not_found'`;
            const rows = db.prepare(`SELECT chatId FROM channels WHERE ${where}`).all() as { chatId: string }[];
            if (rows.length === 0) continue;

            if (!dryRun) {
                const sets = [
                    `status = NULL`, `statusUpdatedAt = NULL`, `statusDurationSeconds = NULL`, `status_description = NULL`,
                ];
                if (hasMembership) sets.push(`membership = 'member'`, `membership_updated_at = ${now}`);
                if (hasHashTs) sets.push(`chat_access_hash_updated_at = NULL`);
                db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE ${where}`).run();
            }
            log.info(`${agentId}: ${dryRun ? "нашёл" : "сброшено"} ${rows.length} — ${rows.map((r) => r.chatId).join(",")}`);
            totalReset += rows.length;
            agentsAffected += 1;
        } catch (err: any) {
            log.warn(`${agentId}: ошибка — ${err?.message ?? err}`);
        } finally {
            db.close();
        }
    }

    log.info("");
    log.info(`=== Итог: ${dryRun ? "найдено" : "сброшено"} ${totalReset} not_found у ${agentsAffected} агентов (всего агентов ${agentIds.length}) ===`);
}

main();
