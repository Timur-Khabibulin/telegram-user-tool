// scripts/provision-mobile-proxy.ts — автоматический подбор рабочего, уникального между
// агентами мобильного прокси (mobile-proxy-unique-exit-ip) для списка агентов.
//
// Разовый интерактивный запуск (не systemd-таймер) — вызывается Claude-skill'ом
// `mobile-proxy-provision`. Обрабатывает агентов СТРОГО ПОСЛЕДОВАТЕЛЬНО (design.md, Non-Goals —
// параллельно сознательно не делаем, см. переписку про перегрузку VPS под
// несколькими одновременными MTProto-подключениями).
//
// Источник кандидатов — GET /proxy/search (готовый инвентарь аккаунта по стране, без
// state/city — см. mobile-proxy-unique-exit-ip/design.md): кандидаты не создаются и не
// удаляются на стороне asocks, только берутся по одному из уже полученного списка. Уникальность
// между агентами — сверкой по логину (`features/proxy/proxy-pool.ts`), не сетевой проверкой IP.
//
// tg-account.json агента изменяется ТОЛЬКО при подтверждённом успехе — проверка кандидата идёт
// через override TelegramService.verifyConnection (в памяти, ничего не пишет на диск, пока не
// подтверждено).
//
// Запуск:
//   tsx provision-mobile-proxy.ts --agents agent28,agent40 --country US --max-attempts 5
//
// --country необязателен, если у агента уже сохранена страна с предыдущего успешного подбора
// (tg-account.json proxy.countryCode). Явный флаг всегда важнее сохранённого значения и
// применяется ко всем агентам списка одинаково.

import * as fs from "fs";

import type { Logger } from "../core/logger";
import { TelegramService } from "../core/telegram/service";
import { accountConfigPath, loadAccountConfig, type ProxyConfig } from "../core/config";
import { fetchAvailableMobileProxies, createProxyPicker } from "../features/proxy/proxy-pool";
import type { MobileProxyCandidate } from "../features/proxy/asocks-client";
import { ConnectTimeoutError } from "../core/telegram/errors";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

// Бюджет проверки кандидата — отдельно от обычных 3×60с ensureClient (design.md, Decisions):
// блокировка MTProto проявляется за ~350мс, 20с на попытку — с большим запасом.
const VERIFY_MAX_ATTEMPTS = 3;
const VERIFY_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 5;

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

interface AgentResult {
    agentId: string;
    status: "success" | "not_found" | "pool_exhausted" | "aborted";
    proxy?: { host: string; port: number };
    attempts: number;
    detail?: string;
}

function toProxyConfig(candidate: MobileProxyCandidate, countryCode: string): ProxyConfig {
    return {
        type: "socks5",
        host: candidate.host,
        port: candidate.port,
        username: candidate.username,
        password: candidate.password,
        countryCode,
    };
}

