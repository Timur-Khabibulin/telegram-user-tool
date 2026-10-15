// features/banned-account-replacement/run.ts — суточный кросс-агентный sweep
// авто-замены забаненных аккаунтов из РЕЗЕРВА готовых аккаунтов персоны
// (persona-account-reserve §7). Источник замены — резерв той же персоны, что у
// забаненного агента (не обезличенный пул): аккаунт резерва уже полностью настроен
// (персона + публичный канал + инвайт-ссылка + агентская сессия), поэтому активация
// персону НЕ применяет и канал НЕ создаёт — только файловая подмена + финализация.
//
// Прогон совмещает две фазы (architecture §3.1.1): (1) исполнение назревших отложенных
// переходов жизненного цикла; (2) замена всем агентам с активным `banned`. Файловая
// часть подмены — в swap.ts (без изменений), общая финализация — в
// features/persona-account-reserve/activate.ts.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Logger } from "../../core/logger";
import { REPORT_AGENT_ID, loadAccountConfig } from "../../core/config";
import { findValidReserveAccount } from "../../core/reserve-accounts";
import { finalizeActivation } from "../persona-account-reserve/activate";
import { listActiveByType, clearRestriction } from "../../core/db/agent-restrictions";
import {
    listDueTransitions,
    markTransitionDone,
    type LifecycleAction,
} from "../../core/db/lifecycle-transitions";
import { createOrUpdateTask, removeTask } from "../../core/scheduler-control";
import { TelegramService } from "../../core/telegram/service";
import {
    buildIncoming,
    claimPoolAccount,
    clearMarker,
    commitSwap,
    readMarker,
    recoverAnchors,
} from "./swap";

/** Durable-флаг «резерв персоны пуст, оператор оповещён» (R20) — пер-персонный файл. */
function alertFlagPath(persona: string): string {
    return path.join(os.homedir(), ".openclaw", "banned-replacement", `reserve-empty-alerted-${persona}`);
}

export interface BannedReplacementSummary {
    /** Всего агентов с активным banned в выборке. */
    total: number;
    /** Успешно заменены (аккаунт резерва подставлен, активирован, banned снят). */
    replaced: number;
    /** Пропущены из-за отсутствия пригодного аккаунта резерва персоны (остались banned). */
    poolExhausted: number;
    /** Сбой замены (изолирован, агент остался banned). */
    failed: number;
    /** Исполнено назревших отложенных переходов. */
    transitionsApplied: number;
    /** Отправлен ли хотя бы один пер-персонный алерт «резерв пуст» в этом прогоне. */
    poolEmptyAlerted: boolean;
}

export async function runBannedReplacementSweep(log: Logger, adminAgentId: string): Promise<BannedReplacementSummary> {
    const summary: BannedReplacementSummary = {
        total: 0, replaced: 0, poolExhausted: 0, failed: 0, transitionsApplied: 0, poolEmptyAlerted: false,
    };

    // ── Фаза 1: назревшие отложенные переходы жизненного цикла ──────────
    summary.transitionsApplied = await applyDueTransitions(adminAgentId, log);

    // ── Фаза 2: замена забаненных из резерва персоны ────────────────────
    const banned = listActiveByType(adminAgentId, "banned");
    summary.total = banned.length;
    log.info(`[banned-replacement] start — ${banned.length} agent(s) with banned`);

    // Персоны, чей резерв оказался пуст в этом прогоне (для пер-персонного алерта R20).
    const exhaustedPersonas = new Set<string>();

    for (const row of banned) {
        const agentId = row.agentId;
        // Персона читается до замены (нужна для пер-персонного флага алерта и сброса).
        let persona: string | undefined;
        try {
            persona = loadAccountConfig(agentId).persona;
        } catch (err: any) {
            log.warn(`[banned-replacement] ${agentId}: не удалось прочитать персону — ${err?.message ?? err}`);
        }
        try {
            const outcome = await replaceOne(agentId, adminAgentId, log);
            if (outcome === "replaced") {
                summary.replaced++;
                // Резерв персоны оказался непуст (аккаунт нашёлся) — сброс флага алерта (R20).
                if (persona) clearAlertFlag(persona, log);
            } else {
                summary.poolExhausted++;
                if (persona) exhaustedPersonas.add(persona);
            }
        } catch (err: any) {
            summary.failed++;
            log.error(`[banned-replacement] ${agentId}: замена не удалась (изолировано) — ${err?.message ?? err}`);
        }
    }

    // Пер-персонный алерт «резерв пуст» — один раз на персону, пока резерв не пополнят (R20).
    for (const persona of exhaustedPersonas) {
        if (!alertAlreadySent(persona)) {
            await sendReserveEmptyAlert(persona, log);
            setAlertFlag(persona, log);
            summary.poolEmptyAlerted = true;
        }
    }

    log.info(
        `[banned-replacement] done — total=${summary.total} replaced=${summary.replaced} ` +
            `reserve_exhausted=${summary.poolExhausted} failed=${summary.failed} ` +
            `transitions=${summary.transitionsApplied} alert=${summary.poolEmptyAlerted}`,
    );
    return summary;
}

// ─── Фаза 1: отложенные переходы ─────────────────────────────────────────

