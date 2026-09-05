// skills/channel-cleanup.ts — runChannelCleanup.
//
// Ручная чистка слабых каналов: выход + удаление всех рабочих данных агента.
// Вызывается из index.ts через tg_channel_cleanup, не диспетчером.
// Порядок: leaveChannel РАНЬШЕ purgeChannelData — иначе syncChannels вернёт канал.
//
// todo: нарушает конвенцию SkillContext → SkillStatus (src/skills/types.ts):
//   1. принимает (params, tg, log) вместо единого SkillContext
//   2. возвращает ChannelCleanupResult вместо SkillStatus — диспетчер не может вызвать
// причина: работает с несколькими агентами сразу, SkillContext привязан к одному agentId.

import type { Logger } from "../core/logger";
import type { TelegramService } from "../core/telegram/service";
import {
    getChannelsForCleanup,
    purgeChannelData,
    type CleanupChannelRow,
} from "../core/db/channels";
import { normalizeChannelLink, deleteDiscoveredChannel } from "../core/db/discovery";
import { FUNNEL_ADMIN_AGENT_ID } from "../core/config";

// ─── Типы ─────────────────────────────────────────────────────────────

export interface ChannelCleanupParams {
    agents: string[];
    minSubsCount?: number;
    minAvgViews?: number;
}

interface ChannelResult {
    chatId: string;
    title: string;
    avgViews: number | null;
    subsCount: number | null;
    result: "cleaned" | "leave_failed";
}

interface AgentResult {
    agentId: string;
    candidates: number;
    cleaned: number;
    leaveFailed: number;
    discoverySkipped: number;
    channelList: ChannelResult[];
}

export interface ChannelCleanupResult {
    agents: AgentResult[];
}

// ─── Фильтрация ────────────────────────────────────────────────────────

function filterCandidates(channels: CleanupChannelRow[], params: ChannelCleanupParams): CleanupChannelRow[] {
    return channels.filter((ch) => {
        if (params.minAvgViews !== undefined) {
            const effectiveViews = ch.avg_views ?? 0;
            if (effectiveViews >= params.minAvgViews) return false;
        }
        if (params.minSubsCount !== undefined) {
            const effectiveSubs = ch.subs_count ?? 0;
            if (effectiveSubs >= params.minSubsCount) return false;
        }
        return true;
    });
}

// ─── Основная функция ──────────────────────────────────────────────────

export async function runChannelCleanup(
    params: ChannelCleanupParams,
    tg: TelegramService,
    log: Logger,
): Promise<ChannelCleanupResult> {
    const results: AgentResult[] = [];

    for (const agentId of params.agents) {
        try {
            tg.loadAccount(agentId);
        } catch (err: any) {
            log.warn(`[channel-cleanup] skipping agentId=${agentId}: cannot load account: ${err.message ?? err}`);
            continue;
        }

        try {
            const channels = getChannelsForCleanup(agentId);
            const candidates = filterCandidates(channels, params);

            const agentResult: AgentResult = {
                agentId,
                candidates: candidates.length,
                cleaned: 0,
                leaveFailed: 0,
                discoverySkipped: 0,
                channelList: [],
            };

            if (candidates.length > 0) {
                // Итерируем ВСЕ диалоги TG без лимита страниц, пока все кандидаты не найдены
                // в peerCache — слабые каналы оседают в хвосте за пределами топ-200.
                await tg.populatePeerCacheForIds(candidates.map((c) => c.chatId));

                for (const ch of candidates) {
                    try {
                        await tg.leaveChannel(ch.chatId);
                    } catch (err: any) {
                        log.warn(`[channel-cleanup] leaveChannel failed agentId=${agentId} chatId=${ch.chatId}: ${err.message ?? err}`);
                        agentResult.leaveFailed += 1;
                        agentResult.channelList.push({ chatId: ch.chatId, title: ch.title, avgViews: ch.avg_views, subsCount: ch.subs_count, result: "leave_failed" });
                        continue;
                    }

                    purgeChannelData(agentId, ch.chatId, log);

                    if (ch.channelResolved === 1 && ch.channelUsername) {
                        const canonical = normalizeChannelLink(ch.channelUsername);
                        deleteDiscoveredChannel(FUNNEL_ADMIN_AGENT_ID, canonical);
                    } else {
                        agentResult.discoverySkipped += 1;
                    }

                    agentResult.cleaned += 1;
                    agentResult.channelList.push({ chatId: ch.chatId, title: ch.title, avgViews: ch.avg_views, subsCount: ch.subs_count, result: "cleaned" });
                }
            }

            log.info(`[channel-cleanup] agentId=${agentId} — cleaned=${agentResult.cleaned} leaveFailed=${agentResult.leaveFailed}`);
            results.push(agentResult);
        } catch (err: any) {
            log.warn(`[channel-cleanup] agentId=${agentId} failed, skipping: ${err.message ?? err}`);
        } finally {
            await tg.disconnect();
        }
    }

    return { agents: results };
}
