// scripts/leave-all-channels.ts — разовый массовый выход всех агентов из всех
// каналов/супергрупп (leaveChannelByHandle, не требует peerCache/get_dialogs).
//
// Пауза между выходами внутри одного агента (как account-warmup.ts) + повтор
// FLOOD_WAIT через withFloodRetry — исчерпание ретраев прерывает только текущего
// агента, не весь прогон. Агенты обрабатываются пулом ограниченной параллельности
// (--concurrency) — независимые Telegram-сессии, пауза внутри агента не мешает
// остальным идти одновременно.
// Локальные БД (channels/replies/dm-threads) не трогаем — join-queue уже
// отключена отдельно (scheduler-control), очередь/история остаются как есть.
//
// Запуск: tsx src/scripts/leave-all-channels.ts [--agent <agentId>]
//   [--delay-min-seconds 5] [--delay-max-seconds 10] [--concurrency 15]

import type { Logger } from "../core/logger";
import { formatError } from "../core/errors";
import { TelegramService } from "../core/telegram/service";
import { ClientNotConnectedError, SessionRevokedError, AccountBannedError } from "../core/telegram/errors";
import { listAgentIds, REPORT_AGENT_ID } from "../core/config";
import { withTimeout } from "../features/funnel/funnel-collect";
import { sleep, randomDelayMs, FloodAbortError, withFloodRetry } from "../skills/util";

// "Немой" зависший прокси не рвёт соединение ошибкой и не подчиняется таймауту
// ensureClient (тот бьётся только за сам connect) — MTProto-вызов после коннекта
// может висеть бесконечно. Жёсткий потолок на операцию освобождает слот пула, даже
// если исходный промис так и не разрешится (висит недисконнекченным — не страшно,
// это отдельная TelegramService на агента, процесс просто идёт дальше).
const OP_TIMEOUT_MS = 90_000;

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

interface AgentResult {
    agentId: string;
    total: number;
    left: number;
    failed: number;
    error?: string;
}

async function processAgent(
    agentId: string,
    delayMinSec: number,
    delayMaxSec: number,
    checkOnly: boolean,
): Promise<AgentResult> {
    // По требованию — пытаться выйти несмотря на любое ограничение (banned/suspend/
    // need_update_session): реально мёртвая сессия всё равно упадёт на connect
    // (SessionRevokedError/AccountBannedError, ловится ниже), а "suspend" (например
    // channels_banned) может по-прежнему иметь рабочую сессию, которой есть из чего выходить.
    const tg = new TelegramService(log);
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { agentId, total: 0, left: 0, failed: 0, error: `load_account: ${formatError(err)}` };
    }

    let channels;
    let basicGroups;
    try {
        channels = await withTimeout(tg.listDialogChannels(), OP_TIMEOUT_MS, `list channels agent=${agentId}`);
        basicGroups = await withTimeout(tg.listDialogBasicGroups(), OP_TIMEOUT_MS, `list basic groups agent=${agentId}`);
    } catch (err: any) {
        if (err instanceof SessionRevokedError || err instanceof AccountBannedError) {
            return { agentId, total: 0, left: 0, failed: 0, error: `account: ${formatError(err)}` };
        }
        return { agentId, total: 0, left: 0, failed: 0, error: `list_dialogs: ${formatError(err)}` };
    }

    const total = channels.length + basicGroups.length;
    log.info(
        `[leave-all] agent=${agentId} — ${channels.length} канал(ов)/супергрупп(ы) + ${basicGroups.length} базовых групп в диалогах`,
    );

    if (checkOnly) {
        await tg.disconnect();
        return { agentId, total, left: 0, failed: 0 };
    }

    let left = 0;
    let failed = 0;

    type LeaveItem = { chatId: string; title: string; leave: () => Promise<{ ok: true }> };
    const items: LeaveItem[] = [
        ...channels.map((ch) => ({ chatId: ch.chatId, title: ch.title, leave: () => tg.leaveChannelByHandle(ch.inputChannel) })),
        ...basicGroups.map((g) => ({ chatId: g.chatId, title: g.title, leave: () => tg.leaveBasicGroup(g.chatId) })),
    ];

    for (const item of items) {
        try {
            await withTimeout(withFloodRetry(() => item.leave(), log), OP_TIMEOUT_MS, `leave chatId=${item.chatId} agent=${agentId}`);
            left += 1;
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                log.error(`[leave-all] agent=${agentId} — повторный FLOOD_WAIT, прерываю агента (${left}/${total} покинуто)`);
                break;
            }
            if (err instanceof SessionRevokedError || err instanceof AccountBannedError) {
                log.error(`[leave-all] agent=${agentId} — аккаунт: ${formatError(err)}, прерываю агента`);
                break;
            }
            if (err instanceof ClientNotConnectedError) {
                log.error(`[leave-all] agent=${agentId} — соединение потеряно: ${formatError(err)}, прерываю агента`);
                break;
            }
            log.warn(`[leave-all] agent=${agentId} — не удалось выйти из chatId=${item.chatId} (${item.title}): ${formatError(err)}`);
            failed += 1;
        }
        await sleep(randomDelayMs(delayMinSec, delayMaxSec));
    }

    await tg.disconnect();
    return { agentId, total, left, failed };
}

