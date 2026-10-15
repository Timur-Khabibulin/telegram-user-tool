// features/persona-account-reserve/activate.ts — общая финализация активации аккаунта
// резерва и драйвер ручной активации (триггер 2) persona-account-reserve §6/§8.
//
// Активация НЕ создаёт канал, НЕ применяет персону и НЕ проставляет инвайт-ссылку —
// всё это уже готово в резерве с момента провиженинга (R13). Финализация лишь
// перекеивает запись реестра инвайт-ссылок на финальный agentId (без Telegram, §6.4),
// включает прогрев, наполняет join-queue и сеет отложенные переходы жизненного цикла.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Logger } from "../../core/logger";
import { workspaceDir, FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { validatePoolAccount, quarantinePoolAccount } from "../../core/pool-accounts";
import { rekeyPrivateInviteLink } from "../../core/db/private-invites";
import { listAgentAssignmentLinks } from "../../core/db/discovery";
import { addJoinQueue } from "../../core/db/join-queue";
import { seedTransitions } from "../../core/db/lifecycle-transitions";
import { createOrUpdateTask } from "../../core/scheduler-control";

const DAY_SEC = 86400;

/**
 * Финализация активации (выделена из banned-account-replacement/activateAndFinalize,
 * шаги 3–4, БЕЗ применения персоны и БЕЗ снятия banned). Вызывается обоими триггерами:
 *
 * - перекей инвайт-записи reserveId → agentId (без Telegram, §6.4). Реестр ведётся под
 *   FUNNEL_ADMIN_AGENT_ID (как в provision/apply-persona), независимо от adminAgentId
 *   lifecycle-БД (на практике это тот же agent1);
 * - account-warmup on + подъём heartbeat-таймера агента (первая активная задача, R14);
 * - наполнение join-queue из реестра назначений (у свежего agent<N> триггера 2 назначений
 *   обычно нет — очередь пуста);
 * - посев отложенных переходов: start_join_queue (+1 д), enable_monitor_v5 и disable_warmup (+3 д).
 */
export async function finalizeActivation(
    agentId: string,
    reserveId: string,
    adminAgentId: string,
    log: Logger,
): Promise<void> {
    // Перекей инвайт-записи reserveId → agentId (перезаписывает возможную прежнюю запись agentId).
    rekeyPrivateInviteLink(FUNNEL_ADMIN_AGENT_ID, reserveId, agentId);
    log.info(`[persona-account-reserve] ${agentId}: инвайт-запись перекеена с ${reserveId}`);

    // Прогрев on + подъём heartbeat-таймера (первая активная задача).
    await createOrUpdateTask({ agentId, type: "account-warmup" }, log);

    // Наполнение join-queue из реестра назначений.
    const links = listAgentAssignmentLinks(adminAgentId, agentId);
    if (links.length > 0) {
        const res = addJoinQueue(agentId, links, log);
        log.info(`[persona-account-reserve] ${agentId}: join-queue наполнена — added=${res.added} skipped=${res.skipped}`);
    } else {
        log.info(`[persona-account-reserve] ${agentId}: за агентом нет закреплённых каналов — join-queue пуста`);
    }

    // Отложенные переходы жизненного цикла.
    const now = Math.floor(Date.now() / 1000);
    seedTransitions(adminAgentId, agentId, [
        { action: "start_join_queue", runAt: now + DAY_SEC },
        { action: "enable_monitor_v5", runAt: now + 3 * DAY_SEC },
        { action: "disable_warmup", runAt: now + 3 * DAY_SEC },
    ]);
    log.info(`[persona-account-reserve] ${agentId}: финализация завершена — прогрев включён, переходы посеяны`);
}

// ─── Триггер 2 — ручная активация ─────────────────────────────────────────

function computeNextAgentNumber(): number {
    let max = 0;
    const root = path.join(os.homedir(), ".openclaw");
    try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const m = e.name.match(/^workspace-agent(\d+)(?:\..*)?$/);
            if (m && Number(m[1]) > max) max = Number(m[1]);
        }
    } catch { /* каталога ещё нет */ }
    return max + 1;
}

