// scripts/ops/private-invite-links.ts — запуск private-invite-links отсоединённым
// фоновым процессом (change detached-reauth-and-invite-links).
//
// Тонкая обёртка над features/private-invite-links/run — парсит аргументы, запускает
// прогон одним TelegramService (та же логика, что у тула tg_private_invite_links в
// index.ts), доставляет отчёт в Saved Messages REPORT_AGENT_ID и принудительно
// завершает процесс. Batch по N агентов пробивает per-tool-call watchdog runtime
// агента, поэтому операторский путь идёт detached через systemd-run поверх этого скрипта.
//
// Запуск: tsx private-invite-links.ts --agent-ids agent4,agent7
//         tsx private-invite-links.ts --retry-pending-only
//         tsx private-invite-links.ts --verify-only [--agent-ids agent4,agent7]

import type { Logger } from "../../core/logger";
import { runPrivateInviteLinks } from "../../features/private-invite-links/run";
import { TelegramService } from "../../core/telegram/service";
import { REPORT_AGENT_ID } from "../../core/config";

const log: Logger = {
    info: (m) => console.error(m),
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

async function deliverReport(tg: TelegramService, text: string): Promise<void> {
    // Доставка отчёта в Saved Messages получателя отчётов (REPORT_AGENT_ID) — тот же
    // адресат, что у daily-summary/funnel/автpрега. Переиспользуем тот же сервис
    // (loadAccount переключает аккаунт). Сбой доставки логируем, но не роняем результат.
    try {
        tg.loadAccount(REPORT_AGENT_ID);
        await tg.sendSavedMessage(text);
        log.info(`[private-invite-links] отчёт отправлен в Saved Messages ${REPORT_AGENT_ID}`);
    } catch (err: any) {
        log.error(
            `[private-invite-links] не удалось доставить отчёт в Saved Messages ${REPORT_AGENT_ID}: ${err?.message ?? err}`,
        );
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const agentIdsRaw = parseArg(argv, "--agent-ids");
    const retryPendingOnly = argv.includes("--retry-pending-only");
    const verifyOnly = argv.includes("--verify-only");
    const agentIds = agentIdsRaw ? agentIdsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

    if (retryPendingOnly && verifyOnly) {
        log.error("[private-invite-links] --retry-pending-only и --verify-only нельзя использовать одновременно");
        process.exit(1);
    }
    if (!retryPendingOnly && !verifyOnly && (!agentIds || agentIds.length === 0)) {
        log.error(
            "[private-invite-links] usage: --agent-ids <a,b,c> | --retry-pending-only | --verify-only [--agent-ids <a,b,c>]",
        );
        process.exit(1);
    }

    const mode = verifyOnly ? "verify" : retryPendingOnly ? "retry-pending" : "run";
    log.info(`[private-invite-links] start — mode=${mode} agentIds=${agentIds?.join(",") ?? "—"}`);

    const tg = new TelegramService(log);
    try {
        // Отчёт доставляется при ЛЮБОМ исходе, включая непредвиденное исключение из
        // прогона: оборачиваем так, чтобы сбой всё равно ушёл в Saved Messages с
        // текстом ошибки, а не потерялся молча.
        let reportText: string;
        try {
            const result = await runPrivateInviteLinks({ agentIds, retryPendingOnly, verifyOnly }, tg, log);
            reportText = result.text;
        } catch (err: any) {
            reportText = `private-invite-links — прогон упал с ошибкой: ${err?.message ?? err}`;
        }
        console.log("\n" + reportText + "\n");
        await deliverReport(tg, reportText);
    } finally {
        await tg.disconnect().catch(() => {});
    }
}

// Принудительный выход после завершения: прогон оставляет висящие GramJS-клиенты
// (ушедшие в reconnect на таймауте прокси не гасят свой _updateLoop даже после
// disconnect()), их таймеры/сокеты держат event loop живым и без exit() процесс
// зависает навсегда (в detached-запуске убивать watchdog'ом некому). Отчёт уже
// отправлен внутри main().
main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[private-invite-links] fatal: ${err?.message ?? err}`);
        process.exit(1);
    });
