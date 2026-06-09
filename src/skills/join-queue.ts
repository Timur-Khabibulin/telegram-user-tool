// skills/join-queue.ts — runJoinQueue (портирование skills/join-queue-run/SKILL.md).
//
// Конечная задача (R-A3): обрабатывает один батч очереди вступления. Когда
// очередь исчерпана, возвращает терминальный статус — диспетчер выставляет
// enabled = 0 (architecture §3.4). Прежний механизм самоудаления через
// CronList/CronDelete заменён терминальным статусом — это и есть миграция.

import type { SkillContext, SkillStatus } from "./types";
import { getJoinQueueBatch, updateJoinQueue } from "../core/db/join-queue";

const BATCH_LIMIT = 15;

export async function runJoinQueue(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, tg, log } = ctx;

    // Шаг 1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // Шаг 2 — Взять батч из очереди
    const { links } = getJoinQueueBatch(agentId, log, BATCH_LIMIT);

    // Пустой батч → очередь исчерпана (R-A3): терминальный статус.
    if (links.length === 0) {
        log.info("[join-queue] queue exhausted — returning terminal status");
        return { status: "success", terminal: true, details: { reason: "queue_exhausted" } };
    }

    // Шаг 3 — Обработать батч целиком (инструмент сам делает паузы и FLOOD_WAIT-ретраи)
    const summary = await tg.joinDiscussionGroups(links);

    // 3.1 — Обновить статусы по results
    for (const result of summary.results) {
        if (result.status === "joined") {
            updateJoinQueue(agentId, result.link, "joined", undefined, log);
        } else {
            const reason = result.reason ?? "";
            if (reason.includes("FLOOD_WAIT")) {
                updateJoinQueue(agentId, result.link, "error", reason, log);
            } else {
                updateJoinQueue(agentId, result.link, "skipped", undefined, log);
            }
        }
    }

    // 3.2 — При FLOOD_WAIT завершить прогон (следующий батч — на следующем запуске)
    return {
        status: "success",
        details: {
            claimed: links.length,
            joined: summary.joined,
            skipped: summary.skipped,
            hadFloodWait: summary.hadFloodWait,
            floodWaits: summary.floodWaits,
        },
    };
}
