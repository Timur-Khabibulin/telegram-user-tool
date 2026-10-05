// features/proxy/provision-via-probe.ts — подбор рабочего мобильного прокси для агента
// с ЖИВОЙ сессией, у которого помер прокси (guaranteed-proxy-on-connect). В отличие от
// provision-via-tdata кандидат проверяется probe-коллбэком (probeProxy — MTProto-хендшейк
// пустой сессией к Telegram DC), а НЕ connectBootstrap: tdata не требуется, проверяется
// сам прокси, а не аккаунт. Инвентарь/пул — proxy-pool.ts; преобразование/запись —
// provision-shared.ts. Вызывается probe-гейтом ensureClient (verify передаётся коллбэком,
// чтобы не тянуть TelegramService импортом и не создавать цикл service↔proxy).

import type { Logger } from "../../core/logger";
import { type ProxyConfig } from "../../core/config";
import { fetchAvailableMobileProxies, createProxyPicker } from "./proxy-pool";
import { toProxyConfig, saveProxyToAccountConfig } from "./provision-shared";

/**
 * Перебирает до `maxCandidates` мобильных прокси страны `country` из инвентаря asocks
 * (за вычетом занятых другими агентами логинов) и проверяет каждого `probe(proxy)`
 * (бросает при неуспехе). Первый прошедший записывается в `tg-account.json` агента
 * (поле proxy) и возвращается. Если ни один не подошёл, пул исчерпан или нет
 * `ASOCKS_API_KEY` — возвращает null и НЕ трогает конфиг агента.
 */
export async function provisionProxyViaProbe(
    agentId: string,
    country: string,
    maxCandidates: number,
    probe: (proxy: ProxyConfig) => Promise<void>,
    log: Logger,
): Promise<ProxyConfig | null> {
    const apiKey = process.env.ASOCKS_API_KEY;
    if (!apiKey) {
        log.error(`[provision-via-probe] ${agentId}: ASOCKS_API_KEY не задан — подбор прокси пропущен`);
        return null;
    }

    const available = await fetchAvailableMobileProxies(apiKey, country, log);
    const picker = createProxyPicker(available);

    for (let attempt = 1; attempt <= maxCandidates; attempt++) {
        const candidate = picker.takeNext();
        if (!candidate) {
            log.warn(`[provision-via-probe] ${agentId}: пул страны "${country}" исчерпан после ${attempt - 1} попыток`);
            return null;
        }
        const proxy = toProxyConfig(candidate, country);
        log.info(`[provision-via-probe] ${agentId}: попытка ${attempt}/${maxCandidates} — проверка ${proxy.host}:${proxy.port}`);
        try {
            await probe(proxy);
            saveProxyToAccountConfig(agentId, proxy);
            log.info(`[provision-via-probe] ${agentId}: рабочий прокси ${proxy.host}:${proxy.port} записан (попытка ${attempt})`);
            return proxy;
        } catch (err: any) {
            log.warn(`[provision-via-probe] ${agentId}: кандидат ${proxy.host}:${proxy.port} не прошёл проверку — ${err?.message ?? err}`);
        }
    }

    log.warn(`[provision-via-probe] ${agentId}: рабочий прокси не найден за ${maxCandidates} попыток — конфиг не тронут`);
    return null;
}
