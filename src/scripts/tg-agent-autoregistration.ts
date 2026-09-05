// scripts/tg-agent-autoregistration.ts — запуск tg-agent-autoregistration вручную / из скилла.
//
// Тонкая обёртка над core/tg-agent-autoregistration/run — парсит аргументы, запускает
// прогон, печатает отчёт. Та же логика доступна интерактивно тулом
// tg_agent_autoregistration_run (index.ts).
//
// Запуск: tsx tg-agent-autoregistration.ts --mega-links "https://mega.nz/...,https://mega.nz/..." \
//           --start-agent-number 40 --proxy-region us --max-proxy-attempts 5 --person-name maria

import type { Logger } from "../core/logger";
import { runAutoregistration, renderReport } from "../core/tg-agent-autoregistration/run";

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

    const megaLinksRaw = parseArg(argv, "--mega-links");
    const startAgentNumber = Number(parseArg(argv, "--start-agent-number"));
    const proxyRegion = parseArg(argv, "--proxy-region");
    const maxProxyAttempts = Number(parseArg(argv, "--max-proxy-attempts"));
    const personName = parseArg(argv, "--person-name");

    const megaLinks = megaLinksRaw ? megaLinksRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

    if (megaLinks.length === 0 || !Number.isFinite(startAgentNumber) || !proxyRegion
        || !Number.isFinite(maxProxyAttempts) || !personName) {
        log.error(
            "[tg-agent-autoregistration] usage: --mega-links <url,url,...> --start-agent-number <n> " +
                "--proxy-region <region> --max-proxy-attempts <n> --person-name <name>",
        );
        process.exit(1);
    }

    log.info(
        `[tg-agent-autoregistration] start — accounts=${megaLinks.length} startAgentNumber=${startAgentNumber} ` +
            `proxyRegion=${proxyRegion} maxProxyAttempts=${maxProxyAttempts} personName=${personName}`,
    );

    const report = await runAutoregistration(
        { megaLinks, startAgentNumber, proxyRegion, maxProxyAttempts, personName },
        log,
    );
    console.log("\n" + renderReport(report) + "\n");
}

main().catch((err) => {
    log.error(`[tg-agent-autoregistration] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
