// scripts/ops/tg-agent-autoregistration-retry-code.ts — ретрай второй сессии для
// аккаунта в статусе needs_manual_code, без повторной подготовки аккаунта.
//
// Запуск: tsx tg-agent-autoregistration-retry-code.ts --agent-id agent220 \
//           --person-name maria --proxy-region us --max-proxy-attempts 5

import type { Logger } from "../../core/logger";
import { retryManualCode } from "../../features/tg-agent-autoregistration/run";

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

    const agentId = parseArg(argv, "--agent-id");
    const personName = parseArg(argv, "--person-name");
    const proxyRegion = parseArg(argv, "--proxy-region");
    const maxProxyAttempts = Number(parseArg(argv, "--max-proxy-attempts"));

    if (!agentId || !personName || !proxyRegion || !Number.isFinite(maxProxyAttempts)) {
        log.error(
            "[tg-agent-autoregistration-retry-code] usage: --agent-id <id> --person-name <name> " +
                "--proxy-region <region> --max-proxy-attempts <n>",
        );
        process.exit(1);
    }

    const result = await retryManualCode(agentId, personName, proxyRegion, maxProxyAttempts, log);
    console.log(JSON.stringify(result));
}

main().catch((err) => {
    log.error(`[tg-agent-autoregistration-retry-code] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
