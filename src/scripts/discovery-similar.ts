// scripts/discovery-similar.ts — запуск обхода похожих каналов вручную.
//
// Тонкая обёртка над core/discovery/similar: парсит аргументы, запускает прогон
// последовательно по агентам (каждый на своей сессии), печатает отчёт. Вступление
// НЕ запускаем — его инициирует per-agent таймер join-queue. Без LLM.
//
// Запуск: tsx discovery-similar.ts --min-subs 1000 --target 50 --agents a,b --theme "крипта"
//   --min-avg-views 200 [--admin agent1] [--min-topic-score 0.5] [--posts-count 20] [--min-er 0.1]
// --agents — искатели (кто обходит); цель прогона = target × число агентов платформы (listAgentIds).
// --theme — тематика прогона (единая на все агенты) для тематического гейта кандидатов.
// --min-avg-views — обязателен: порог среднего просмотра на пост кандидата (зависит от ниши/языка).
// --posts-count — окно последних постов канала, общее для вовлечённости (Гейт 3) и темы (Гейт 4).

const DEFAULT_MIN_TOPIC_SCORE = 0.5;
const DEFAULT_POSTS_COUNT = 20;
const DEFAULT_MIN_ENGAGEMENT_RATE = 0.1;

import type { Logger } from "../core/logger";
import { FUNNEL_ADMIN_AGENT_ID, listAgentIds } from "../core/config";
import { runSimilarDiscovery, renderSimilarReport } from "../core/discovery/similar";
import { createLlmClient } from "../llm/client";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

function parseList(argv: string[], flag: string): string[] {
    const raw = parseArg(argv, flag);
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);

    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;
    const minSubscribers = Number(parseArg(argv, "--min-subs"));
    const target = Number(parseArg(argv, "--target"));
    const topicScoreArg = parseArg(argv, "--min-topic-score");
    const minTopicScore = topicScoreArg !== undefined ? Number(topicScoreArg) : DEFAULT_MIN_TOPIC_SCORE;
    const postsCountArg = parseArg(argv, "--posts-count");
    const postsCount = postsCountArg !== undefined ? Number(postsCountArg) : DEFAULT_POSTS_COUNT;
    const minErArg = parseArg(argv, "--min-er");
    const minEngagementRate = minErArg !== undefined ? Number(minErArg) : DEFAULT_MIN_ENGAGEMENT_RATE;
    const minAvgViews = Number(parseArg(argv, "--min-avg-views"));
    const theme = parseArg(argv, "--theme")?.trim() ?? "";
    const searchers = parseList(argv, "--agents");
    const allAgents = listAgentIds();

    if (!Number.isFinite(minSubscribers) || minSubscribers < 0
        || !Number.isFinite(target) || target <= 0
        || !Number.isFinite(minTopicScore) || minTopicScore < 0 || minTopicScore >= 1
        || !Number.isFinite(postsCount) || postsCount <= 2
        || !Number.isFinite(minEngagementRate) || minEngagementRate < 0
        || !Number.isFinite(minAvgViews) || minAvgViews < 0) {
        log.error("[discovery-similar] usage: --min-subs <n> --target <n> --agents a,b --theme \"<тема>\" --min-avg-views <n> [--admin agent1] [--min-topic-score 0.5] [--posts-count 20] [--min-er 0.1]");
        process.exit(1);
    }
    if (theme.length === 0) {
        log.error("[discovery-similar] не задана тема (--theme \"<тема>\" обязателен)");
        process.exit(1);
    }
    if (searchers.length === 0) {
        log.error("[discovery-similar] не заданы искатели (--agents a,b обязателен)");
        process.exit(1);
    }
    if (allAgents.length === 0) {
        log.error("[discovery-similar] нет агентов платформы для распределения (listAgentIds() пуст)");
        process.exit(1);
    }

    log.info(`[discovery-similar] start — minSubs=${minSubscribers} target=${target} minTopicScore=${minTopicScore} postsCount=${postsCount} minEngagementRate=${minEngagementRate} minAvgViews=${minAvgViews} theme="${theme}" searchers=${searchers.join(",")} agents=${allAgents.length}`);

    const llm = createLlmClient();
    const result = await runSimilarDiscovery({ minSubscribers, target, adminAgentId, searchers, allAgents, theme, minTopicScore, postsCount, minEngagementRate, minAvgViews, llm }, log);
    log.info(`[discovery-similar] done — collected=${result.collected}/${result.goal}`);
    console.log("\n" + renderSimilarReport(result) + "\n");
}

main().catch((err) => {
    log.error(`[discovery-similar] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
