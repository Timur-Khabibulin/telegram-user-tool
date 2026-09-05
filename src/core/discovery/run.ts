// core/discovery/run.ts — оркестрация прогона channel-discovery.
//
// Инкрементальный отбор: по ключевым словам ищем каналы в TGStat → дедуп против
// реестра → гейт по подписчикам → round-robin раскладка по агентам →
// запись в реестр и push в join_queue агента. Останавливаемся, набрав N новых
// каналов или исчерпав ключевые слова. Вступление НЕ запускаем (его инициирует
// per-agent таймер join-queue). Детерминированно, без LLM.
//
// Используется и тонким скриптом scripts/discovery.ts, и тулом discovery_run.
// Design: docs/design/channel-discovery/channel-discovery-v1.md.

import type { Logger } from "../logger";
import { normalizeChannelLink, isKnownChannel, registerChannel } from "../db/discovery";
import { searchChannels, getChannelStat } from "./tgstat";
import { addJoinQueue } from "../db/join-queue";
import type { TelegramService } from "../telegram/service";

export interface RunParams {
    keywords: string[];
    target: number;             // N — целевое число новых каналов за прогон
    minSubscribers: number;
    minAvgPostReach?: number;   // опциональный гейт по среднему охвату публикации
    avgReachAgentId?: string;   // agentId для MTProto fallback (D5)
    telegramService?: TelegramService; // готовый авторизованный сервис для MTProto fallback (D5)
    adminAgentId: string;       // владелец реестра discovery.db
    agents: string[];           // кому раскладываем (round-robin)
    tgstatToken: string;        // токен TGStat (плагин — из pluginConfig, скрипт — из env)
}

export interface RunResult {
    collected: number;
    perAgent: Record<string, number>;
    target: number;
    exhausted: boolean;         // пространство кончилось раньше target
    rejectedByAvgReach: number; // отсеяно гейтом охвата (0 если гейт не задан)
    minAvgPostReach?: number;   // эхо параметра — для условного рендеринга отчёта
}

export async function runDiscovery(p: RunParams, log: Logger): Promise<RunResult> {
    const perAgent: Record<string, number> = Object.fromEntries(p.agents.map((a) => [a, 0]));
    let collected = 0;
    let cursor = 0; // round-robin курсор по агентам
    let rejectedByAvgReach = 0;

    for (const keyword of p.keywords) {
        if (collected >= p.target) break;

        const candidates = await searchChannels(keyword, p.tgstatToken, log);
        for (const c of candidates) {
            if (collected >= p.target) break;
            if (!c.link) continue;

            const canonical = normalizeChannelLink(c.link);

            // Дедуп против реестра.
            if (isKnownChannel(p.adminAgentId, canonical)) continue;

            // Гейт по подписчикам (из выдачи, без доп. запроса).
            if (c.participantsCount < p.minSubscribers) continue;

            // Гейт по среднему охвату публикации (опционален — только если задан minAvgPostReach).
            if (p.minAvgPostReach != null) {
                let avgPostReach: number | null = null;

                // Первый источник: TGStat channels/stat (требует tgId).
                if (c.tgId != null) {
                    try {
                        const stat = await getChannelStat(c.tgId, p.tgstatToken, log);
                        avgPostReach = stat.avgPostReach;
                    } catch (err) {
                        log.warn(`[discovery] avg_reach gate: channels/stat failed, trying MTProto fallback — ${canonical}: ${err}`);
                    }
                } else {
                    log.warn(`[discovery] avg_reach gate: tgId==null, trying MTProto fallback — ${canonical}`);
                }

                // MTProto fallback: при ошибке TGStat или отсутствии tgId (D1, D2).
                if (avgPostReach === null) {
                    // Извлекаем username из canonical (уже нормализованный c.link).
                    // Приватные invite-ссылки вида t.me/+... — fail-closed (D6).
                    const usernamePart = canonical.replace(/^https?:\/\/t\.me\//, "");
                    if (!usernamePart || usernamePart.startsWith("+")) {
                        log.warn(`[discovery] avg_reach gate: invite link, no username for MTProto fallback, fail-closed — ${canonical}`);
                        rejectedByAvgReach += 1;
                        continue;
                    }
                    if (!p.avgReachAgentId || !p.telegramService) {
                        log.warn(`[discovery] avg_reach gate: avgReachAgentId not set, fail-closed — ${canonical}`);
                        rejectedByAvgReach += 1;
                        continue;
                    }
                    try {
                        avgPostReach = await p.telegramService.getChannelAvgPostReach(usernamePart, 10, log);
                    } catch (err) {
                        log.warn(`[discovery] avg_reach gate: MTProto fallback failed, fail-closed — ${canonical}: ${err}`);
                        rejectedByAvgReach += 1;
                        continue;
                    }
                }

                if (avgPostReach <= p.minAvgPostReach) {
                    log.info(`[discovery] avg_reach gate: ${avgPostReach} <= ${p.minAvgPostReach}, rejected — ${canonical}`);
                    rejectedByAvgReach += 1;
                    continue;
                }
            }

            // Прошёл все гейты — назначаем round-robin и фиксируем.
            const agent = p.agents[cursor % p.agents.length];
            const { inserted } = registerChannel(p.adminAgentId, canonical, agent);
            if (!inserted) continue; // уже известен (гонка) — курсор не тратим

            addJoinQueue(agent, [canonical], log);
            perAgent[agent] = (perAgent[agent] ?? 0) + 1;
            collected += 1;
            cursor += 1;
        }
    }

    return { collected, perAgent, target: p.target, exhausted: collected < p.target, rejectedByAvgReach, minAvgPostReach: p.minAvgPostReach };
}

export function renderReport(r: RunResult): string {
    const lines: string[] = [];
    lines.push(`🔎 Discovery — найдено и распределено ${r.collected} из ${r.target}`);
    lines.push("");
    for (const [agent, count] of Object.entries(r.perAgent)) {
        lines.push(`• ${agent}: ${count}`);
    }
    if (r.minAvgPostReach != null) {
        lines.push(`• отсеяно по охвату: ${r.rejectedByAvgReach}`);
    }
    if (r.exhausted) {
        lines.push("");
        lines.push(`⚠️ Пространство исчерпано: найдено ${r.collected} из ${r.target}. Расширь ключевые слова или снизь порог подписчиков.`);
    }
    return lines.join("\n");
}
