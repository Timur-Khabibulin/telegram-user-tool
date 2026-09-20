// features/channel-rotation/plan.ts — чистая логика распределения кандидатов
// на ротацию по целевым агентам (channel-rotation). Без I/O: принимает готовые
// списки/карты, возвращает план — тестируется независимо от БД.

export interface RotationCandidate {
    sourceAgentId: string;
    chatId: string;
    channelUsername: string;
    statusUpdatedAt: number | null;
}

export interface RotationAssignment {
    candidate: RotationCandidate;
    targetAgentId: string;
}

export interface RotationPlanResult {
    assignments: RotationAssignment[];
    /** Кандидаты, для которых не нашлось допустимой цели (например, единственный активный агент — источник этого же канала). */
    unassigned: RotationCandidate[];
}

/**
 * Раскладка по истории посещений (channel-rotation-visit-history): каждый канал
 * получает активного агента персоны с МИНИМАЛЬНЫМ visit-count (число прошлых
 * `assigned`-событий по этому каналу для агента, `visitsByChannel`), случайно среди
 * равных, исключая агента-источник. Нагрузка агента больше не участвует (R1).
 *
 * Выбор per-candidate независим (design v2, §2.1): visit-count одного канала не
 * зависит от того, кому в этом же прогоне достался другой — общего курсора/аккумулятора
 * нет. «Круги» (R6) возникают как следствие роста минимума: пока есть агенты с
 * visit-count 0 — канал идёт им; когда у всех подходящих ≥1, минимум становится 1 и т.д.
 *
 * `visitsByChannel` — карта `chatId → (agentId → count)`; отсутствие агента во
 * внутренней карте (или отсутствие самого канала) трактуется как visit-count 0.
 */
export function planRotation(
    candidates: RotationCandidate[],
    activeAgentIds: string[],
    visitsByChannel: ReadonlyMap<string, ReadonlyMap<string, number>>,
): RotationPlanResult {
    const assignments: RotationAssignment[] = [];
    const unassigned: RotationCandidate[] = [];

    for (const candidate of candidates) {
        // R5: источник этого канала исключается из числа целей.
        const pool = activeAgentIds.filter((id) => id !== candidate.sourceAgentId);
        if (pool.length === 0) {
            // Единственный активный агент персоны — источник → цели нет (R7, AC-6).
            unassigned.push(candidate);
            continue;
        }

        const visits = visitsByChannel.get(candidate.chatId);
        const visitCount = (agentId: string) => visits?.get(agentId) ?? 0;

        const minVisits = Math.min(...pool.map(visitCount));
        const winners = pool.filter((agentId) => visitCount(agentId) === minVisits);
        // R4/AC-3: случайный среди равных по минимуму.
        const targetAgentId = winners[Math.floor(Math.random() * winners.length)];
        assignments.push({ candidate, targetAgentId });
    }

    return { assignments, unassigned };
}