/** Перезаписывает только поле proxy в tg-account.json агента, остальные поля не трогает. */
function saveProxyToAccountConfig(agentId: string, proxy: ProxyConfig): void {
    const filePath = accountConfigPath(agentId);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    raw.proxy = {
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        countryCode: proxy.countryCode,
    };
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

async function verifyCandidate(tg: TelegramService, proxy: ProxyConfig): Promise<void> {
    await tg.verifyConnection({ proxy, maxAttempts: VERIFY_MAX_ATTEMPTS, connectTimeoutMs: VERIFY_TIMEOUT_MS });
}

type Picker = ReturnType<typeof createProxyPicker>;

async function provisionForAgent(
    agentId: string,
    explicitCountry: string | undefined,
    maxAttempts: number,
    tg: TelegramService,
    pickers: Map<string, Picker>,
    apiKey: string,
): Promise<AgentResult> {
    tg.loadAccount(agentId);
    const account = loadAccountConfig(agentId);

    const country = explicitCountry ?? account.proxy?.countryCode;
    if (!country) {
        return {
            agentId,
            status: "aborted",
            attempts: 0,
            detail: "нет ни --country, ни сохранённого proxy.countryCode в tg-account.json — страна неизвестна",
        };
    }

    // Кандидат №0 — уже настроенный прокси, если он ещё жив, не тратим кандидата из пула.
    if (account.proxy?.host && account.proxy?.username) {
        try {
            await verifyCandidate(tg, account.proxy);
            log.info(`[provision] ${agentId} — существующий прокси ${account.proxy.host}:${account.proxy.port} всё ещё работает`);
            return {
                agentId,
                status: "success",
                proxy: { host: account.proxy.host, port: account.proxy.port },
                attempts: 0,
            };
        } catch (err: any) {
            log.warn(`[provision] ${agentId} — существующий прокси не работает (${err.message ?? err}), ищу новый`);
            if (!(err instanceof ConnectTimeoutError)) {
                return { agentId, status: "aborted", attempts: 0, detail: err.message ?? String(err) };
            }
        }
    }

    let picker = pickers.get(country);
    if (!picker) {
        const available = await fetchAvailableMobileProxies(apiKey, country, log);
        picker = createProxyPicker(available);
        pickers.set(country, picker);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const candidate = picker.takeNext();
        if (!candidate) {
            return { agentId, status: "pool_exhausted", attempts: attempt - 1, detail: `свободных мобильных прокси для страны "${country}" не осталось` };
        }

        const proxy = toProxyConfig(candidate, country);
        try {
            await verifyCandidate(tg, proxy);
            saveProxyToAccountConfig(agentId, proxy);
            log.info(`[provision] ${agentId} — успех, попытка ${attempt}/${maxAttempts}: ${proxy.host}:${proxy.port}`);
            return { agentId, status: "success", proxy: { host: proxy.host, port: proxy.port }, attempts: attempt };
        } catch (err: any) {
            log.warn(`[provision] ${agentId} — попытка ${attempt}/${maxAttempts} не удалась (${proxy.host}:${proxy.port}): ${err.message ?? err}`);
            if (!(err instanceof ConnectTimeoutError)) {
                log.error(`[provision] ${agentId} — причина не в прокси, дальнейшие попытки бессмысленны: ${err.message ?? err}`);
                return { agentId, status: "aborted", attempts: attempt, detail: err.message ?? String(err) };
            }
        }
    }

    return { agentId, status: "not_found", attempts: maxAttempts };
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const agentsArg = parseArg(argv, "--agents");
    const country = parseArg(argv, "--country");
    const maxAttempts = Number(parseArg(argv, "--max-attempts") ?? DEFAULT_MAX_ATTEMPTS);

    if (!agentsArg) {
        throw new Error(
            "Usage: provision-mobile-proxy.ts --agents <a1,a2,...> [--country <code>] [--max-attempts <n>]\n" +
                "--country необязателен, если у агента уже сохранена страна с предыдущего успешного " +
                "подбора (tg-account.json proxy.countryCode) — переданный флаг имеет приоритет над " +
                "сохранённым значением и применяется ко всем агентам списка одинаково.",
        );
    }

    const apiKey = process.env.ASOCKS_API_KEY;
    if (!apiKey) {
        throw new Error("ASOCKS_API_KEY is not set in the environment");
    }

    const agentIds = agentsArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const tg = new TelegramService(log);
    const results: AgentResult[] = [];
    // Один пикер на страну на весь прогон — уже выданный агенту кандидат не предложится
    // следующему агенту того же запуска, даже до записи на диск.
    const pickers = new Map<string, Picker>();

    try {
        for (const agentId of agentIds) {
            const result = await provisionForAgent(agentId, country, maxAttempts, tg, pickers, apiKey);
            results.push(result);
        }
    } finally {
        await tg.disconnect();
    }

    log.info("");
    log.info("=== Итог ===");
    for (const r of results) {
        if (r.status === "success") {
            log.info(`${r.agentId} — успех: ${r.proxy!.host}:${r.proxy!.port} (попыток: ${r.attempts})`);
        } else if (r.status === "aborted") {
            log.info(`${r.agentId} — прекращено (не проблема прокси): ${r.detail}`);
        } else if (r.status === "pool_exhausted") {
            log.info(`${r.agentId} — ${r.detail}`);
        } else {
            log.info(`${r.agentId} — не найден рабочий прокси за ${r.attempts} попыток`);
        }
    }
}

main().catch((err) => {
    log.error(`[provision-mobile-proxy] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