/**
 * Атомарно забирает аккаунт резерва под нового агента одним rename в
 * workspace-agent<N>.incoming (калька claimPoolToNewAgent из persona-deploy, но источник —
 * каталог резерва). N ищется от computeNextAgentNumber() вверх, инкремент при занятости.
 * ENOENT источника → аккаунт резерва уже забран/активируется (конкурентная активация).
 * Возвращает { agentId } или "gone".
 */
function claimReserveToNewAgent(reserveId: string): { agentId: string } | "gone" {
    let n = computeNextAgentNumber();
    for (let guard = 0; guard < 100000; guard++, n++) {
        const agentId = `agent${n}`;
        const incoming = `${workspaceDir(agentId)}.incoming`;
        try {
            fs.renameSync(workspaceDir(reserveId), incoming);
            return { agentId };
        } catch (err: any) {
            if (err?.code === "ENOENT") return "gone";
            if (err?.code === "ENOTEMPTY" || err?.code === "EEXIST" || err?.code === "EPERM") continue;
            throw err;
        }
    }
    throw new Error(`claimReserveToNewAgent: не удалось выделить номер агента для ${reserveId}`);
}

/** Переписывает accountId в tg-account.json транзиентного .incoming-каталога (persona/username остаются). */
function rewriteIncomingAccountId(agentId: string): void {
    const p = path.join(`${workspaceDir(agentId)}.incoming`, "tg-account.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    raw.accountId = agentId;
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), "utf-8");
}

export type ReserveActivateStatus = "done" | "account_invalid" | "skip" | "taken";

export interface ReserveActivateResult {
    reserveId: string;
    status: ReserveActivateStatus;
    /** Присвоенный agent<N> при done. */
    agentId?: string;
    error?: string;
}

/**
 * Ручная активация аккаунта резерва (триггер 2, R17/AC-6): валидация подключением →
 * атомарный claim в workspace-agent<N> → перепись accountId → промоушен → финализация.
 * Метка agent<N> присваивается именно здесь; канал/пост/персона не трогаются.
 */
export async function runReserveActivate(
    reserveId: string,
    adminAgentId: string,
    log: Logger,
): Promise<ReserveActivateResult> {
    // Валидация (R19): непригодный → карантин, стоп; временная ошибка → повторить позже, стоп.
    const verdict = await validatePoolAccount(reserveId, log);
    if (verdict === "invalid") {
        quarantinePoolAccount(reserveId);
        log.warn(`[persona-account-reserve] ${reserveId}: непригоден → карантин, активация отменена`);
        return { reserveId, status: "account_invalid" };
    }
    if (verdict === "skip") {
        log.warn(`[persona-account-reserve] ${reserveId}: временно недоступен (прокси/сеть) — повторить позже`);
        return { reserveId, status: "skip" };
    }

    // Claim (R15): атомарный rename в workspace-agent<N>.incoming.
    const claim = claimReserveToNewAgent(reserveId);
    if (claim === "gone") {
        log.warn(`[persona-account-reserve] ${reserveId}: исчез при заборе — уже активируется/забран`);
        return { reserveId, status: "taken" };
    }
    const { agentId } = claim;

    // Перепись конфигурации + промоушен (аккаунт становится видимым listAgentIds).
    rewriteIncomingAccountId(agentId);
    fs.renameSync(`${workspaceDir(agentId)}.incoming`, workspaceDir(agentId));
    log.info(`[persona-account-reserve] ${reserveId}: активирован как ${agentId}`);

    // Финализация (прогрев/переходы/перекей инвайт-записи).
    await finalizeActivation(agentId, reserveId, adminAgentId, log);
    return { reserveId, status: "done", agentId };
}

/** Терминальный статус ручной активации одной строкой — для лога и Saved Messages. */
export function renderActivateResult(result: ReserveActivateResult): string {
    const head = "tg-agent-reserve-activate";
    switch (result.status) {
        case "done":
            return `${head} — ${result.reserveId}: done → ${result.agentId} (прогрев включён)`;
        case "account_invalid":
            return `${head} — ${result.reserveId}: account_invalid — непригоден, уведён в карантин`;
        case "skip":
            return `${head} — ${result.reserveId}: skip — временно недоступен (прокси/сеть), повторить позже`;
        case "taken":
            return `${head} — ${result.reserveId}: taken — уже активируется/забран другим процессом`;
    }
}
