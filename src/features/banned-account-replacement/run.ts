// features/banned-account-replacement/run.ts — суточный кросс-агентный sweep
// авто-замены забаненных аккаунтов из пула пустых (banned-account-replacement).
//
// Прогон совмещает две фазы (architecture §3.1.1): (1) исполнение назревших
// отложенных переходов жизненного цикла; (2) замена всем агентам с активным
// ограничением `banned` (включая заморозку). Последовательно, с per-agent
// изоляцией сбоёв — как agent-reauth-sweep. Файловая часть подмены — в swap.ts.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Logger } from "../../core/logger";
import {
    REPORT_AGENT_ID,
    listPoolAccountIds,
    loadAccountConfig,
    accountConfigPath,
} from "../../core/config";
import { listPoolAccountsOldestFirst, quarantinePoolAccount, generateUsername } from "../../core/pool-accounts";
import { applyPersonaToAccount } from "../persona-apply/apply-persona";
import { listActiveByType, clearRestriction } from "../../core/db/agent-restrictions";
import {
    listDueTransitions,
    markTransitionDone,
    seedTransitions,
    type LifecycleAction,
} from "../../core/db/lifecycle-transitions";
import { listAgentAssignmentLinks } from "../../core/db/discovery";
import { addJoinQueue } from "../../core/db/join-queue";
import { createOrUpdateTask, removeTask } from "../../core/scheduler-control";
import { TelegramService } from "../../core/telegram/service";
import { classifyAccountError } from "../../core/telegram/errors";
import { loadPersonaTemplate } from "../tg-agent-autoregistration/persona-template";
import {
    buildIncoming,
    claimPoolAccount,
    clearMarker,
    commitSwap,
    readMarker,
    recoverAnchors,
} from "./swap";

const DAY_SEC = 86400;

/** Durable-флаг «пул пуст, оператор оповещён» (M6) — файл в ~/.openclaw/banned-replacement. */
function alertFlagPath(): string {
    return path.join(os.homedir(), ".openclaw", "banned-replacement", "pool-empty-alerted");
}

/** Записывает сгенерированный username в tg-account.json агента (пул обезличен). */
function persistUsername(agentId: string, username: string): void {
    const p = accountConfigPath(agentId);
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    raw.username = username;
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), "utf-8");
}

export interface BannedReplacementSummary {
    /** Всего агентов с активным banned в выборке. */
    total: number;
    /** Успешно заменены (аккаунт подставлен, активирован, banned снят). */
    replaced: number;
    /** Пропущены из-за отсутствия пригодного пул-аккаунта (остались banned). */
    poolExhausted: number;
    /** Сбой замены (изолирован, агент остался banned). */
    failed: number;
    /** Исполнено назревших отложенных переходов. */
    transitionsApplied: number;
    /** Отправлен ли алерт «пул пуст» в этом прогоне. */
    poolEmptyAlerted: boolean;
}

