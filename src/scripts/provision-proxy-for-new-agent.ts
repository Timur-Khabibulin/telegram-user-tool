// scripts/provision-proxy-for-new-agent.ts — подбор рабочего, уникального между агентами
// мобильного прокси ДО того, как у нового агента появится Telegram-сессия
// (tg-agent-create-proxy-provisioning, mobile-proxy-unique-exit-ip).
//
// Отдельный скрипт от provision-mobile-proxy.ts (репейр существующих агентов): там кандидат
// проверяется через TelegramService.verifyConnection с уже существующей сессией агента; здесь
// сессии ещё нет.
//
// Источник кандидатов — GET /proxy/search (готовый инвентарь аккаунта по стране, без
// state/city): кандидаты не создаются и не удаляются на стороне asocks, только берутся по
// одному из уже полученного списка. Уникальность между агентами — сверкой по логину
// (core/proxy/proxy-pool.ts): исключаются логины, уже занятые на диске другими агентами, и
// логины, явно переданные через --exclude (отвергнутые в более ранних попытках ЭТОГО ЖЕ
// создания агента — режим --create-candidate стateless, каждый вызов — новый процесс, поэтому
// список отвергнутых передаёт вызывающая сторона, см. proxy-selection.ts).
//
// Два режима запуска:
//
//   1) Листинг стран для пошагового подбора:
//        tsx provision-proxy-for-new-agent.ts --list-countries
//
//   2) Подбор кандидата с автоматической MTProto-пробой (skills/tg-agent-create, v1):
//        tsx provision-proxy-for-new-agent.ts --api-id <id> --api-hash <hash> \
//          --agent-id <agentId> --country <code> [--max-attempts 5]
//      Кандидат проверяется TelegramService.probeProxy (голый MTProto connect(), БЕЗ отправки
//      кода авторизации — см. design.md tg-agent-create-proxy-provisioning, Decisions: гонять
//      реальный authSendCode по нескольким кандидатам означало бы слать код в Telegram/SMS на
//      каждую неудачную попытку и упереться в флуд-лимит ещё до входа в аккаунт). Успех — печатает
//      JSON с host/port/username/password/countryCode. Неудача — печатает JSON
//      { ok: false, attempts } либо { ok: false, attempts, poolExhausted: true }.
//
//   3) Один кандидат без пробы, для ручной проверки человеком (skills/tg-agent-create-v2,
//      tg-agent-create-v2-proxy-first): подбор прокси в v2 — первый шаг скилла, до apiId/apiHash;
//      проверка кандидата — ручной вход человека в Telegram-приложение через выданный прокси, не
//      автоматическая MTProto-проба. Оркестрация цикла (показать → дождаться ответа человека →
//      при неудаче взять следующего) живёт в SKILL.md, не здесь — эти режимы дают только
//      атомарную операцию «взять кандидата»:
//        tsx provision-proxy-for-new-agent.ts --create-candidate --agent-id <agentId> \
//          --country <code> [--exclude <login1,login2,...>]
//      Печатает JSON кандидата: { host, port, username, password, countryCode } либо
//      { ok: false, poolExhausted: true } при исчерпании пула. Отвергнутый ранее в этом же
//      прогоне кандидат передаётся через --exclude — на стороне asocks удалять нечего, это не
//      наш созданный ресурс.

import type { Logger } from "../core/logger";
import { TelegramService } from "../core/telegram/service";
import type { ProxyConfig } from "../core/config";
import { listCountries } from "../core/proxy/asocks-client";
import { fetchAvailableMobileProxies } from "../core/proxy/proxy-pool";
import { ConnectTimeoutError } from "../core/telegram/errors";

