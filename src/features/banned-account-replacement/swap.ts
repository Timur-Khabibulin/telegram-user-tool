// features/banned-account-replacement/swap.ts — файловая часть подмены аккаунта
// (banned-account-replacement, R2/R6/R7). Только файловая система и SQLite, без
// Telegram: claim пул-каталога, сборка нового содержимого workspace, атомарный swap
// и восстановление после сбоя по якорям `.incoming`/`.old` и фазовому маркеру.
//
// Инвариант безопасности: ограничение `banned` снимает вызывающий (run.ts) последним
// шагом, после успешной активации. Поэтому любой недобег здесь оставляет агента вне
// рабочего контура и безопасно доигрывается на следующем прогоне.

import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";

import type { Logger } from "../../core/logger";
import { workspaceDir } from "../../core/config";

/** Фазовый маркер в workspace: свидетельствует, что swap закоммичен, активация ещё нет. */
const PHASE_MARKER = "replacement.json";

/** Рабочие per-agent БД, которые при замене должны быть пустыми (пересоздаются лениво). */
const WORKING_DBS = [
    "tg-channels.db",
    "tg-replies.db",
    "dm-threads.db",
    "dm-history.db",
    "pending-reviews.db",
    "llm-log.db",
    "tg-join-queue.db",
];

export interface ReplacementMarker {
    phase: "activating";
    agentId: string;
    poolId: string;
    createdAt: number;
}

function incomingDir(agentId: string): string {
    return `${workspaceDir(agentId)}.incoming`;
}

function oldDir(agentId: string): string {
    return `${workspaceDir(agentId)}.old`;
}

function markerPath(agentId: string): string {
    return path.join(workspaceDir(agentId), PHASE_MARKER);
}

/**
 * Атомарно забирает пул-аккаунт под целевого агента: rename каталога пула в
 * `workspace-<agentId>.incoming`. rename в пределах одной ФС атомарен — при гонке
 * выигрывает ровно один претендент, второй получит ENOENT. Возвращает false, если
 * каталог уже забран/исчез (ENOENT) — вызывающий берёт следующий свободный.
 */
export function claimPoolAccount(poolId: string, agentId: string, log: Logger): boolean {
    const src = workspaceDir(poolId);
    const dst = incomingDir(agentId);
    try {
        fs.renameSync(src, dst);
        log.info(`[banned-replacement] claim ${poolId} → ${path.basename(dst)}`);
        return true;
    } catch (err: any) {
        if (err?.code === "ENOENT") return false;
        throw err;
    }
}

/** Переносит невалидный пул-аккаунт в карантин `workspace-emptyAccount<N>.invalid` (M2). */
export function quarantinePoolAccount(poolId: string, log: Logger): void {
    const src = workspaceDir(poolId);
    const dst = `${src}.invalid`;
    try {
        fs.renameSync(src, dst);
        log.warn(`[banned-replacement] пул-аккаунт ${poolId} невалиден → карантин ${path.basename(dst)}`);
    } catch (err: any) {
        if (err?.code === "ENOENT") return;
        throw err;
    }
}

/**
 * Собирает итоговое содержимое `.incoming` перед swap:
 * - переписывает `tg-account.json`: creds/username/proxy/device из пула, но
 *   `accountId=agentId` и `persona` — от заменяемого агента (Модель B);
 * - переносит `tasks.db` из старого workspace (в нём живут журналы runs/error_log —
 *   R7 их сохраняет) и очищает внутри только таблицу `tasks`;
 * - удаляет из `.incoming` любые рабочие БД (пул несёт только сессию+tdata, но на
 *   всякий случай — чтобы новый аккаунт стартовал с чистым рабочим состоянием);
 * - пишет фазовый маркер `activating`.
 * Идемпотентна: повторный вызов на уже собранном `.incoming` даёт тот же результат.
 */
