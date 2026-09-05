// core/discovery/similar.ts — обход графа похожих каналов (channel-discovery-similar v2).
//
// Две фазы:
//   1. СБОР — все искатели запускаются одновременно (Promise.all). Каждый держит
//      собственную Telegram-сессию на весь обход, строит per-searcher sorted seeds
//      и делает независимый BFS. Найденные каналы регистрируются в реестр без агента
//      (assigned_agent = NULL). Общий счётчик totalCollected — условие остановки.
//   2. РАСПРЕДЕЛЕНИЕ — строго после завершения всех искателей: каналы без агента
//      раскладываются round-robin по агентам платформы, до target каждому.
// Вступление НЕ запускаем. Детерминированно (кроме LLM-оценки темы кандидата).
//
// Candidate-гейт: подписчики ≥ min, есть группа обсуждения,
// вовлечённость (ER + средний просмотр на пост > порогов), тема релевантна (LLM-оценка >
// minTopicScore, fail-closed). Порядок гейтов не меняется.
// Design: openspec/changes/discovery-similar-parallel/design.md.

import { z } from "zod";

import type { Logger } from "../logger";
import type { LlmClient } from "../../llm/client";
import { scoreTopicRelevance } from "../../llm/prompts";
import { TelegramService, type ChannelHandle, type ChannelPost } from "../telegram/service";
import { FloodWaitError, ClientNotConnectedError } from "../telegram/errors";
import { normalizeChannelLink, isKnownChannel, registerChannel, getUnassignedChannels, assignChannel } from "../db/discovery";
import { addJoinQueue } from "../db/join-queue";
import { getAnalysisChannels } from "../db/channels";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const pacingMs = () => 800 + Math.random() * 400; // 0.8–1.2 c
const MAX_CONSECUTIVE_FLOOD = 2;

const ENGAGEMENT_SKIP_FRESH = 2;

const TOPIC_SYSTEM = "Ты — классификатор тематической релевантности Telegram-каналов. Отвечай только JSON.";
const topicSchema = z.object({
    theses: z.array(z.string()).optional(),
    channelTopic: z.string().optional(),
    score: z.number(),
    reason: z.string().optional(),
});

