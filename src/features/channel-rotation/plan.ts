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
 * Round-robin по активным агентам, отсортированным по возрастанию нагрузки
 * один раз в начале (тай-брейк при равенстве — случайный) — порядок
 * фиксируется на весь прогон, дальше не пересчитывается. Кандидаты
 * распределяются по кругу этого порядка; агент-источник конкретного канала
 * пропускается только для него самого (design.md: «Round-robin по нагрузке»).
 */
export function planRotation(
    candidates: RotationCandidate[],
    activeAgentIds: string[],
    loadByAgent: Map<string, number>,
): RotationPlanResult {
    const sortedCandidates = [...candidates].sort((a, b) => (a.statusUpdatedAt ?? 0) - (b.statusUpdatedAt ?? 0));

    const targets = activeAgentIds
        .map((id) => ({ id, load: loadByAgent.get(id) ?? 0, tieBreak: Math.random() }))
        .sort((a, b) => a.load - b.load || a.tieBreak - b.tieBreak)
        .map((t) => t.id);

    const assignments: RotationAssignment[] = [];
    const unassigned: RotationCandidate[] = [];
    const n = targets.length;
    let cursor = 0;

    for (const candidate of sortedCandidates) {
        if (n === 0) {
            unassigned.push(candidate);
            continue;
        }
        let idx = cursor % n;
        let attempts = 0;
        while (targets[idx] === candidate.sourceAgentId && attempts < n) {
            idx = (idx + 1) % n;
            attempts += 1;
        }
        if (attempts >= n) {
            // Единственная возможная цель — тот же агент, у которого канал забанен.
            unassigned.push(candidate);
            continue;
        }
        assignments.push({ candidate, targetAgentId: targets[idx] });
        cursor = idx + 1;
    }

    return { assignments, unassigned };
}
