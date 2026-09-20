// scripts/ops/tg-agent-reauth-from-tdata.ts — запуск реавторизации агента через tdata
// отсоединённым фоновым процессом (change detached-reauth-and-invite-links).
//
// Тонкая обёртка над features/tg-agent-reauth-from-tdata/run — парсит аргументы,
// запускает прогон, доставляет исход в Saved Messages REPORT_AGENT_ID и принудительно
// завершает процесс. Та же логика доступна интерактивно тулом tg_agent_reauth_from_tdata
// (index.ts), но синхронный вызов тула упирается в per-tool-call watchdog runtime агента
// (ожидание кода авторизации его пробивает) — поэтому пачечный/операторский путь идёт
// detached через systemd-run поверх этого скрипта.
//
// Запуск: tsx tg-agent-reauth-from-tdata.ts --agent-id agent207 [--password2fa <pass>]

import type { Logger } from "../../core/logger";
import { reauthFromTdata, type ReauthFromTdataOutcome } from "../../features/tg-agent-reauth-from-tdata/run";
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

/** Терминальный статус прогона одной строкой — для лога и Saved Messages. */
function renderOutcome(agentId: string, o: ReauthFromTdataOutcome): string {
    const head = "tg-agent-reauth-from-tdata";
    switch (o.kind) {
        case "done":
            return `${head} — ${agentId}: done (accountId=${o.accountId}) — новая sessionString записана, ограничение снято`;
        case "agent_not_found":
            return `${head} — ${agentId}: agent_not_found — tg-account.json не найден`;
        case "tdata_missing":
            return `${head} — ${agentId}: tdata_missing — ${o.path}`;
        case "connect_failed":
            return `${head} — ${agentId}: connect_failed — ${o.error}`;
        case "code_timeout":
            return `${head} — ${agentId}: code_timeout — код авторизации не пришёл вовремя`;
        case "password_rejected":
            return `${head} — ${agentId}: password_rejected — ${o.error}`;
        case "error":
            return `${head} — ${agentId}: error — ${o.error}`;
    }
}

async function deliverReport(text: string): Promise<void> {
    // Доставка исхода в Saved Messages получателя отчётов (REPORT_AGENT_ID) — тот же
    // адресат, что у daily-summary/funnel/автpрега. Сбой доставки логируем, но не
    // роняем уже готовый результат прогона.
    try {
        const tg = new TelegramService(log);
        tg.loadAccount(REPORT_AGENT_ID);
        try {
            await tg.sendSavedMessage(text);
            log.info(`[tg-agent-reauth-from-tdata] отчёт отправлен в Saved Messages ${REPORT_AGENT_ID}`);
        } finally {
            await tg.disconnect();
        }
    } catch (err: any) {
        log.error(
            `[tg-agent-reauth-from-tdata] не удалось доставить отчёт в Saved Messages ${REPORT_AGENT_ID}: ${err?.message ?? err}`,
        );
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const agentId = parseArg(argv, "--agent-id");
    const password2fa = parseArg(argv, "--password2fa");

    if (!agentId) {
        log.error("[tg-agent-reauth-from-tdata] usage: --agent-id <agentId> [--password2fa <pass>]");
        process.exit(1);
    }

    log.info(`[tg-agent-reauth-from-tdata] start — agent=${agentId}`);

    // Отчёт доставляется при ЛЮБОМ исходе, включая непредвиденное исключение из
    // reauthFromTdata: оборачиваем прогон так, чтобы сбой всё равно ушёл в Saved
    // Messages с текстом ошибки, а не потерялся молча.
    let reportText: string;
    try {
        const outcome = await reauthFromTdata(agentId, password2fa, log);
        reportText = renderOutcome(agentId, outcome);
    } catch (err: any) {
        reportText = `tg-agent-reauth-from-tdata — ${agentId}: error — непредвиденная ошибка: ${err?.message ?? err}`;
    }
    console.log("\n" + reportText + "\n");
    await deliverReport(reportText);
}

// Принудительный выход после завершения: реавторизация оставляет висящие GramJS-клиенты
// (bootstrap/agentic, ушедшие в reconnect на таймауте прокси, не гасят свой _updateLoop
// даже после disconnect()), их таймеры/сокеты держат event loop живым и без exit()
// процесс зависает навсегда (в detached-запуске убивать watchdog'ом некому). Отчёт уже
// отправлен внутри main().
main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error(`[tg-agent-reauth-from-tdata] fatal: ${err?.message ?? err}`);
        process.exit(1);
    });
