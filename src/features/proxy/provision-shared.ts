// features/proxy/provision-shared.ts — общие помощники подбора мобильного прокси,
// разделяемые ручным подбором (scripts/ops/provision-mobile-proxy.ts) и автозаменой
// прокси в свипе реавторизации (features/agent-reauth-sweep, change
// reauth-sweep-proxy-repair). Логика подбора-кандидатов — в proxy-pool.ts; здесь —
// преобразование кандидата в ProxyConfig, запись в конфиг и определение страны.

import * as fs from "fs";

import { accountConfigPath, type ProxyConfig } from "../../core/config";
import type { MobileProxyCandidate } from "./asocks-client";

/** Кандидат asocks → ProxyConfig агента (socks5, с сохранением страны). */
export function toProxyConfig(candidate: MobileProxyCandidate, countryCode: string): ProxyConfig {
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
export function saveProxyToAccountConfig(agentId: string, proxy: ProxyConfig): void {
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

/**
 * Страна для подбора прокси: сначала парсинг из логина текущего прокси по шаблону
 * `mobile-country-<CC>` (логин asocks несёт локацию, напр.
 * `x6fzimafgk-mobile-country-US-state-...`), затем фолбэк на сохранённый
 * `proxy.countryCode`. Возвращает null, если страну определить нельзя ни так, ни так
 * (тогда автозамена прокси пропускается — reauth-sweep-proxy-repair).
 */
export function parseProxyCountry(
    username: string | undefined,
    fallbackCountryCode: string | undefined,
): string | null {
    const match = username?.match(/mobile-country-([A-Z]{2})/);
    if (match) return match[1];
    if (fallbackCountryCode) return fallbackCountryCode;
    return null;
}
