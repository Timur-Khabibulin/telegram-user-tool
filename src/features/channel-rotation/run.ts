// features/channel-rotation/run.ts — оркестрация суточной ротации каналов,
// покинутых из-за бана (channel-rotation). Собирает кандидатов по всем
// агентам платформы, строит план (plan.ts) и переносит назначения:
// реестр (forceAssignChannel) → join-queue цели (addJoinQueue) → удаление
// строки канала у агента-источника (deleteChannelRow).

import type { Logger } from "../../core/logger";
import { listAgentIds, FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { getActiveRestriction } from "../../core/db/agent-restrictions";
import { isAgentActive } from "../../core/db/tasks";
import {
    getRotationCandidates,
    countLeavedFromBannedWithoutUsername,
    countActiveChannels,
    deleteChannelRow,
} from "../../core/db/channels";
import { normalizeChannelLink, forceAssignChannel } from "../../core/db/discovery";
import { addJoinQueue } from "../../core/db/join-queue";
import { planRotation, type RotationCandidate } from "./plan";

export interface ChannelRotationSummary {
    candidatesTotal: number;
    skippedNoUsername: number;
    rotated: number;
    unassigned: number;
    byTargetAgent: Record<string, number>;
}

/**
 * Активные агенты-цели (channel-rotation): нет активного ограничения
 * (`agent_restrictions`) И включена хотя бы одна версия monitor-задачи
 * (`isAgentActive`). Агент, у которого канал был забанен, не исключается из
 * этого списка — исключение действует только для его собственного канала
 * (см. planRotation).
 */
function getActiveTargetAgents(adminAgentId: string): string[] {
    return listAgentIds().filter(
        (agentId) => getActiveRestriction(adminAgentId, agentId) === null && isAgentActive(agentId),
    );
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
 * Суточный прогон ротации: находит каналы в `leaved_from_banned` по всем
 * агентам, распределяет их между активными агентами (round-robin по
 * нагрузке, plan.ts) и переносит назначение. Синхронно — только SQLite,
 * без обращения к Telegram (фактическое вступление делает join-queue).
 */
export function runChannelRotation(log: Logger, adminAgentId: string = FUNNEL_ADMIN_AGENT_ID): ChannelRotationSummary {
    const allAgents = listAgentIds();
    const { candidates, skippedNoUsername } = collectCandidates(allAgents, log);

    const activeAgents = getActiveTargetAgents(adminAgentId);
    const loadByAgent = new Map(activeAgents.map((agentId) => [agentId, countActiveChannels(agentId)]));

    const { assignments, unassigned } = planRotation(candidates, activeAgents, loadByAgent);

    const byTargetAgent: Record<string, number> = {};
    for (const { candidate, targetAgentId } of assignments) {
        const link = normalizeChannelLink(candidate.channelUsername);
        forceAssignChannel(adminAgentId, link, targetAgentId);
        addJoinQueue(targetAgentId, [link], log);
        deleteChannelRow(candidate.sourceAgentId, candidate.chatId, log);
        byTargetAgent[targetAgentId] = (byTargetAgent[targetAgentId] ?? 0) + 1;
    }

    const summary: ChannelRotationSummary = {
        candidatesTotal: candidates.length,
        skippedNoUsername,
        rotated: assignments.length,
        unassigned: unassigned.length,
        byTargetAgent,
    };

    log.info(
        `[channel-rotation] candidates=${summary.candidatesTotal} rotated=${summary.rotated} ` +
            `unassigned=${summary.unassigned} skippedNoUsername=${summary.skippedNoUsername} ` +
            `byTargetAgent=${JSON.stringify(summary.byTargetAgent)}`,
    );

    return summary;
}