/** Пул ограниченной параллельности: не более `concurrency` агентов одновременно. */
async function runPool(
    agents: string[],
    concurrency: number,
    delayMinSec: number,
    delayMaxSec: number,
    checkOnly: boolean,
): Promise<AgentResult[]> {
    const results: AgentResult[] = new Array(agents.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        for (;;) {
            const i = nextIndex++;
            if (i >= agents.length) return;
            const agentId = agents[i];
            log.info(`[leave-all] === агент ${i + 1}/${agents.length}: ${agentId} ===`);
            const res = await processAgent(agentId, delayMinSec, delayMaxSec, checkOnly);
            results[i] = res;
            log.info(
                `[leave-all] agent=${agentId} итог — всего=${res.total} покинуто=${res.left} ошибок=${res.failed}${res.error ? ` (${res.error})` : ""}`,
            );
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, agents.length) }, () => worker()));
    return results;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const onlyAgent = parseArg(argv, "--agent");
    const delayMinSec = Number(parseArg(argv, "--delay-min-seconds") ?? 5);
    const delayMaxSec = Number(parseArg(argv, "--delay-max-seconds") ?? 10);
    const concurrency = Number(parseArg(argv, "--concurrency") ?? 15);
    const checkOnly = argv.includes("--check-only");

    const agents = onlyAgent
        ? onlyAgent.split(",").map((a) => a.trim()).filter(Boolean)
        : listAgentIds().filter((a) => a !== REPORT_AGENT_ID);
    log.info(`[leave-all] агентов к обработке: ${agents.length}, параллельность: ${concurrency}${checkOnly ? ", режим: только проверка" : ""}`);

    const results = await runPool(agents, concurrency, delayMinSec, delayMaxSec, checkOnly);

    const totals = results.reduce(
        (acc, r) => ({ total: acc.total + r.total, left: acc.left + r.left, failed: acc.failed + r.failed }),
        { total: 0, left: 0, failed: 0 },
    );
    const skipped = results.filter((r) => r.error && r.total === 0).length;
    const remaining = results.filter((r) => r.total > 0).map((r) => `${r.agentId}=${r.total}`);
    log.info(
        `[leave-all] ГОТОВО — агентов=${agents.length}, пропущено=${skipped}, каналов всего=${totals.total}, покинуто=${totals.left}, ошибок выхода=${totals.failed}`,
    );
    if (checkOnly) {
        log.info(`[leave-all] ПРОВЕРКА — агентов с непустыми диалогами: ${remaining.length}: ${remaining.join(", ")}`);
    }
}

main().catch((err) => {
    log.error(`[leave-all] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
