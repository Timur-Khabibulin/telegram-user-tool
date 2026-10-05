// features/tg-agent-persona-deploy/run.ts — фаза 2 (потребитель пула). По входу
// «персона + M» берёт M старейших пригодных обезличенных пул-аккаунтов и через ИХ
// агентскую сессию применяет персону (username/профиль/фото/публичный канал + инвайт
// в общий приватный канал воронки), переводя каждый в workspace-agent<N>.
//
// Промоушен последним: аккаунт живёт в невидимом workspace-agent<N>.incoming во время
// применения персоны, и становится видимым (rename → workspace-agent<N>) только на
// успехе. Параллельные прогоны безопасны: claim пула и claim номера N — атомарные rename.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Logger } from "../../core/logger";
import { workspaceDir, accountConfigPath, REPORT_AGENT_ID } from "../../core/config";
import { TelegramService } from "../../core/telegram/service";
import {
    listPoolAccountsOldestFirst,
    validatePoolAccount,
    quarantinePoolAccount,
    generateUsername,
} from "../../core/pool-accounts";
import { applyPersonaToAccount } from "../persona-apply/apply-persona";
import { loadPersonaTemplate, PersonaTemplateError } from "../tg-agent-autoregistration/persona-template";

// Пауза между аккаунтами пачки (human-pacing, уровень B): разносит создание агентов
// во времени, чтобы N публичных каналов/username одной персоны не возникали залпом из
// одного прокси-кластера — это паттерн массовой регистрации, который ловит антиспам
// Telegram (USER_RESTRICTED). Значения — именованные константы для тюнинга.
const ACCOUNT_GAP_MIN_SEC = 90;
const ACCOUNT_GAP_MAX_SEC = 240;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function humanAccountDelay(): Promise<void> {
    return sleep((ACCOUNT_GAP_MIN_SEC + Math.random() * (ACCOUNT_GAP_MAX_SEC - ACCOUNT_GAP_MIN_SEC)) * 1000);
}

export interface PersonaDeployParams {
    personName: string;
    /** Сколько агентов требуется (M). */
    count: number;
}

export type DeployStatus = "done" | "setup_failed" | "account_invalid";

export interface DeployResult {
    /** Для done/setup_failed — agent<N>; для account_invalid — исходный emptyAccount<K>. */
    id: string;
    status: DeployStatus;
    error?: string;
}

export interface PersonaDeployReport {
    results: DeployResult[];
    requested: number;
    created: number;
    poolExhausted: boolean;
    abortReason?: string;
}

/** Следующий номер агента = (максимальный присутствующий workspace-agent<N>, включая
 *  .incoming/.old) + 1. Сканирует сырые имена, чтобы не столкнуться с транзиентными. */
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
 * Атомарно забирает пул-аккаунт под нового агента одним rename в
 * workspace-agent<N>.incoming: claim пула И claim номера N сразу. N ищется от
 * computeNextAgentNumber() вверх, инкремент при занятости номера (EEXIST/ENOTEMPTY/
 * EPERM). ENOENT src → пул-аккаунт уже забрал другой потребитель.
 * Возвращает { agentId } или "pool_gone".
 */
function claimPoolToNewAgent(poolId: string): { agentId: string } | "pool_gone" {
    let n = computeNextAgentNumber();
    // Верхняя граница на всякий случай — не крутить бесконечно при системной ошибке.
    for (let guard = 0; guard < 100000; guard++, n++) {
        const agentId = `agent${n}`;
        const incoming = `${workspaceDir(agentId)}.incoming`;
        try {
            fs.renameSync(workspaceDir(poolId), incoming);
            return { agentId };
        } catch (err: any) {
            if (err?.code === "ENOENT") return "pool_gone";
            if (err?.code === "ENOTEMPTY" || err?.code === "EEXIST" || err?.code === "EPERM") continue;
            throw err;
        }
    }
    throw new Error(`claimPoolToNewAgent: не удалось выделить номер агента для ${poolId}`);
}

/** Записывает persona/username/accountId в tg-account.json транзиентного .incoming-каталога. */
function writeIncomingConfig(agentId: string, persona: string, username: string): void {
    const p = path.join(`${workspaceDir(agentId)}.incoming`, "tg-account.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    raw.accountId = agentId;
    raw.persona = persona;
    raw.username = username;
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), "utf-8");
}

