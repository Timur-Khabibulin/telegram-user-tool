// core/reserve-accounts.ts — пер-персонный аналог core/pool-accounts.ts для резерва
// готовых аккаунтов персоны (persona-account-reserve). Резерв живёт в тех же
// workspace-каталогах, что и пул/рабочие агенты (`workspace-reserve-<persona>-<K>`),
// поэтому примитивы валидации/карантина/claim ПЕРЕИСПОЛЬЗУЮТСЯ из pool-accounts.ts
// как есть — здесь только перечисление/нумерация резерва со скоупом по персоне и
// резолвинг reserveId ⇄ workspace-reserve-<persona>-<K>.
//
// Невидимость резерва рабочему контуру держится на имени каталога
// (`workspace-reserve-*`): перечислители config.ts (listAgentIds/listPoolAccountIds)
// и счётчики номеров (computeNextAgentNumber/computeNextPoolNumber) его не матчат.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Logger } from "./logger";
import { workspaceDir } from "./config";
import { validatePoolAccount, quarantinePoolAccount } from "./pool-accounts";

/** Экранирует строку для безопасной подстановки в RegExp (имя персоны контролируемо, но без сюрпризов). */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Логический id аккаунта резерва: `reserve-<persona>-<K>`. workspaceDir(reserveId) = `workspace-reserve-<persona>-<K>`. */
export function reserveId(persona: string, k: number): string {
    return `reserve-${persona}-${k}`;
}

/**
 * Персона и номер K из reserveId (`reserve-<persona>-<K>`). Жадная `.+` на персону и
 * хвостовые цифры на K корректно разбирают персоны с дефисами (`persona-template`).
 * null — строка не похожа на reserveId.
 */
export function parseReserveId(id: string): { persona: string; k: number } | null {
    const m = id.match(/^reserve-(.+)-(\d+)$/);
    if (!m) return null;
    return { persona: m[1], k: Number(m[2]) };
}

/**
 * Аккаунты резерва персоны в порядке «старейший первым». Фильтр по префиксу
 * `workspace-reserve-<persona>-` + хвост из цифр (без `.invalid`/`.incoming`); якорь
 * возраста — ctime каталога (метка K переиспользуется во времени и монотонности не
 * гарантирует — та же логика, что у пула). Возвращает логические id `reserve-<persona>-<K>`.
 */
export function listReserveAccountsOldestFirst(persona: string): string[] {
    const base = path.join(os.homedir(), ".openclaw");
    const re = new RegExp(`^workspace-reserve-${escapeRegExp(persona)}-(\\d+)$`);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && re.test(e.name))
        .map((e) => {
            const k = Number(e.name.match(re)![1]);
            let ctimeMs = Number.POSITIVE_INFINITY;
            try {
                ctimeMs = fs.statSync(path.join(base, e.name)).ctimeMs;
            } catch {
                // каталог исчез между перечислением и stat — уедет в конец, отсеется при claim
            }
            return { id: reserveId(persona, k), ctimeMs };
        })
        .sort((a, b) => a.ctimeMs - b.ctimeMs)
        .map((e) => e.id);
}

/**
 * Следующая метка K резерва персоны = (максимальная присутствующая) + 1. Сканирует
 * СЫРЫЕ имена в ~/.openclaw (`workspace-reserve-<persona>-<K>` и карантинные/транзиентные
 * `...<K>.invalid|.incoming`) и переданные стейджинг-корни (`reserve-<persona>-<K>`),
 * чтобы переиспользованная метка не столкнулась с карантинным/стейджинг-каталогом —
 * точная калька `computeNextPoolNumber`, но со скоупом по персоне. Пустой резерв → 1.
 *
 * `stagingRoots` передаёт скилл провиженинга (обвязка в staging.ts) — ядро само путь
 * стейджинга фичи не знает и от неё не зависит.
 */
export function computeNextReserveNumber(persona: string, stagingRoots: string[] = []): number {
    let max = 0;
    const consider = (n: number) => { if (Number.isFinite(n) && n > max) max = n; };
    const esc = escapeRegExp(persona);

    const openclawRoot = path.join(os.homedir(), ".openclaw");
    const liveRe = new RegExp(`^workspace-reserve-${esc}-(\\d+)(?:\\..*)?$`);
    try {
        for (const e of fs.readdirSync(openclawRoot, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const m = e.name.match(liveRe);
            if (m) consider(Number(m[1]));
        }
    } catch { /* каталога ещё нет */ }

    const stagingRe = new RegExp(`^reserve-${esc}-(\\d+)$`);
    for (const root of stagingRoots) {
        try {
            for (const e of fs.readdirSync(root, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                const m = e.name.match(stagingRe);
                if (m) consider(Number(m[1]));
            }
        } catch { /* стейджинга ещё нет */ }
    }

    return max + 1;
}

/**
 * Первый пригодный аккаунт резерва персоны в порядке «старейший первым» — калька
 * `findValidPoolAccount` поверх резерва. Валидация подключением делегирует в
 * `validatePoolAccount` (загрузчик `{ pool: true }` только подключается и зовёт
 * `getMe`, персону игнорирует — применим к reserveId как есть): `invalid` → карантин
 * `quarantinePoolAccount` (каталог → `…-<K>.invalid`) и берём следующего той же
 * персоны (добор R16); `skip` (прокси/сеть/SessionBusy) → аккаунт остаётся в резерве,
 * пробуем следующего; `ok` → возвращаем reserveId. null — пригодных нет.
 */
export async function findValidReserveAccount(persona: string, log: Logger): Promise<string | null> {
    for (const id of listReserveAccountsOldestFirst(persona)) {
        const verdict = await validatePoolAccount(id, log);
        if (verdict === "ok") {
            log.info(`[reserve] аккаунт резерва ${id} валиден — берём`);
            return id;
        }
        if (verdict === "invalid") {
            log.warn(`[reserve] аккаунт резерва ${id} непригоден — карантин`);
            quarantinePoolAccount(id);
        } else {
            log.warn(`[reserve] аккаунт резерва ${id}: ошибка подключения — пропуск, остаётся в резерве`);
        }
    }
    return null;
}