export async function runBannedReplacementSweep(log: Logger, adminAgentId: string): Promise<BannedReplacementSummary> {
    const summary: BannedReplacementSummary = {
        total: 0, replaced: 0, poolExhausted: 0, failed: 0, transitionsApplied: 0, poolEmptyAlerted: false,
    };

    // ── Фаза 1: назревшие отложенные переходы жизненного цикла ──────────
    summary.transitionsApplied = await applyDueTransitions(adminAgentId, log);

    // ── Фаза 2: замена забаненных ───────────────────────────────────────
    const banned = listActiveByType(adminAgentId, "banned");
    summary.total = banned.length;
    log.info(`[banned-replacement] start — ${banned.length} agent(s) with banned`);

    // Пул непуст на старте → снять флаг алерта (пополнили — оповестить снова можно).
    if (listPoolAccountIds().length > 0) clearAlertFlag(log);

    let poolExhausted = false;
    for (const row of banned) {
        const agentId = row.agentId;
        try {
            const outcome = await replaceOne(agentId, adminAgentId, log);
            if (outcome === "replaced") summary.replaced++;
            else if (outcome === "pool_exhausted") {
                summary.poolExhausted++;
                poolExhausted = true;
            }
        } catch (err: any) {
            summary.failed++;
            log.error(`[banned-replacement] ${agentId}: замена не удалась (изолировано) — ${err?.message ?? err}`);
        }
    }

    // Алерт «пул пуст» — один раз, пока не пополнят (M5/M6).
    if (poolExhausted && !alertAlreadySent()) {
        await sendPoolEmptyAlert(log);
        setAlertFlag(log);
        summary.poolEmptyAlerted = true;
    }

    log.info(
        `[banned-replacement] done — total=${summary.total} replaced=${summary.replaced} ` +
            `pool_exhausted=${summary.poolExhausted} failed=${summary.failed} ` +
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
    // фазовый маркер — активация уже на подменённом аккаунте, без нового забора пула.
    recoverAnchors(agentId, log);
    if (readMarker(agentId)) {
        log.info(`[banned-replacement] ${agentId}: обнаружен незавершённый setup — доигрываю активацию без забора пула`);
        await activateAndFinalize(agentId, adminAgentId, log);
        return "replaced";
    }

    // Персона заменяемого агента читается ДО любой подмены (Модель B — сохраняем её).
    const persona = loadAccountConfig(agentId).persona;

    // Выбрать пригодный пул-аккаунт (невалидный → карантин, берём следующий).
    const poolId = await findValidPoolAccount(log);
    if (!poolId) {
        log.warn(`[banned-replacement] ${agentId}: нет пригодного пул-аккаунта — остаётся banned`);
        return "pool_exhausted";
    }

    // Claim (атомарный rename), сборка, swap.
    if (!claimPoolAccount(poolId, agentId, log)) {
        log.warn(`[banned-replacement] ${agentId}: пул-аккаунт ${poolId} исчез при заборе — пропуск, ретрай след. прогоном`);
        return "pool_exhausted";
    }
    buildIncoming(agentId, poolId, persona, log);
    commitSwap(agentId, log);

    // Активация под персону + финализация (снятие banned — последним).
    await activateAndFinalize(agentId, adminAgentId, log);
    return "replaced";
}

/**
 * Настройка нового аккаунта под персону (R8/M3), посев T0-расписания и отложенных
 * переходов (R9–R11), снятие маркера и ограничения `banned` (commit point, R7).
 * Идемпотентна: повтор после сбоя доигрывает без нового забора пула.
 */
async function activateAndFinalize(agentId: string, adminAgentId: string, log: Logger): Promise<void> {
    const cfg = loadAccountConfig(agentId);

    // Пул-аккаунт обезличен (без username) — username персоны генерируется здесь и
    // персистится в tg-account.json (идемпотентность: повтор активации переиспользует
    // уже записанный, не генерирует другой поверх применённого к Telegram-аккаунту).
    let username = cfg.username;
    if (!username) {
        const template = loadPersonaTemplate(cfg.persona, true);
        username = generateUsername(template.profileData.nick);
        persistUsername(agentId, username);
    }

    // 1–2. Применить персону сессией агента + инвайт-ссылка (общий шаг с фазой 2).
    // connectId == agentId: аккаунт уже в workspace-<agentId> после commitSwap.
    await applyPersonaToAccount(agentId, agentId, cfg.persona, username, log);

    // 3. T0-конфигурация: warmup on; join-queue наполнена из реестра (старт отложен).
    await createOrUpdateTask({ agentId, type: "account-warmup" }, log);
    const links = listAgentAssignmentLinks(adminAgentId, agentId);
    if (links.length > 0) {
        const res = addJoinQueue(agentId, links, log);
        log.info(`[banned-replacement] ${agentId}: join-queue наполнена — added=${res.added} skipped=${res.skipped}`);
    } else {
        log.info(`[banned-replacement] ${agentId}: за агентом нет закреплённых каналов — join-queue пуста`);
    }

    // 4. Отложенные переходы: старт join-queue T0+1д; monitor-v5 on + warmup off T0+3д.
    const now = Math.floor(Date.now() / 1000);
    seedTransitions(adminAgentId, agentId, [
        { action: "start_join_queue", runAt: now + DAY_SEC },
        { action: "enable_monitor_v5", runAt: now + 3 * DAY_SEC },
        { action: "disable_warmup", runAt: now + 3 * DAY_SEC },
    ]);

    // 5. Commit point: снять маркер, затем ограничение `banned` (последним — R7).
    clearMarker(agentId, log);
    clearRestriction(adminAgentId, agentId);
    log.info(`[banned-replacement] ${agentId}: замена завершена — banned снят, агент в прогреве`);
}

/**
 * Первый пригодный пул-аккаунт (подключение его сессией + getMe). Аккаунт с
 * аккаунтной ошибкой (banned/невалидная сессия) уводится в карантин (M2); прочие
 * ошибки (прокси/сеть) — пропуск без карантина (аккаунт останется в пуле на след. раз).
 */
async function findValidPoolAccount(log: Logger): Promise<string | null> {
    for (const poolId of listPoolAccountsOldestFirst()) {
        const tg = new TelegramService(log);
        try {
            tg.loadAccount(poolId, { pool: true });
            await tg.withActiveClient((client) => client.getMe());
            log.info(`[banned-replacement] пул-аккаунт ${poolId} валиден — берём`);
            return poolId;
        } catch (err: any) {
            const accountFailure = classifyAccountError(err);
            if (accountFailure) {
                log.warn(`[banned-replacement] пул-аккаунт ${poolId} непригоден (${accountFailure}) — карантин`);
                quarantinePoolAccount(poolId);
            } else {
                log.warn(`[banned-replacement] пул-аккаунт ${poolId}: ошибка подключения (${err?.message ?? err}) — пропуск, остаётся в пуле`);
            }
        } finally {
            await tg.disconnectAgent(poolId).catch(() => {});
        }
    }
    return null;
}

// ─── Алерт «пул пуст» с дедупликацией (M5/M6) ────────────────────────────

function alertAlreadySent(): boolean {
    return fs.existsSync(alertFlagPath());
}

function setAlertFlag(log: Logger): void {
    try {
        fs.mkdirSync(path.dirname(alertFlagPath()), { recursive: true });
        fs.writeFileSync(alertFlagPath(), String(Math.floor(Date.now() / 1000)), "utf-8");
    } catch (err: any) {
        log.warn(`[banned-replacement] не удалось поставить флаг алерта — ${err?.message ?? err}`);
    }
}

function clearAlertFlag(log: Logger): void {
    try {
        fs.rmSync(alertFlagPath(), { force: true });
    } catch (err: any) {
        log.warn(`[banned-replacement] не удалось снять флаг алерта — ${err?.message ?? err}`);
    }
}

async function sendPoolEmptyAlert(log: Logger): Promise<void> {
    const text =
        "⚠️ banned-account-replacement: пул пустых аккаунтов исчерпан — есть забаненные агенты, " +
        "заменить некем. Пополните пул (workspace-emptyAccount*). Оповещение не повторится до пополнения.";
    const tg = new TelegramService(log);
    try {
        tg.loadAccount(REPORT_AGENT_ID);
        await tg.sendSavedMessage(text);
        log.warn("[banned-replacement] отправлен алерт «пул пуст» в Saved Messages report-агента");
    } finally {
        await tg.disconnectAgent(REPORT_AGENT_ID).catch(() => {});
    }
}
