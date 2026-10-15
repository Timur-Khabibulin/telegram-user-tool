// scripts/ops/tg-agent-reserve-activate.ts — ручная активация аккаунта резерва (триггер 2)
// отсоединённым фоновым процессом (persona-account-reserve §8). Тонкая обёртка над
// features/persona-account-reserve/activate:runReserveActivate.
//
// Detached-исполнение (ADR 0008): один аккаунт — фиксированный бюджет (валидация
// подключением + claim + финализация), образец ops/tg-agent-reauth-from-tdata.ts. Скрипт
// держит собственный жёсткий таймаут + process.exit и доставляет исход в Saved Messages
// REPORT_AGENT_ID. Та же логика доступна тулом tg_agent_reserve_activate для коротких
// ручных вызовов.
//
// Запуск: tsx tg-agent-reserve-activate.ts --reserve-id reserve-maria-3 [--admin agent1]

import type { Logger } from "../../core/logger";
import { runReserveActivate, renderActivateResult } from "../../features/persona-account-reserve/activate";
import { TelegramService } from "../../core/telegram/service";
import { REPORT_AGENT_ID, FUNNEL_ADMIN_AGENT_ID } from "../../core/config";

const log: Logger = {
    info: (m) => console.error(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

// Жёсткий таймаут одного аккаунта (ADR 0008): валидация подключением + claim + финализация.
const HARD_TIMEOUT_MS = 10 * 60 * 1000;

function armHardTimeout(): void {
    const hardTimeout = setTimeout(() => {
        log.error(`[tg-agent-reserve-activate] fatal: превышен жёсткий таймаут ${HARD_TIMEOUT_MS}ms — принудительный выход`);
        process.exit(1);
    }, HARD_TIMEOUT_MS);
    hardTimeout.unref();
}

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

async function deliverReport(text: string): Promise<void> {
    try {
        const tg = new TelegramService(log);
        tg.loadAccount(REPORT_AGENT_ID);
        try {
            await tg.sendSavedMessage(text);
            log.info(`[tg-agent-reserve-activate] отчёт отправлен в Saved Messages ${REPORT_AGENT_ID}`);
        } finally {
            await tg.disconnect();
        }
    } catch (err: any) {
        log.error(`[tg-agent-reserve-activate] не удалось доставить отчёт в Saved Messages ${REPORT_AGENT_ID}: ${err?.message ?? err}`);
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const reserveId = parseArg(argv, "--reserve-id");
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;

    if (!reserveId) {
        log.error("[tg-agent-reserve-activate] usage: --reserve-id <reserve-<persona>-<K>> [--admin <agentId>]");
        process.exit(1);
    }

    log.info(`[tg-agent-reserve-activate] start — reserveId=${reserveId} admin=${adminAgentId}`);
    armHardTimeout();

    // Исход доставляется при любом результате, включая непредвиденное исключение.
    let reportText: string;
    try {
        const result = await runReserveActivate(reserveId, adminAgentId, log);
        reportText = renderActivateResult(result);
    } catch (err: any) {
        reportText = `tg-agent-reserve-activate — ${reserveId}: error — непредвиденная ошибка: ${err?.message ?? err}`;
    }
    console.log("\n" + reportText + "\n");
    await deliverReport(reportText);
}

// Принудительный выход после завершения: активация валидирует аккаунт подключением
// (GramJS-клиент может уйти в reconnect и держать event loop живым) — без exit() процесс
// зависает, в detached-запуске убивать watchdog'ом некому. Отчёт уже отправлен в main().
main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[tg-agent-reserve-activate] fatal: ${err?.message ?? err}`);
        process.exit(1);
    });
