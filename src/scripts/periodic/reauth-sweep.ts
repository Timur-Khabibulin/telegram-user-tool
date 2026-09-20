// scripts/periodic/reauth-sweep.ts — суточный кросс-агентный свип авто-реавторизации
// агентов с ограничением need_update_session (change auto-reauth-sweep). Зеркало
// src/scripts/periodic/channel-rotation.ts по структуре запуска, но async (внутри —
// реавторизация через MTProto/tdata).
//
// Oneshot, запускается systemd-таймером раз в сутки, с отступом от leave-banned/
// channel-rotation (отправки кода не в пик). Наблюдаемость — только эти логи.
// Запуск: `tsx reauth-sweep.ts [--admin <agentId>]`.

import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { runReauthSweep } from "../../features/agent-reauth-sweep/run";

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

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const adminAgentId = parseArg(argv, "--admin") ?? FUNNEL_ADMIN_AGENT_ID;
    await runReauthSweep(log, adminAgentId);
}

// Принудительный выход: реавторизация оставляет висящие GramJS-клиенты (ушедшие в
// reconnect на таймауте прокси не гасят _updateLoop даже после disconnect()), их
// таймеры/сокеты держат event loop живым и без exit() процесс зависает навсегда.
main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[agent-reauth-sweep] fatal: ${err?.message ?? err}`);
        if (err?.stack) log.error(`[agent-reauth-sweep] stack: ${err.stack}`);
        process.exit(1);
    });
