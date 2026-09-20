// features/channel-rotation/run.ts — оркестрация суточной ротации каналов,
// покинутых из-за бана (channel-rotation, channel-multipersona). Собирает
// кандидатов по всем агентам платформы, ГРУППИРУЕТ ИХ ПО ПЕРСОНЕ источника и
// распределяет каждую группу независимо только по активным агентам своей персоны:
// реестр (setAssignmentAgent) → join-queue цели (addJoinQueue) → удаление строки
// канала у агента-источника (deleteChannelRow). Если у персоны нет активного
// агента-цели, слот становится пустым (agent_id=NULL), канал остаётся в персоне.

import type { Logger } from "../../core/logger";
import { listAgentIds, FUNNEL_ADMIN_AGENT_ID, buildPersonaIndex } from "../../core/config";
import { resolvePersonaTargets } from "../../core/persona-targets";
import {
    getRotationCandidates,
    countLeavedFromBannedWithoutUsername,
    deleteChannelRow,
} from "../../core/db/channels";
import { getChannelVisitCounts } from "../../core/db/channel-operations";
import { normalizeChannelLink, setAssignmentAgent } from "../../core/db/discovery";
import { addJoinQueue } from "../../core/db/join-queue";
import { planRotation, type RotationCandidate } from "./plan";

export interface ChannelRotationSummary {
    candidatesTotal: number;
    skippedNoUsername: number;
    rotated: number;
    unassigned: number;
    byTargetAgent: Record<string, number>;
}

function collectCandidates(agentIds: string[], log: Logger): { candidates: RotationCandidate[]; skippedNoUsername: number } {
    const candidates: RotationCandidate[] = [];
    let skippedNoUsername = 0;
    for (const agentId of agentIds) {
        for (const row of getRotationCandidates(agentId, log)) {
            candidates.push({
                sourceAgentId: agentId,
                chatId: row.chatId,
                channelUsername: row.channelUsername,
                statusUpdatedAt: row.statusUpdatedAt,
            });
        }
        skippedNoUsername += countLeavedFromBannedWithoutUsername(agentId);
    }
    return { candidates, skippedNoUsername };
}

/**
 * Суточный прогон ротации: находит каналы в `leaved_from_banned` по всем агентам,
 * группирует кандидатов по персоне агента-источника и распределяет каждую группу
 * независимо только по активным агентам своей персоны (по истории посещений —
 * минимальный visit-count, plan.ts). Назначенному кандидату выставляется целевой агент в закреплении
 * персоны; непристроенному (в персоне нет доступной цели) слот обнуляется — канал
 * остаётся в персоне до следующего прогона. Синхронно — только SQLite, без
 * обращения к Telegram (фактическое вступление делает join-queue).
 */
export function runChannelRotation(log: Logger, adminAgentId: string = FUNNEL_ADMIN_AGENT_ID): ChannelRotationSummary {
    const allAgents = listAgentIds();
    const { candidates, skippedNoUsername } = collectCandidates(allAgents, log);
    const personaIndex = buildPersonaIndex();

    // Группируем кандидатов по персоне агента-источника: каждая персона ротируется
    // независимо (R5/AC-6). Кандидаты без определимой персоны источника ротировать
    // некуда — учитываем как unassigned, реестр не трогаем.
    const byPersona = new Map<string, RotationCandidate[]>();
    let unresolvedPersona = 0;
    for (const candidate of candidates) {
        const persona = personaIndex.get(candidate.sourceAgentId);
        if (!persona) {
            unresolvedPersona += 1;
            log.warn(`[channel-rotation] персона источника ${candidate.sourceAgentId} не определена — кандидат ${candidate.channelUsername} пропущен`);
            continue;
        }
        const group = byPersona.get(persona);
        if (group) group.push(candidate);
        else byPersona.set(persona, [candidate]);
    }

    const byTargetAgent: Record<string, number> = {};
    let rotated = 0;
    let unassigned = unresolvedPersona;

    for (const [persona, group] of byPersona) {
        const activeAgents = resolvePersonaTargets(persona, adminAgentId, personaIndex);
        // Visit-count per-channel из журнала операций (разрез персоны): для каждого
        // кандидата — сколько раз канал уже назначался каждому агенту (channel-rotation-visit-history).
        const visitsByChannel = new Map<string, Map<string, number>>(
            group.map((candidate) => [
                candidate.chatId,
                new Map(Object.entries(getChannelVisitCounts(adminAgentId, candidate.chatId, persona))),
            ]),
        );
        const plan = planRotation(group, activeAgents, visitsByChannel);

        for (const { candidate, targetAgentId } of plan.assignments) {
            const link = normalizeChannelLink(candidate.channelUsername);
            setAssignmentAgent(adminAgentId, persona, link, targetAgentId, "module", log);
            addJoinQueue(targetAgentId, [link], log);
            deleteChannelRow(candidate.sourceAgentId, candidate.chatId, log);
            byTargetAgent[targetAgentId] = (byTargetAgent[targetAgentId] ?? 0) + 1;
            rotated += 1;
        }
        // Непристроенные: слот пуст (agent_id=NULL), строку закрепления сохраняем,
        // строку канала у источника НЕ удаляем (кандидат переоценится следующим
        // прогоном). Канал остаётся в персоне, в другую не уходит (AC-5).
        for (const candidate of plan.unassigned) {
            const link = normalizeChannelLink(candidate.channelUsername);
            setAssignmentAgent(adminAgentId, persona, link, null, "module", log);
            unassigned += 1;
        }
    }

    const summary: ChannelRotationSummary = {
        candidatesTotal: candidates.length,
        skippedNoUsername,
        rotated,
        unassigned,
        byTargetAgent,
    };

    log.info(
        `[channel-rotation] candidates=${summary.candidatesTotal} rotated=${summary.rotated} ` +
            `unassigned=${summary.unassigned} skippedNoUsername=${summary.skippedNoUsername} ` +
            `byTargetAgent=${JSON.stringify(summary.byTargetAgent)}`,
    );

    return summary;
}