export function buildIncoming(agentId: string, poolId: string, persona: string, log: Logger): void {
    const inc = incomingDir(agentId);
    const old = workspaceDir(agentId);

    // 1. tg-account.json: creds пула + persona/accountId агента.
    const incAccountPath = path.join(inc, "tg-account.json");
    const poolCfg = JSON.parse(fs.readFileSync(incAccountPath, "utf-8"));
    poolCfg.accountId = agentId;
    poolCfg.persona = persona;
    fs.writeFileSync(incAccountPath, JSON.stringify(poolCfg, null, 2), "utf-8");

    // 2. tasks.db: перенести из старого workspace (сохранить журналы), очистить tasks.
    const oldTasksDb = path.join(old, "tasks.db");
    const incTasksDb = path.join(inc, "tasks.db");
    if (fs.existsSync(incTasksDb)) fs.rmSync(incTasksDb, { force: true });
    if (fs.existsSync(oldTasksDb)) {
        fs.renameSync(oldTasksDb, incTasksDb);
        const db = new Database(incTasksDb);
        try {
            // Только таблица tasks очищается; runs/error_log/dispatcher_runs сохраняются (R7).
            const hasTasks = db.prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`,
            ).get();
            if (hasTasks) db.prepare(`DELETE FROM tasks`).run();
        } finally {
            db.close();
        }
        log.info(`[banned-replacement] ${agentId}: tasks.db перенесён, таблица tasks очищена (журналы сохранены)`);
    }

    // 3. Прочие рабочие БД в .incoming — удалить (новый аккаунт стартует пустым).
    for (const dbName of WORKING_DBS) {
        const p = path.join(inc, dbName);
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }

    // 4. Фазовый маркер.
    writeMarker(agentId, poolId);
    log.info(`[banned-replacement] ${agentId}: .incoming собран (persona=${persona})`);
}

/**
 * Атомарный swap двумя rename: `workspace-<agentId>` → `.old`, `.incoming` →
 * `workspace-<agentId>`, затем удаление `.old`. Каждый rename атомарен; вся операция
 * восстановима по якорям (см. recoverAnchors). После swap маркер `activating` лежит
 * уже в боевом workspace — активацию доигрывает вызывающий.
 */
export function commitSwap(agentId: string, log: Logger): void {
    const live = workspaceDir(agentId);
    const inc = incomingDir(agentId);
    const old = oldDir(agentId);

    if (fs.existsSync(live)) {
        fs.renameSync(live, old);
    }
    fs.renameSync(inc, live);
    if (fs.existsSync(old)) {
        fs.rmSync(old, { recursive: true, force: true });
    }
    log.info(`[banned-replacement] ${agentId}: swap выполнен, старый workspace удалён`);
}

// ─── Фазовый маркер ────────────────────────────────────────────────────

function writeMarker(agentId: string, poolId: string): void {
    // Маркер пишется в .incoming (до swap) — после swap он окажется в боевом workspace.
    const marker: ReplacementMarker = { phase: "activating", agentId, poolId, createdAt: Math.floor(Date.now() / 1000) };
    const p = path.join(incomingDir(agentId), PHASE_MARKER);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), "utf-8");
    fs.renameSync(tmp, p);
}

/** Читает фазовый маркер из боевого workspace (активация не завершена, если он есть). */
export function readMarker(agentId: string): ReplacementMarker | null {
    try {
        return JSON.parse(fs.readFileSync(markerPath(agentId), "utf-8")) as ReplacementMarker;
    } catch {
        return null;
    }
}

/** Снимает фазовый маркер — активация завершена (перед снятием `banned`). */
export function clearMarker(agentId: string, log: Logger): void {
    try {
        fs.rmSync(markerPath(agentId), { force: true });
    } catch (err: any) {
        log.warn(`[banned-replacement] ${agentId}: не удалось снять маркер — ${err?.message ?? err}`);
    }
}

export function hasIncoming(agentId: string): boolean {
    return fs.existsSync(incomingDir(agentId));
}

/**
 * Восстановление незавершённого swap для одного агента на старте прогона (§4.4):
 * - есть `.incoming` и боевой workspace → build/swap не закончены: доделать swap
 *   (build уже идемпотентен и выполнен до записи маркера; здесь только досвапить);
 * - есть `.old` → swap оборвался между двумя rename: если боевой есть — удалить `.old`;
 *   если боевого нет — вернуть `.old` в боевой (откат к старому аккаунту, агент
 *   остаётся `banned`, замена переиграется).
 * Возвращает true, если что-то восстанавливал.
 */
export function recoverAnchors(agentId: string, log: Logger): boolean {
    const live = workspaceDir(agentId);
    const inc = incomingDir(agentId);
    const old = oldDir(agentId);
    let acted = false;

    if (fs.existsSync(old)) {
        if (fs.existsSync(live)) {
            fs.rmSync(old, { recursive: true, force: true });
            log.warn(`[banned-replacement] ${agentId}: восстановление — осиротевший .old удалён`);
        } else {
            fs.renameSync(old, live);
            log.warn(`[banned-replacement] ${agentId}: восстановление — .old возвращён в боевой (swap откачен)`);
        }
        acted = true;
    }

    if (fs.existsSync(inc)) {
        // build до записи маркера уже завершён; безопасно досвапить.
        commitSwap(agentId, log);
        acted = true;
    }
    return acted;
}
