// scripts/ops/tg-agent-reserve-provision.ts — запуск третьего пути (provision-в-резерв)
// вручную / из скилла. Тонкая обёртка над features/tg-agent-reserve-provision/run.
// Detached-исполнение (ADR 0008): тул/скилл лишь стартует этот скрипт через systemd-run
// и сразу возвращает управление; скрипт держит собственный жёсткий таймаут (в detached
// watchdog'а нет) и по завершении доставляет отчёт в Saved Messages REPORT_AGENT_ID.
//
// Запуск: tsx tg-agent-reserve-provision.ts --person maria --links "url,url" \
//           [--two-fa-password "<pass>"] --proxy-region us --max-proxy-attempts 5
// 2FA можно не передавать флагом, а положить в env TG_POOL_SOURCE_2FA (secrets.env).

import type { Logger } from "../../core/logger";
import { runReserveProvision, renderReport } from "../../features/tg-agent-reserve-provision/run";
import { TelegramService } from "../../core/telegram/service";
import { REPORT_AGENT_ID } from "../../core/config";

const log: Logger = {
    info: (m) => console.error(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

// Жёсткий внутренний таймаут прогона (ADR 0008) — масштабируется по размеру пачки:
// human-pacing (паузы внутри аккаунта + между аккаунтами) растягивает прогон. Бюджет на
// аккаунт — с запасом над реальной работой (прокси + bootstrap + канал + регистрация сессии).
const BASE_TIMEOUT_MS = 10 * 60 * 1000;
const PER_ACCOUNT_TIMEOUT_MS = 15 * 60 * 1000;

function armHardTimeout(accountCount: number): void {
    const timeoutMs = BASE_TIMEOUT_MS + PER_ACCOUNT_TIMEOUT_MS * accountCount;
    const hardTimeout = setTimeout(() => {
        log.error(`[tg-agent-reserve-provision] fatal: превышен жёсткий таймаут ${timeoutMs}ms — принудительный выход`);
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
    const personName = parseArg(argv, "--person");
    const linksRaw = parseArg(argv, "--links");
    // 2FA-пароль пачки: из флага, иначе из env TG_POOL_SOURCE_2FA (EnvironmentFile secrets.env) —
    // env-путь безопаснее флага (секрет не попадает в командную строку/journald).
    // .trim() обязателен: хвостовой \r (Windows-перевод строки в источнике пароля) иначе
    // попадёт в SRP-хеш — change2FA посчитает его по "pass\r" и упадёт PASSWORD_HASH_INVALID.
    const twoFaPassword = (parseArg(argv, "--two-fa-password") ?? process.env.TG_POOL_SOURCE_2FA)?.trim();
    const proxyRegion = parseArg(argv, "--proxy-region");
    const maxProxyAttempts = Number(parseArg(argv, "--max-proxy-attempts"));

    const links = linksRaw ? linksRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

    if (!personName || links.length === 0 || !proxyRegion || !Number.isFinite(maxProxyAttempts)) {
        log.error(
            "[tg-agent-reserve-provision] usage: --person <persona> --links <url,url,...> " +
                "[--two-fa-password <pass>] --proxy-region <region> --max-proxy-attempts <n>",
        );
        process.exit(1);
    }

    log.info(
        `[tg-agent-reserve-provision] start — person=${personName} accounts=${links.length} ` +
            `proxyRegion=${proxyRegion} maxProxyAttempts=${maxProxyAttempts}`,
    );

    armHardTimeout(links.length);

    const report = await runReserveProvision({ personName, links, twoFaPassword, proxyRegion, maxProxyAttempts }, log);
    const reportText = renderReport(report);
    console.log("\n" + reportText + "\n");

    // Доставка итога в Saved Messages получателя отчётов (ADR 0008) — прогон уже завершён,
    // статусы в стейджинге записаны; сбой доставки логируем, но не роняем результат.
    try {
        const tg = new TelegramService(log);
        tg.loadAccount(REPORT_AGENT_ID);
        try {
            await tg.sendSavedMessage(reportText);
            log.info(`[tg-agent-reserve-provision] отчёт отправлен в Saved Messages ${REPORT_AGENT_ID}`);
        } finally {
            await tg.disconnect();
        }
    } catch (err: any) {
        log.error(`[tg-agent-reserve-provision] не удалось доставить отчёт в Saved Messages ${REPORT_AGENT_ID}: ${err?.message ?? err}`);
    }
}

// process.exit после завершения: прогон оставляет висящие GramJS-клиенты (reconnect на
// таймауте прокси не гасит _updateLoop), их таймеры держат event loop живым.
main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[tg-agent-reserve-provision] fatal: ${err?.message ?? err}`);
        process.exit(1);
    });
