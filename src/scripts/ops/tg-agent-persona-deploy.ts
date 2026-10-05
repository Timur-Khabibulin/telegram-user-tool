// scripts/ops/tg-agent-persona-deploy.ts — запуск фазы 2 (потребитель пула) вручную /
// из скилла. Тонкая обёртка над features/tg-agent-persona-deploy/run. Detached-исполнение
// (ADR 0008): тул стартует этот скрипт через systemd-run и сразу возвращает управление;
// скрипт держит собственный жёсткий таймаут и доставляет отчёт в Saved Messages.
//
// Запуск: tsx tg-agent-persona-deploy.ts --person-name maria --count 5

import type { Logger } from "../../core/logger";
import { runPersonaDeploy, renderReport } from "../../features/tg-agent-persona-deploy/run";
import { TelegramService } from "../../core/telegram/service";
import { REPORT_AGENT_ID } from "../../core/config";

const log: Logger = {
    info: (m) => console.error(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

// Жёсткий внутренний таймаут прогона (ADR 0008) — в detached watchdog'а нет. Масштабируется
// по размеру пачки: human-pacing (паузы A внутри аккаунта + B между аккаунтами) растягивает
// прогон, фиксированные 60 мин на пачке из нескольких аккаунтов упёрлись бы в потолок. Таймер
// армится в main() после парсинга count. Бюджет на аккаунт — с запасом над реальной работой
// (профиль/фото/канал + паузы A + пауза B).
const BASE_TIMEOUT_MS = 10 * 60 * 1000;
const PER_ACCOUNT_TIMEOUT_MS = 12 * 60 * 1000;

function armHardTimeout(accountCount: number): void {
    const timeoutMs = BASE_TIMEOUT_MS + PER_ACCOUNT_TIMEOUT_MS * accountCount;
    const hardTimeout = setTimeout(() => {
        log.error(`[tg-agent-persona-deploy] fatal: превышен жёсткий таймаут ${timeoutMs}ms — принудительный выход`);
        process.exit(1);
    }, timeoutMs);
    hardTimeout.unref();
}

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const personName = parseArg(argv, "--person-name");
    const count = Number(parseArg(argv, "--count"));

    if (!personName || !Number.isFinite(count) || count <= 0) {
        log.error("[tg-agent-persona-deploy] usage: --person-name <name> --count <n>");
        process.exit(1);
    }

    log.info(`[tg-agent-persona-deploy] start — personName=${personName} count=${count}`);

    armHardTimeout(count);

    const report = await runPersonaDeploy({ personName, count }, log);
    const reportText = renderReport(report);
    console.log("\n" + reportText + "\n");

    try {
        const tg = new TelegramService(log);
        tg.loadAccount(REPORT_AGENT_ID);
        try {
            await tg.sendSavedMessage(reportText);
            log.info(`[tg-agent-persona-deploy] отчёт отправлен в Saved Messages ${REPORT_AGENT_ID}`);
        } finally {
            await tg.disconnect();
        }
    } catch (err: any) {
        log.error(`[tg-agent-persona-deploy] не удалось доставить отчёт в Saved Messages ${REPORT_AGENT_ID}: ${err?.message ?? err}`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[tg-agent-persona-deploy] fatal: ${err?.message ?? err}`);
        process.exit(1);
    });
