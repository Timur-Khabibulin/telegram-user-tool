// scripts/ops/tg-agent-autoregistration.ts — запуск tg-agent-autoregistration вручную / из скилла.
//
// Тонкая обёртка над features/tg-agent-autoregistration/run — парсит аргументы, запускает
// прогон, печатает отчёт. Та же логика доступна интерактивно тулом
// tg_agent_autoregistration_run (index.ts).
//
// Запуск: tsx tg-agent-autoregistration.ts --links "https://mega.nz/...,https://drive.google.com/file/d/.../view" \
//           --two-fa-password "<pass>" --start-agent-number 40 --proxy-region us --max-proxy-attempts 5 --person-name maria

import type { Logger } from "../../core/logger";
import { runAutoregistration, renderReport } from "../../features/tg-agent-autoregistration/run";
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

async function main(): Promise<void> {
    const argv = process.argv.slice(2);

    const linksRaw = parseArg(argv, "--links");
    const twoFaPassword = parseArg(argv, "--two-fa-password");
    const startAgentNumber = Number(parseArg(argv, "--start-agent-number"));
    const proxyRegion = parseArg(argv, "--proxy-region");
    const maxProxyAttempts = Number(parseArg(argv, "--max-proxy-attempts"));
    const personName = parseArg(argv, "--person-name");
    // Дефолт true = mode B (как раньше). Явно --create-public-channel false → mode A (без канала).
    const createPublicChannel = parseArg(argv, "--create-public-channel") !== "false";

    const links = linksRaw ? linksRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

    if (links.length === 0 || !twoFaPassword || !Number.isFinite(startAgentNumber) || !proxyRegion
        || !Number.isFinite(maxProxyAttempts) || !personName) {
        log.error(
            "[tg-agent-autoregistration] usage: --links <url,url,...> --two-fa-password <pass> " +
                "--start-agent-number <n> --proxy-region <region> --max-proxy-attempts <n> --person-name <name> " +
                "[--create-public-channel true|false]",
        );
        process.exit(1);
    }

    log.info(
        `[tg-agent-autoregistration] start — accounts=${links.length} startAgentNumber=${startAgentNumber} ` +
            `proxyRegion=${proxyRegion} maxProxyAttempts=${maxProxyAttempts} personName=${personName}`,
    );

    const report = await runAutoregistration(
        { links, twoFaPassword, createPublicChannel, startAgentNumber, proxyRegion, maxProxyAttempts, personName },
        log,
    );
    const reportText = renderReport(report);
    console.log("\n" + reportText + "\n");

    // Доставка итога в Saved Messages получателя отчётов (REPORT_AGENT_ID) — тот
    // же адресат, что у daily-summary. Прогон уже завершён и статусы записаны в
    // стейджинг; сбой доставки логируем, но не роняем результат.
    try {
        const tg = new TelegramService(log);
        tg.loadAccount(REPORT_AGENT_ID);
        try {
            await tg.sendSavedMessage(reportText);
            log.info(`[tg-agent-autoregistration] отчёт отправлен в Saved Messages ${REPORT_AGENT_ID}`);
        } finally {
            await tg.disconnect();
        }
    } catch (err: any) {
        log.error(
            `[tg-agent-autoregistration] не удалось доставить отчёт в Saved Messages ${REPORT_AGENT_ID}: ${err?.message ?? err}`,
        );
    }
}

// Принудительный выход после завершения: прогон оставляет висящие GramJS-клиенты
// (ушедшие в reconnect на таймауте прокси не гасят свой _updateLoop даже после
// disconnect()), их таймеры/сокеты держат event loop живым и без exit() процесс
// зависает навсегда, съедая память (в detached-запуске убивать watchdog'ом
// некому). Отчёт уже отправлен внутри main().
main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[tg-agent-autoregistration] fatal: ${err?.message ?? err}`);
        process.exit(1);
    });
