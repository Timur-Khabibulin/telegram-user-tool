// scripts/ops/backfill-schedule-defaults.ts — разовый backfill дефолтов расписания
// (predictable-agent-scheduling): join-queue 3ч → 4ч, leave-banned 05:00 → 01:00.
//
// computeDefaultSchedule() применяется только при upsert БЕЗ явного schedule —
// смена констант в tasks.ts сама по себе не трогает уже существующие строки
// tasks.db. Этот скрипт находит строки, чей schedule совпадает со СТАРЫМ
// дефолтом (join-queue — любой из 18 старых round-robin слотов при периоде
// 180 мин; leave-banned — ровно "0 5 * * *"), и пересчитывает их на новый
// дефолт через upsertTask. Строки, не совпавшие со старым дефолтом (значит —
// явно заданы пользователем), не трогает — логирует как пропущенные.
//
// Идемпотентно (повторный запуск на уже смигрированных строках — no-op, они
// больше не совпадают со старым дефолтом), но меняет данные — запускать
// осознанно, один раз.
//
// Запуск: tsx backfill-schedule-defaults.ts

import type { Logger } from "../../core/logger";
import { listAgentIds, DISPATCHER_TICK_MINUTES } from "../../core/config";
import { listTasks, upsertTask, computeDefaultSchedule, buildOffsetCron } from "../../core/db/tasks";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

// Старые дефолты (до этого change) — только для распознавания немигрированных строк.
const OLD_JOIN_QUEUE_PERIOD_MINUTES = 180;
const OLD_LEAVE_BANNED_SCHEDULE = "0 5 * * *";

const OLD_JOIN_QUEUE_SCHEDULES = new Set(
    Array.from({ length: OLD_JOIN_QUEUE_PERIOD_MINUTES / DISPATCHER_TICK_MINUTES }, (_, slot) =>
        buildOffsetCron(OLD_JOIN_QUEUE_PERIOD_MINUTES, DISPATCHER_TICK_MINUTES, slot),
    ),
);

function main(): void {
    const agents = listAgentIds();
    let migrated = 0;
    let skipped = 0;

    for (const agentId of agents) {
        for (const task of listTasks(agentId)) {
            if (task.type === "join-queue" && OLD_JOIN_QUEUE_SCHEDULES.has(task.schedule)) {
                const { schedule, tz } = computeDefaultSchedule("join-queue");
                upsertTask({ agentId, type: "join-queue", schedule, tz });
                log.info(`[backfill-schedule-defaults] ${agentId} join-queue: "${task.schedule}" -> "${schedule}"`);
                migrated += 1;
            } else if (task.type === "join-queue") {
                skipped += 1;
            }

            if (task.type === "leave-banned" && task.schedule === OLD_LEAVE_BANNED_SCHEDULE) {
                const { schedule, tz } = computeDefaultSchedule("leave-banned");
                upsertTask({ agentId, type: "leave-banned", schedule, tz });
                log.info(`[backfill-schedule-defaults] ${agentId} leave-banned: "${task.schedule}" -> "${schedule}"`);
                migrated += 1;
            } else if (task.type === "leave-banned") {
                skipped += 1;
            }
        }
    }

    log.info(`[backfill-schedule-defaults] done — migrated=${migrated} skipped(custom schedule)=${skipped}`);
}

main();
