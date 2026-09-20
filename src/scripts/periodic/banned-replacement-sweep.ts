// scripts/periodic/banned-replacement-sweep.ts — суточный кросс-агентный sweep
// авто-замены забаненных аккаунтов из пула (banned-account-replacement). Зеркало
// src/scripts/periodic/reauth-sweep.ts по структуре запуска: oneshot, async
// (внутри — MTProto: валидация пул-аккаунта и активация под персону).
//
// Один прогон совмещает две фазы (исполнение назревших отложенных переходов и
// замену забаненных). Запускается systemd-таймером раз в сутки. Наблюдаемость —
// только эти логи (плюс алерт «пул пуст» в Saved Messages report-агента).
// Запуск: `tsx banned-replacement-sweep.ts [--admin <agentId>]`.

import type { Logger } from "../../core/logger";
import { FUNNEL_ADMIN_AGENT_ID } from "../../core/config";
import { runBannedReplacementSweep } from "../../features/banned-account-replacement/run";

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
    await runBannedReplacementSweep(log, adminAgentId);
}

// Принудительный выход: активация оставляет висящие GramJS-клиенты (их таймеры/сокеты
// держат event loop живым), без exit() процесс зависает — как в reauth-sweep.
main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[banned-replacement] fatal: ${err?.message ?? err}`);
        if (err?.stack) log.error(`[banned-replacement] stack: ${err.stack}`);
        process.exit(1);
    });