/** Медиана выборки; null для пустой (устойчива к выбросам — закреп/виральный пост). */
function median(nums: number[]): number | null {
    if (nums.length === 0) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Среднее выборки; null для пустой. Без защиты от выбросов — осознанно (D2). */
function average(nums: number[]): number | null {
    if (nums.length === 0) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function engagementSample(views: number[]): number[] {
    return views.length > ENGAGEMENT_SKIP_FRESH ? views.slice(ENGAGEMENT_SKIP_FRESH) : [];
}

/** ER + средний просмотр на пост кандидата по выборке его постов (D2-D3). */
function computeEngagement(posts: ChannelPost[], subscribers: number | null): { avgViews: number; er: number } | null {
    if (subscribers == null || subscribers <= 0) return null;
    const avgViews = average(engagementSample(posts.map((p) => p.views)));
    if (avgViews == null) return null;
    return { avgViews, er: avgViews / subscribers };
}

/** Внутренний сигнал «обход у искателя остановлен по FLOOD_WAIT». */
class FloodStop extends Error {}

function makeFloodAware(searcherId: string, log: Logger) {
    let consecutive = 0;
    return async function floodAware<T>(fn: () => Promise<T>): Promise<T> {
        for (;;) {
            try {
                const r = await fn();
                consecutive = 0;
                return r;
            } catch (err) {
                if (err instanceof FloodWaitError) {
                    consecutive += 1;
                    if (consecutive >= MAX_CONSECUTIVE_FLOOD) {
                        log.warn(`[similar] ${searcherId}: FLOOD_WAIT ${MAX_CONSECUTIVE_FLOOD} раза подряд — стоп обхода искателя`);
                        throw new FloodStop();
                    }
                    log.warn(`[similar] ${searcherId}: FLOOD_WAIT ${err.waitSeconds}s — ждём и повторяем`);
                    await sleep(err.waitSeconds * 1000);
                    continue;
                }
                throw err;
            }
        }
    };
}

export interface SimilarParams {
    minSubscribers: number;
    target: number;
    adminAgentId: string;
    theme: string;
    minTopicScore: number;
    postsCount: number;
    minEngagementRate: number;
    minAvgViews: number;
}

/** Сколько кандидатов отсеяно по каждой причине (для отчёта оператору). */
export interface SkipCounts {
    lowSubscribers: number;
    noLinkedChat: number;
    lowEngagement: number;
    offTopic: number;
}

export interface SearcherStatus {
    stoppedByFlood: boolean;
    error?: string;
    collected: number;     // успешно зарегистрировано каналов этим искателем
    skips: SkipCounts;     // отсев по гейтам — per-searcher
    sawTruncated: boolean; // встречалось Premium-усечение выдачи рекомендаций
}

export interface RunSimilarParams extends SimilarParams {
    searchers: string[];
    allAgents: string[];
    llm: LlmClient;
}

export interface SimilarRunResult {
    collected: number;
    goal: number;
    reachedGoal: boolean;
    sawTruncated: boolean;
    perSearcher: Record<string, SearcherStatus>;
    distribution: Record<string, number>;
    skips: SkipCounts; // агрегат по всем искателям
}

/** Общее состояние в памяти: счётчик найденных каналов и цель. */
interface SharedCollectionState {
    totalCollected: number;
    goal: number;
}

interface TopicScoreResult {
    score: number;
    channelTopic: string | null;
}

async function scoreCandidateTopic(
    llm: LlmClient,
    info: { about: string | null },
    cand: ChannelHandle,
    theme: string,
    posts: ChannelPost[],
    log: Logger,
): Promise<TopicScoreResult | null> {
    const about = info.about ?? "";
    const texts = posts.map((p) => p.text.trim()).filter((t) => t.length > 0);
    if (about.trim().length === 0 && texts.length === 0) return null;
    try {
        const r = await llm.completeObject({ system: TOPIC_SYSTEM, prompt: scoreTopicRelevance(theme, about.trim(), texts) }, topicSchema);
        if (typeof r.score !== "number") return null;
        return { score: r.score, channelTopic: r.channelTopic ?? null };
    } catch (err) {
        log.info(`[similar] оценка темы «${cand.username}» не удалась — кандидат пропущен: ${(err as any)?.message ?? err}`);
        return null;
    }
}

/**
 * Один искатель: сбор и сортировка seeds по вовлечённости → BFS на своей сессии.
 * Регистрирует каналы без агента (фаза distribute назначит позже).
 * Никогда не реджектит promise — все ошибки в полях SearcherStatus.
 */
async function runSearcher(
    searcherId: string,
    shared: SharedCollectionState,
    p: RunSimilarParams,
    log: Logger,
): Promise<SearcherStatus> {
    const status: SearcherStatus = {
        stoppedByFlood: false,
        collected: 0,
        skips: { lowSubscribers: 0, noLinkedChat: 0, lowEngagement: 0, offTopic: 0 },
        sawTruncated: false,
    };
    const tg = new TelegramService(log);
    try {
        tg.loadAccount(searcherId);
        const floodAware = makeFloodAware(searcherId, log);

        // Шаг 1: seed-каналы из локального кеша (без сетевых вызовов).
        const cached = getAnalysisChannels(searcherId, log);
        log.info(`[similar] ${searcherId}: каналов в channels.db ${cached.length}, строю seed-каналы…`);

        const visited = new Set<string>();
        const seedHandles: ChannelHandle[] = [];
        for (const c of cached) {
            if (visited.has(c.channelId)) continue;
            visited.add(c.channelId);
            seedHandles.push(tg.buildChannelHandle(
                { channelId: c.channelId, accessHash: c.channelAccessHash, username: c.channelUsername },
                c.title,
            ));
        }

        // Шаг 2: оценка вовлечённости seeds (per-searcher, без глобальной сортировки).
        log.info(`[similar] ${searcherId}: seed-каналов ${seedHandles.length}, оцениваю вовлечённость (последние ${p.postsCount} постов, без ${ENGAGEMENT_SKIP_FRESH} самых свежих)…`);

        interface ScoredSeed { handle: ChannelHandle; score: number | null }
        const scoredSeeds: ScoredSeed[] = [];
        for (const seed of seedHandles) {
            let score: number | null = null;
            try {
                const posts = await floodAware(() => tg.getRecentPosts(seed.inputChannel, p.postsCount));
                await sleep(pacingMs());
                const medViews = median(engagementSample(posts.map((post) => post.views)));
                if (medViews != null) {
                    const subs = await floodAware(() => tg.getChannelSubscribers(seed.inputChannel));
                    await sleep(pacingMs());
                    if (subs != null && subs > 0) score = medViews / subs;
                }
            } catch (err) {
                if (err instanceof FloodStop) throw err;
                if (err instanceof ClientNotConnectedError) throw err;
                log.info(`[similar] ${searcherId}: вовлечённость seed ${seed.username ?? seed.title} не измерена: ${(err as any)?.message ?? err}`);
            }
            scoredSeeds.push({ handle: seed, score });
        }

        scoredSeeds.sort((a, b) => {
            if (a.score == null && b.score == null) return 0;
            if (a.score == null) return 1;
            if (b.score == null) return -1;
            return b.score - a.score;
        });

        const measured = scoredSeeds.filter((s) => s.score != null).length;
        log.info(`[similar] ${searcherId}: вовлечённость измерена у ${measured}/${scoredSeeds.length}, старт BFS`);

        // Шаг 3: BFS по уровням.
        interface BfsNode { handle: ChannelHandle }
        let frontier: BfsNode[] = scoredSeeds.map((s) => ({ handle: s.handle }));

        while (frontier.length > 0 && shared.totalCollected < shared.goal) {
            const nextFrontier: BfsNode[] = [];

            for (const node of frontier) {
                if (shared.totalCollected >= shared.goal) break;

                let rec: { similar: ChannelHandle[]; totalCount: number; truncated: boolean };
                try {
                    rec = await floodAware(() => tg.getChannelRecommendations(node.handle.inputChannel));
                } catch (err) {
                    if (err instanceof FloodStop) throw err;
                    if (err instanceof ClientNotConnectedError) throw err;
                    log.info(`[similar] ${searcherId}: пропуск узла ${node.handle.username ?? node.handle.title}: ${(err as any)?.message ?? err}`);
                    continue;
                }
                if (rec.truncated) status.sawTruncated = true;
                await sleep(pacingMs());

                for (const cand of rec.similar) {
                    if (shared.totalCollected >= shared.goal) break;

                    const candKey = cand.inputChannel.channelId.toString();
                    if (visited.has(candKey)) continue;
                    visited.add(candKey);

                    if (!cand.username) continue;
                    const canonical = normalizeChannelLink(cand.username);
                    if (isKnownChannel(p.adminAgentId, canonical)) continue;

                    let info: { subscribers: number | null; linkedChatId: string | null; about: string | null };
                    try {
                        info = await floodAware(() => tg.getChannelGateInfo(cand.inputChannel));
                    } catch (err) {
                        if (err instanceof FloodStop) throw err;
                        if (err instanceof ClientNotConnectedError) throw err;
                        log.info(`[similar] ${searcherId}: пропуск кандидата ${cand.username}: ${(err as any)?.message ?? err}`);
                        continue;
                    }
                    await sleep(pacingMs());

                    // Гейт 1 — подписчики.
                    if (info.subscribers == null || info.subscribers < p.minSubscribers) {
                        status.skips.lowSubscribers += 1;
                        continue;
                    }
                    // Гейт 2 — группа обсуждения.
                    if (info.linkedChatId == null) {
                        status.skips.noLinkedChat += 1;
                        continue;
                    }
                    // Гейт 3 — вовлечённость (fail-closed).
                    let posts: ChannelPost[];
                    try {
                        posts = await floodAware(() => tg.getRecentPosts(cand.inputChannel, p.postsCount));
                    } catch (err) {
                        if (err instanceof FloodStop) throw err;
                        if (err instanceof ClientNotConnectedError) throw err;
                        log.info(`[similar] ${searcherId}: пропуск кандидата ${cand.username}: ${(err as any)?.message ?? err}`);
                        continue;
                    }
                    await sleep(pacingMs());

                    const engagement = computeEngagement(posts, info.subscribers);
                    if (engagement == null || engagement.avgViews <= p.minAvgViews || engagement.er <= p.minEngagementRate) {
                        status.skips.lowEngagement += 1;
                        continue;
                    }
                    // Гейт 4 — тематическая релевантность (LLM, fail-closed).
                    const topicResult = await scoreCandidateTopic(p.llm, info, cand, p.theme, posts, log);
                    if (topicResult == null || topicResult.score <= p.minTopicScore) {
                        status.skips.offTopic += 1;
                        continue;
                    }

                    // Регистрация без агента. INSERT OR IGNORE — атомарный деdup.
                    const { inserted } = registerChannel(p.adminAgentId, canonical);
                    if (inserted) {
                        shared.totalCollected += 1;
                        status.collected += 1;
                        nextFrontier.push({ handle: cand });
                        log.info(`[similar] ${searcherId}: +1 «${canonical}» — тема «${topicResult.channelTopic ?? "?"}», score ${topicResult.score.toFixed(2)}, ER ${engagement.er.toFixed(2)} (${shared.totalCollected}/${shared.goal})`);
                    }
                }
            }

            frontier = nextFrontier;
        }
    } catch (err) {
        if (err instanceof FloodStop) {
            status.stoppedByFlood = true;
        } else {
            const msg = (err as any)?.message ?? String(err);
            status.error = msg;
            log.error(`[similar] ${searcherId}: ошибка — ${msg}`);
        }
    } finally {
        await tg.disconnect().catch(() => {});
    }

    return status;
}

/**
 * Фаза 2: читает каналы без агента из реестра, раскладывает round-robin по всем
 * агентам платформы до `target` каждому, ставит в очереди вступления.
 */
function distribute(
    allAgents: string[],
    target: number,
    adminAgentId: string,
    log: Logger,
): Record<string, number> {
    const assigned: Record<string, number> = {};
    for (const a of allAgents) assigned[a] = 0;
    if (allAgents.length === 0) return assigned;

    const pool = getUnassignedChannels(adminAgentId);
    log.info(`[similar] распределение: ${pool.length} каналов в пуле, ${allAgents.length} агентов, target ${target} каждому`);

    let i = 0;
    for (const canonical of pool) {
        let tries = 0;
        while (assigned[allAgents[i]] >= target && tries < allAgents.length) {
            i = (i + 1) % allAgents.length;
            tries += 1;
        }
        if (tries >= allAgents.length) break;

        const agent = allAgents[i];
        const { assigned: ok } = assignChannel(adminAgentId, canonical, agent);
        if (ok) {
            addJoinQueue(agent, [canonical], log);
            assigned[agent] += 1;
        }
        i = (i + 1) % allAgents.length;
    }
    return assigned;
}

/**
 * Прогон: все искатели параллельно (фаза сбора) → фаза распределения по агентам.
 */
export async function runSimilarDiscovery(p: RunSimilarParams, log: Logger): Promise<SimilarRunResult> {
    const goal = p.target * p.allAgents.length;
    const shared: SharedCollectionState = { totalCollected: 0, goal };

    const existingPool = getUnassignedChannels(p.adminAgentId);
    if (existingPool.length > 0) {
        log.warn(`[similar] ⚠️ в реестре ${existingPool.length} канал(ов) без агента — остаток предыдущего прогона; будут распределены вместе с находками этого прогона`);
    }

    log.info(`[similar] === сбор: искатели ${p.searchers.join(",")}, цель ${goal} (target ${p.target} × агентов ${p.allAgents.length}) ===`);

    const statuses = await Promise.all(
        p.searchers.map((searcherId) => runSearcher(searcherId, shared, p, log)),
    );

    const perSearcher: Record<string, SearcherStatus> = Object.fromEntries(
        p.searchers.map((id, i) => [id, statuses[i]]),
    );

    const skips: SkipCounts = { lowSubscribers: 0, noLinkedChat: 0, lowEngagement: 0, offTopic: 0 };
    for (const s of statuses) {
        skips.lowSubscribers += s.skips.lowSubscribers;
        skips.noLinkedChat += s.skips.noLinkedChat;
        skips.lowEngagement += s.skips.lowEngagement;
        skips.offTopic += s.skips.offTopic;
    }
    const sawTruncated = statuses.some((s) => s.sawTruncated);

    log.info(`[similar] собрано ${shared.totalCollected}/${goal} (отсев: подписчики ${skips.lowSubscribers}, нет группы ${skips.noLinkedChat}, вовлечённость ${skips.lowEngagement}, тема ${skips.offTopic}), распределяю по ${p.allAgents.length} агентам платформы…`);

    const distribution = distribute(p.allAgents, p.target, p.adminAgentId, log);

    return {
        collected: shared.totalCollected,
        goal,
        reachedGoal: shared.totalCollected >= goal,
        sawTruncated,
        perSearcher,
        distribution,
        skips,
    };
}

export function renderSimilarReport(r: SimilarRunResult): string {
    const lines: string[] = [];
    const tail = r.reachedGoal ? " (цель достигнута)" : " (граф искателей исчерпан)";
    lines.push(`Discovery (similar) — собрано ${r.collected}/${r.goal}${tail}`);

    lines.push("");
    lines.push("Искатели:");
    lines.push("  Имя            | Найдено | Подпис. | Нет группы | Вовлечён. | Тема | Статус");
    lines.push("  " + "-".repeat(74));

    let totFound = 0, totSubs = 0, totChat = 0, totEng = 0, totTopic = 0;

    for (const [id, s] of Object.entries(r.perSearcher)) {
        totFound += s.collected;
        totSubs += s.skips.lowSubscribers;
        totChat += s.skips.noLinkedChat;
        totEng += s.skips.lowEngagement;
        totTopic += s.skips.offTopic;

        let statusStr = "OK";
        if (s.error) statusStr = `ошибка: ${s.error.slice(0, 35)}`;
        else if (s.stoppedByFlood) statusStr = "прерван FLOOD_WAIT";

        const name = id.padEnd(14);
        lines.push(
            `  ${name} | ${String(s.collected).padStart(7)} | ${String(s.skips.lowSubscribers).padStart(7)} | ` +
            `${String(s.skips.noLinkedChat).padStart(10)} | ${String(s.skips.lowEngagement).padStart(9)} | ` +
            `${String(s.skips.offTopic).padStart(4)} | ${statusStr}`,
        );
    }

    lines.push("  " + "-".repeat(74));
    const totName = "ИТОГО".padEnd(14);
    lines.push(
        `  ${totName} | ${String(totFound).padStart(7)} | ${String(totSubs).padStart(7)} | ` +
        `${String(totChat).padStart(10)} | ${String(totEng).padStart(9)} | ` +
        `${String(totTopic).padStart(4)} |`,
    );

    if (r.sawTruncated) {
        lines.push("");
        lines.push("⚠️ некоторые выдачи рекомендаций усечены (нет Premium у аккаунта)");
    }

    lines.push("");
    lines.push("Распределение по агентам:");
    const placed = Object.entries(r.distribution).filter(([, n]) => n > 0);
    if (placed.length === 0) {
        lines.push("• новых каналов не поставлено");
    } else {
        for (const [agent, n] of placed) lines.push(`• ${agent}: +${n}`);
    }
    return lines.join("\n");
}
