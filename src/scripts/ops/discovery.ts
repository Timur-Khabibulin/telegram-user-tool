// scripts/ops/discovery.ts — запуск прогона channel-discovery вручную / из таймера.
//
// Тонкая обёртка над features/discovery/run: парсит аргументы, запускает прогон,
// печатает отчёт. Та же логика доступна интерактивно тулом discovery_run.
// Вступление НЕ запускаем — его инициирует per-agent таймер join-queue.
//
// Запуск: tsx discovery.ts --keywords "психология,терапия" --n 200 \
//           --min-subs 1000 [--min-avg-reach 500] [--admin agent1] [--agents a,b]

import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID, listAgentIds, TGSTAT_API_TOKEN } from "../../core/config";
import { runDiscovery, renderReport } from "../../features/discovery/run";
import { TelegramService } from "../../core/telegram/service";

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
    const keywords = parseList(argv, "--keywords");
    const target = Number(parseArg(argv, "--n"));
    const minSubscribers = Number(parseArg(argv, "--min-subs"));
    const agentsArg = parseList(argv, "--agents");
    const agents = agentsArg.length > 0 ? agentsArg : listAgentIds();
    const minAvgReach = parseArg(argv, "--min-avg-reach");
    const avgReachAgent = parseArg(argv, "--avg-reach-agent");

    if (keywords.length === 0 || !Number.isFinite(target) || target <= 0
        || !Number.isFinite(minSubscribers)) {
        log.error("[discovery] usage: --keywords a,b --n <N> --min-subs <n> [--min-avg-reach <n>] [--avg-reach-agent <agentId>] [--admin agent1] [--agents a,b]");
        process.exit(1);
    }
    if (agents.length === 0) {
        log.error("[discovery] нет агентов для раскладки (listAgentIds() пуст и --agents не задан)");
        process.exit(1);
    }
    if (!TGSTAT_API_TOKEN || TGSTAT_API_TOKEN === "STUB_TGSTAT_TOKEN") {
        log.error("[discovery] TGSTAT_TOKEN не задан в env — экспортируй реальный токен перед запуском");
        process.exit(1);
    }

    // MTProto fallback: создаём сервис и загружаем аккаунт если задан --avg-reach-agent (D5).
    let telegramService: TelegramService | undefined;
    if (avgReachAgent) {
        telegramService = new TelegramService(log);
        telegramService.loadAccount(avgReachAgent);
    }

    const minAvgPostReach = minAvgReach != null ? Number(minAvgReach) : undefined;
    log.info(`[discovery] start — keywords=${keywords.length} N=${target} minSubs=${minSubscribers}${minAvgPostReach != null ? ` minAvgReach=${minAvgPostReach}` : ""}${avgReachAgent ? ` avgReachAgent=${avgReachAgent}` : ""} agents=${agents.join(",")}`);

    try {
        const result = await runDiscovery({ keywords, target, minSubscribers, minAvgPostReach, avgReachAgentId: avgReachAgent, telegramService, adminAgentId, agents, tgstatToken: TGSTAT_API_TOKEN }, log);
        log.info(`[discovery] done — collected=${result.collected} perAgent=${JSON.stringify(result.perAgent)}`);
        console.log("\n" + renderReport(result) + "\n");
    } finally {
        if (telegramService) await telegramService.disconnect();
    }
}

main().catch((err) => {
    log.error(`[discovery] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
