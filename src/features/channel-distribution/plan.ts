// features/channel-distribution/plan.ts — чистая логика балансировки распределения
// каналов по целевым агентам (channel-distribution, R6/R19). Без I/O: принимает
// набор агентов, стартовую нагрузку и список каналов, возвращает раскладку —
// тестируется независимо от БД.
//
// Стратегия — детерминированный water-fill (выравнивание итоговой нагрузки, в
// отличие от health-spread round-robin у channel-rotation): каждый следующий
// канал уходит агенту с минимальной ТЕКУЩЕЙ нагрузкой (старт = число уже
// закреплённых каналов в реестре), при равенстве — меньший agentId; после
// назначения нагрузка агента увеличивается. Так отстающие агенты подтягиваются
// первыми, а одинаковый вход при одинаковом старте даёт одинаковую раскладку.

export interface DistributionAssignment {
    canonicalLink: string;
    targetAgentId: string;
}

/**
 * Раскладывает `canonicalLinks` по `targetAgentIds`, выравнивая итоговую нагрузку.
 * `startLoadByAgent` — стартовое число закреплённых каналов на агента
 * (`assignmentCounts`); отсутствующий агент считается с нагрузкой 0. Порядок
 * `canonicalLinks` сохраняется как порядок назначения. Пустой набор агентов →
 * пустая раскладка (вызывающий не должен звать план без целей).
 */
export function planDistribution(
    canonicalLinks: readonly string[],
    targetAgentIds: readonly string[],
    startLoadByAgent: ReadonlyMap<string, number>,
): DistributionAssignment[] {
    if (targetAgentIds.length === 0) return [];

    const load = new Map<string, number>(targetAgentIds.map((id) => [id, startLoadByAgent.get(id) ?? 0]));
    const assignments: DistributionAssignment[] = [];

    for (const canonicalLink of canonicalLinks) {
        const targetAgentId = leastLoadedAgent(targetAgentIds, load);
        assignments.push({ canonicalLink, targetAgentId });
        load.set(targetAgentId, (load.get(targetAgentId) ?? 0) + 1);
    }

    return assignments;
}

/** Агент с минимальной текущей нагрузкой; тай-брейк — лексикографически меньший agentId (детерминизм R19). */
function leastLoadedAgent(targetAgentIds: readonly string[], load: ReadonlyMap<string, number>): string {
    let best = targetAgentIds[0];
    let bestLoad = load.get(best) ?? 0;
    for (const id of targetAgentIds) {
        const current = load.get(id) ?? 0;
        if (current < bestLoad || (current === bestLoad && id < best)) {
            best = id;
            bestLoad = current;
        }
    }
    return best;
}
