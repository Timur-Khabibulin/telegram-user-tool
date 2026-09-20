// core/persona-targets.ts — резолвинг активных агентов персоны (channel-multipersona).
//
// Единица таргетинга для дискавери, распределения и ротации — имя персоны.
// Платформа сама берёт её активных агентов: к существующему критерию активности
// (нет активного ограничения И (включён хотя бы один монитор ИЛИ account-warmup))
// добавляется фильтр принадлежности персоне. Отдельный модуль (не config.ts) — чтобы не заводить
// цикл config ↔ db: здесь есть зависимости от db/tasks и db/agent-restrictions,
// которые сами импортируют config.
//
// Пустой результат = у персоны нет активных агентов: вызывающая способность
// прекращает прогон с сообщением (см. runDistribution / discovery), а не работает
// вхолостую. Design: docs/design/channel-multipersona/architecture.md §3.5.

import { buildPersonaIndex } from "./config";
import { getActiveRestriction } from "./db/agent-restrictions";
import { isAgentActive } from "./db/tasks";

/** Числовой суффикс agentId (`agent12` → 12) для детерминированной сортировки целей. */
function agentNumber(agentId: string): number {
    const m = agentId.match(/(\d+)$/);
    return m ? Number(m[1]) : 0;
}

/**
 * Активные агенты персоны, отсортированные детерминированно (по числовому суффиксу,
 * затем лексикографически) — порядок важен для round-robin дискавери и
 * воспроизводимости раскладки (NFR-2). `personaIndex` передаётся вызывающим
 * (построен один раз на прогон через `buildPersonaIndex`); по умолчанию строится
 * здесь для разовых вызовов.
 */
export function resolvePersonaTargets(
    persona: string,
    adminAgentId: string,
    personaIndex: ReadonlyMap<string, string> = buildPersonaIndex(),
): string[] {
    const targets: string[] = [];
    for (const [agentId, agentPersona] of personaIndex) {
        if (agentPersona !== persona) continue;
        if (getActiveRestriction(adminAgentId, agentId) !== null) continue;
        if (!isAgentActive(agentId)) continue;
        targets.push(agentId);
    }
    return targets.sort((a, b) => agentNumber(a) - agentNumber(b) || (a < b ? -1 : 1));
}

/** Известна ли персона платформе (есть хотя бы один агент с таким `persona`). */
export function isKnownPersona(persona: string, personaIndex: ReadonlyMap<string, string> = buildPersonaIndex()): boolean {
    for (const agentPersona of personaIndex.values()) {
        if (agentPersona === persona) return true;
    }
    return false;
}