export async function runPersonaDeploy(params: PersonaDeployParams, log: Logger): Promise<PersonaDeployReport> {
    const { personName, count } = params;

    // Pre-flight: шаблон персоны полон (канал создаётся — requireChannel=true).
    let nickPrefix: string;
    try {
        nickPrefix = loadPersonaTemplate(personName, true).profileData.nick;
    } catch (err: any) {
        if (err instanceof PersonaTemplateError) {
            log.error(`[tg-agent-persona-deploy] ${err.message}`);
            return { results: [], requested: count, created: 0, poolExhausted: false, abortReason: err.message };
        }
        throw err;
    }
    if (!Number.isFinite(count) || count <= 0) {
        return { results: [], requested: count, created: 0, poolExhausted: false, abortReason: "count должен быть положительным" };
    }

    const results: DeployResult[] = [];
    let created = 0;
    let poolExhausted = false;
    // Уровень B: пауза ставится перед каждым аккаунтом, кроме первого обрабатываемого.
    let processedAny = false;

    // Единое соединение agent27 (REPORT_AGENT_ID) на весь батч: инвайт-ссылки всех
    // агентов генерируются от него, переподключать на каждого не нужно. Соединение
    // ленивое (первый exportChatInvite), закрывается в finally по завершении прогона.
    const inviteService = new TelegramService(log);
    inviteService.loadAccount(REPORT_AGENT_ID);

    // Снапшот пула (старейшие первыми); атомарный claim ниже страхует от гонок.
    const candidates = listPoolAccountsOldestFirst();
    let idx = 0;

    try {
    for (let produced = 0; produced < count; produced++) {
        // Найти следующий валидный кандидат, фиксируя невалидные (account_invalid).
        let poolId: string | null = null;
        while (idx < candidates.length) {
            const cand = candidates[idx++];
            const verdict = await validatePoolAccount(cand, log);
            if (verdict === "ok") { poolId = cand; break; }
            if (verdict === "invalid") {
                quarantinePoolAccount(cand);
                results.push({ id: cand, status: "account_invalid" });
                log.warn(`[tg-agent-persona-deploy] пул-аккаунт ${cand} невалиден → карантин`);
            }
            // "skip" (сеть/прокси) — оставляем в пуле, пробуем следующий
        }
        if (!poolId) { poolExhausted = true; break; }

        // Атомарный claim пула + номера N.
        const claim = claimPoolToNewAgent(poolId);
        if (claim === "pool_gone") { produced--; continue; } // забрал другой потребитель — тот же слот, следующий кандидат
        const { agentId } = claim;

        // Уровень B (human-pacing): разнести применение персоны между аккаунтами пачки.
        if (processedAny) {
            log.info(`[tg-agent-persona-deploy] пауза между аккаунтами (human-pacing) перед ${agentId}`);
            await humanAccountDelay();
        }
        processedAny = true;

        const username = generateUsername(nickPrefix);
        writeIncomingConfig(agentId, personName, username);

        try {
            // connectId = agent<N>.incoming (промоушен последним), agentId — логический.
            await applyPersonaToAccount(`${agentId}.incoming`, agentId, personName, username, log, inviteService);
            // Успех → атомарный промоушен .incoming → workspace-agent<N>.
            fs.renameSync(`${workspaceDir(agentId)}.incoming`, workspaceDir(agentId));
            results.push({ id: agentId, status: "done" });
            created++;
            log.info(`[tg-agent-persona-deploy] ${agentId}: персона применена, агент создан`);
        } catch (err: any) {
            // Аккаунт остаётся в невидимом .incoming — не подхватывается рабочим контуром.
            log.error(`[tg-agent-persona-deploy] ${agentId}: применение персоны не удалось — ${err?.message ?? err}`);
            results.push({ id: agentId, status: "setup_failed", error: err?.message ?? String(err) });
        }
    }
    } finally {
        await inviteService.disconnectAgent(REPORT_AGENT_ID).catch(() => {});
    }

    return { results, requested: count, created, poolExhausted };
}

/** Итоговый отчёт (включая строку «запрошено/создано/нехватка», ADR 0008 — в Saved Messages). */
export function renderReport(report: PersonaDeployReport): string {
    if (report.abortReason) {
        return `tg-agent-persona-deploy — прогон не начат: ${report.abortReason}`;
    }
    const invalid = report.results.filter((r) => r.status === "account_invalid").length;
    const shortfall = report.created < report.requested
        ? `; нехватка: создано ${report.created} из ${report.requested}` +
          (report.poolExhausted ? " (пул исчерпан)" : "") +
          (invalid > 0 ? `, ${invalid} невалидны` : "")
        : "";
    const lines = report.results.map((r) => `  ${r.id}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
    const summary = report.results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
    }, {});
    return [
        `tg-agent-persona-deploy — запрошено ${report.requested}, создано ${report.created}${shortfall}`,
        `Summary: ${JSON.stringify(summary)}`,
        ...lines,
    ].join("\n");
}
