// scripts/join-queue-backfill.ts — разовый ручной бэкфилл join_queue после деплоя
// flood-wait-detection.
//
// Сбрасывает status='skipped' → 'pending' (attempts=0) по всем агентам — накопленные
// до фикса ссылки проходят повторную обработку через уже исправленную flood-детекцию
// вместо того, чтобы оставаться помеченными пропущенными навсегда. Часть ссылок
// корректно осядет обратно в skipped (настоящая постоянная причина), часть станет
// joined, часть может застрять в error — см. openspec/changes/flood-wait-detection/
// design.md, Migration Plan.
//
// ВАЖНО: запускать ТОЛЬКО после деплоя кода фикса (core/telegram/errors.ts,
// service.ts, skills/util.ts, skills/join-queue.ts) — иначе ссылки повторно попадут
// под старую, ещё сломанную классификацию и снова осядут в skipped без пользы.
//
// Пакетами по агентам с паузой между пакетами, не одним проходом по всем сразу — сам
// всплеск ResolveUsername/GetFullChannel-вызовов у каждого агента способен
// спровоцировать новые флуд-ограничения (design.md, Decisions).
//
// Запуск: tsx src/scripts/join-queue-backfill.ts [--batch-size 10] [--delay-seconds 300]

import type { Logger } from "../core/logger";
import { listAgentIds } from "../core/config";
import { resetSkippedToPending, joinQueueStats } from "../core/db/join-queue";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const batchSize = Number(parseArg(argv, "--batch-size") ?? 10);
    const delaySeconds = Number(parseArg(argv, "--delay-seconds") ?? 300);

    if (!Number.isFinite(batchSize) || batchSize <= 0 || !Number.isFinite(delaySeconds) || delaySeconds < 0) {
        log.error("usage: tsx src/scripts/join-queue-backfill.ts [--batch-size 10] [--delay-seconds 300]");
        process.exit(1);
    }

    const agents = listAgentIds();
    const batches = chunk(agents, batchSize);
    log.info(
        `[join-queue-backfill] агентов: ${agents.length}, батчей: ${batches.length} (по ${batchSize}, пауза между батчами ${delaySeconds}с)`,
    );

    let totalReset = 0;
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        log.info(`[join-queue-backfill] батч ${i + 1}/${batches.length}: ${batch.join(", ")}`);

        for (const agentId of batch) {
            const before = joinQueueStats(agentId, log);
            const { reset } = resetSkippedToPending(agentId, log);
            totalReset += reset;
            log.info(`[join-queue-backfill] ${agentId}: было skipped=${before.skipped ?? 0} — сброшено в pending: ${reset}`);
        }

        if (i < batches.length - 1) {
            log.info(`[join-queue-backfill] пауза ${delaySeconds}с перед следующим батчем...`);
            await sleep(delaySeconds * 1000);
        }
    }

    log.info(`[join-queue-backfill] готово — всего сброшено ${totalReset} строк по ${agents.length} агентам`);
}

main().catch((err) => {
    log.error(`[join-queue-backfill] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
