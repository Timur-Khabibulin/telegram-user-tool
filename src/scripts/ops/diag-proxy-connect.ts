// scripts/ops/diag-proxy-connect.ts — разовая диагностика: почему процесс молча падает при
// подключении через dedicated-порт asocks. Ловит uncaughtException/unhandledRejection,
// которые обычный try/catch в ensureClient не видит, если сокет-слой бросает необработанно.
//
// Запуск ТОЛЬКО на забаненном/ограниченном агенте (не трогает живые сессии):
//   tsx src/scripts/ops/diag-proxy-connect.ts --agent agent1799

import { TelegramService } from "../../core/telegram/service";
import { loadAccountConfig } from "../../core/config";
import { createMobileProxy, deleteProxyByName } from "../../features/proxy/asocks-client";

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const log = {
    info: (m: string) => console.log(ts(), "[diag]", m),
    warn: (m: string) => console.warn(ts(), "[diag]", m),
    error: (m: string) => console.error(ts(), "[diag]", m),
};

process.on("uncaughtException", (err) => {
    console.error(ts(), "=== UNCAUGHT EXCEPTION ===");
    console.error(err?.stack ?? err);
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.error(ts(), "=== UNHANDLED REJECTION ===");
    console.error(reason);
    process.exit(1);
});
process.on("exit", (code) => {
    console.error(ts(), `=== process 'exit' event, code=${code} ===`);
});
process.on("beforeExit", (code) => {
    console.error(ts(), `=== process 'beforeExit' event, code=${code} (event loop drained) ===`);
});
setInterval(() => console.log(ts(), "heartbeat, active handles:", (process as any)._getActiveHandles().length), 2000).unref();

async function main() {
    const argv = process.argv.slice(2);
    const idx = argv.indexOf("--agent");
    const agentId = idx !== -1 ? argv[idx + 1] : undefined;
    if (!agentId) throw new Error("Usage: --agent <agentId>");

    const apiKey = process.env.ASOCKS_API_KEY;
    if (!apiKey) throw new Error("ASOCKS_API_KEY not set");

    const tg = new TelegramService(log as any);
    tg.loadAccount(agentId);
    const account = loadAccountConfig(agentId);
    const country = account.proxy?.countryCode ?? "US";
    const state = account.proxy?.state;
    const city = account.proxy?.city;

    log.info(`creating dedicated candidate for ${agentId} (${country}/${state}/${city})`);
    const created = await createMobileProxy(apiKey, `tg-diag-${agentId}-1`, country, state, city, log as any);
    log.info(`created: ${JSON.stringify(created)}`);

    try {
        log.info("attempting verifyConnection with 20s timeout, 1 attempt...");
        await tg.verifyConnection({
            proxy: {
                type: "socks5",
                host: created.host,
                port: created.port,
                username: created.username,
                password: created.password,
            },
            maxAttempts: 1,
            connectTimeoutMs: 20_000,
        });
        log.info("SUCCESS — connected through dedicated proxy");
    } catch (err: any) {
        log.error(`verifyConnection threw (caught normally): ${err?.constructor?.name} — ${err?.message ?? err}`);
        console.error(err?.stack ?? err);
    } finally {
        await deleteProxyByName(apiKey, created.name, log as any).catch((e: any) =>
            log.warn(`cleanup failed: ${e.message ?? e}`),
        );
        await tg.disconnect();
    }

    log.info("done, exiting cleanly");
    process.exit(0);
}

main().catch((err) => {
    console.error("=== main() rejected ===");
    console.error(err?.stack ?? err);
    process.exit(1);
});