async function applyDueTransitions(adminAgentId: string, log: Logger): Promise<number> {
    const due = listDueTransitions(adminAgentId, Math.floor(Date.now() / 1000));
    let applied = 0;
    for (const t of due) {
        try {
            await applyTransition(t.agentId, t.action, log);
            markTransitionDone(adminAgentId, t.id);
            applied++;
            log.info(`[banned-replacement] переход исполнен — ${t.agentId}: ${t.action}`);
        } catch (err: any) {
            log.error(`[banned-replacement] переход ${t.action} для ${t.agentId} не удался (изолировано) — ${err?.message ?? err}`);
        }
    }
    return applied;
}

async function applyTransition(agentId: string, action: LifecycleAction, log: Logger): Promise<void> {
    switch (action) {
        case "start_join_queue":
            await createOrUpdateTask({ agentId, type: "join-queue" }, log);
            break;
        case "enable_monitor_v5":
            await createOrUpdateTask({ agentId, type: "monitor-v5" }, log);
            break;
        case "disable_warmup":
            await removeTask({ agentId, type: "account-warmup" }, log);
            break;
    }
}

// ─── Фаза 2: замена одного агента ────────────────────────────────────────

type ReplaceOutcome = "replaced" | "pool_exhausted";

async function replaceOne(agentId: string, adminAgentId: string, log: Logger): Promise<ReplaceOutcome> {
    // Восстановление незавершённой замены: доиграть swap по якорям, затем — если есть
    // фазовый маркер — доиграть финализацию уже на подменённом аккаунте, без нового забора.
    recoverAnchors(agentId, log);
    const marker = readMarker(agentId);
    if (marker) {
        log.info(`[banned-replacement] ${agentId}: обнаружен незавершённый setup — доигрываю финализацию без забора резерва`);
        // marker.poolId — id аккаунта резерва (поле swap.ts не переименовано).
        await finalizeActivation(agentId, marker.poolId, adminAgentId, log);
        clearMarker(agentId, log);
        clearRestriction(adminAgentId, agentId);
        log.info(`[banned-replacement] ${agentId}: замена завершена (резюмирование) — banned снят`);
        return "replaced";
    }

    // Персона заменяемого агента читается ДО любой подмены (Модель B — сохраняем её).
    const persona = loadAccountConfig(agentId).persona;

    // Взять пригодный аккаунт резерва ТОЙ ЖЕ персоны; при гонке на заборе — добрать следующий (R16).
    while (true) {
        const reserveId = await findValidReserveAccount(persona, log);
        if (!reserveId) {
            log.warn(`[banned-replacement] ${agentId}: в резерве нет пригодного аккаунта персоны ${persona} — остаётся banned`);
            return "pool_exhausted";
        }
        // Claim (атомарный rename). ENOENT → другой процесс забрал — добрать следующий пригодный.
        if (!claimPoolAccount(reserveId, agentId, log)) {
            log.warn(`[banned-replacement] ${agentId}: аккаунт резерва ${reserveId} исчез при заборе — добираю следующий`);
            continue;
        }

        // Файловая подмена. username аккаунта резерва НЕ регенерируется — он соответствует
        // уже созданному публичному каналу (buildIncoming username не перезаписывает, §7.5).
        buildIncoming(agentId, reserveId, persona, log);
        commitSwap(agentId, log);

        // Финализация (перекей инвайт-записи reserveId → agentId, прогрев, переходы) —
        // БЕЗ применения персоны и создания канала (аккаунт резерва уже настроен, R13).
        await finalizeActivation(agentId, reserveId, adminAgentId, log);

        // Commit point: снять маркер, затем ограничение `banned` (последним — R7 замены).
        clearMarker(agentId, log);
        clearRestriction(adminAgentId, agentId);
        log.info(`[banned-replacement] ${agentId}: замена завершена — banned снят, агент в прогреве`);
        return "replaced";
    }
}

// ─── Пер-персонный алерт «резерв пуст» с дедупликацией (R20) ──────────────

function alertAlreadySent(persona: string): boolean {
    return fs.existsSync(alertFlagPath(persona));
}

function setAlertFlag(persona: string, log: Logger): void {
    try {
        fs.mkdirSync(path.dirname(alertFlagPath(persona)), { recursive: true });
        fs.writeFileSync(alertFlagPath(persona), String(Math.floor(Date.now() / 1000)), "utf-8");
    } catch (err: any) {
        log.warn(`[banned-replacement] не удалось поставить флаг алерта (${persona}) — ${err?.message ?? err}`);
    }
}

function clearAlertFlag(persona: string, log: Logger): void {
    try {
        fs.rmSync(alertFlagPath(persona), { force: true });
    } catch (err: any) {
        log.warn(`[banned-replacement] не удалось снять флаг алерта (${persona}) — ${err?.message ?? err}`);
    }
}

async function sendReserveEmptyAlert(persona: string, log: Logger): Promise<void> {
    const text =
        `⚠️ banned-account-replacement: в резерве нет готового аккаунта персоны ${persona} — ` +
        `есть забаненный агент этой персоны, заменить некем. Пополните резерв персоны ${persona} ` +
        `(tg-agent-reserve-provision). Оповещение не повторится до пополнения.`;
    const tg = new TelegramService(log);
    try {
        tg.loadAccount(REPORT_AGENT_ID);
        await tg.sendSavedMessage(text);
        log.warn(`[banned-replacement] отправлен алерт «резерв персоны ${persona} пуст» в Saved Messages report-агента`);
    } finally {
        await tg.disconnectAgent(REPORT_AGENT_ID).catch(() => {});
    }
}