const log: Logger = {
    info: (m) => console.error(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const DEFAULT_MAX_ATTEMPTS = 5;

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

function requireApiKey(): string {
    const apiKey = process.env.ASOCKS_API_KEY;
    if (!apiKey) throw new Error("ASOCKS_API_KEY is not set in the environment");
    return apiKey;
}

async function runListCountries(): Promise<void> {
    const countries = await listCountries(requireApiKey());
    for (const c of countries.sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`${c.code}\t${c.name}`);
    }
}

interface ProvisionResult {
    ok: true;
    proxy: ProxyConfig;
    attempts: number;
}

interface ProvisionFailure {
    ok: false;
    attempts: number;
    poolExhausted?: boolean;
}

async function runProvision(opts: {
    apiId: number;
    apiHash: string;
    agentId: string;
    country: string;
    maxAttempts: number;
}): Promise<ProvisionResult | ProvisionFailure> {
    const apiKey = requireApiKey();
    const tg = new TelegramService(log);
    const available = await fetchAvailableMobileProxies(apiKey, opts.country, log);

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
        const candidate = available[attempt - 1];
        if (!candidate) {
            return { ok: false, attempts: attempt - 1, poolExhausted: true };
        }
        const proxy: ProxyConfig = {
            type: "socks5",
            host: candidate.host,
            port: candidate.port,
            username: candidate.username,
            password: candidate.password,
            countryCode: opts.country,
        };

        try {
            await tg.probeProxy({ apiId: opts.apiId, apiHash: opts.apiHash, proxy });
            log.info(`[provision-new-agent] ${opts.agentId} — успех, попытка ${attempt}/${opts.maxAttempts}: ${proxy.host}:${proxy.port}`);
            return { ok: true, proxy, attempts: attempt };
        } catch (err: any) {
            log.warn(`[provision-new-agent] ${opts.agentId} — попытка ${attempt}/${opts.maxAttempts} не удалась (${proxy.host}:${proxy.port}): ${err.message ?? err}`);
            if (!(err instanceof ConnectTimeoutError)) {
                log.error(`[provision-new-agent] ${opts.agentId} — причина не в прокси, дальнейшие попытки бессмысленны: ${err.message ?? err}`);
                throw err;
            }
        }
    }

    return { ok: false, attempts: opts.maxAttempts };
}

/**
 * Берёт одного кандидата прокси без пробы (tg-agent-create-v2-proxy-first) — проверка ручная,
 * человек логинится в Telegram-приложение через выданный прокси; цикл показать/подождать/взять
 * следующего оркеструет SKILL.md, не этот скрипт. `exclude` — логины, уже отвергнутые в более
 * ранних попытках этого же прогона (см. proxy-selection.ts).
 */
async function runCreateCandidate(opts: {
    agentId: string;
    country: string;
    exclude: string[];
}): Promise<ProxyConfig | { ok: false; poolExhausted: true }> {
    const apiKey = requireApiKey();
    const available = await fetchAvailableMobileProxies(apiKey, opts.country, log);
    const excludeSet = new Set(opts.exclude);
    const candidate = available.find((c) => !excludeSet.has(c.username));
    if (!candidate) {
        return { ok: false, poolExhausted: true };
    }
    return {
        type: "socks5",
        host: candidate.host,
        port: candidate.port,
        username: candidate.username,
        password: candidate.password,
        countryCode: opts.country,
    };
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);

    if (argv.includes("--list-countries")) {
        await runListCountries();
        return;
    }

    if (argv.includes("--create-candidate")) {
        const agentId = parseArg(argv, "--agent-id");
        const country = parseArg(argv, "--country");
        const excludeArg = parseArg(argv, "--exclude");
        if (!agentId || !country) {
            throw new Error(
                "Usage: provision-proxy-for-new-agent.ts --create-candidate --agent-id <agentId> " +
                    "--country <code> [--exclude <login1,login2,...>]",
            );
        }
        const exclude = excludeArg ? excludeArg.split(",").map((s) => s.trim()).filter(Boolean) : [];
        const candidate = await runCreateCandidate({ agentId, country, exclude });
        console.log(JSON.stringify(candidate));
        return;
    }

    const apiId = Number(parseArg(argv, "--api-id"));
    const apiHash = parseArg(argv, "--api-hash");
    const agentId = parseArg(argv, "--agent-id");
    const country = parseArg(argv, "--country");
    const maxAttempts = Number(parseArg(argv, "--max-attempts") ?? DEFAULT_MAX_ATTEMPTS);

    if (!apiId || !apiHash || !agentId || !country) {
        throw new Error(
            "Usage: provision-proxy-for-new-agent.ts --api-id <id> --api-hash <hash> --agent-id <agentId> " +
                "--country <code> [--max-attempts <n>]",
        );
    }

    const result = await runProvision({ apiId, apiHash, agentId, country, maxAttempts });
    console.log(JSON.stringify(result));
}

main().catch((err) => {
    log.error(`[provision-proxy-for-new-agent] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
