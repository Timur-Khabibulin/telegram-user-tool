// features/proxy/provision-via-tdata.ts — подбор рабочего мобильного прокси для агента
// с НЕПРИГОДНОЙ сессией (need_update_session / AUTH_KEY_DUPLICATED): кандидат проверяется
// подключением из tdata (connectBootstrap), а не через сессию агента (та дала бы ложный
// отказ на любом прокси). Используется автозаменой прокси в свипе реавторизации
// (change reauth-sweep-proxy-repair). Подбор кандидатов и уникальность по логину —
// в proxy-pool.ts; преобразование/запись — в provision-shared.ts.

import * as fs from "fs";

import type { Logger } from "../../core/logger";
import { loadAccountConfig, tdataPath, type ProxyConfig } from "../../core/config";
import { connectBootstrap } from "../../core/tdata";
import { fetchAvailableMobileProxies, createProxyPicker } from "./proxy-pool";
import { toProxyConfig, saveProxyToAccountConfig } from "./provision-shared";

/**
 * Перебирает до `maxCandidates` мобильных прокси страны `country` из инвентаря asocks
 * (за вычетом занятых другими агентами логинов) и проверяет каждого подключением из
 * tdata агента. Первый прошедший `connectBootstrap` кандидат записывается в
 * `tg-account.json` (поле proxy) и возвращается. Если ни один не подошёл, пул исчерпан,
 * нет tdata или нет `ASOCKS_API_KEY` — возвращает null и НЕ трогает конфиг агента.
 */
export async function provisionProxyViaTdata(
    agentId: string,
    country: string,
    maxCandidates: number,
    log: Logger,
): Promise<ProxyConfig | null> {
    const apiKey = process.env.ASOCKS_API_KEY;
    if (!apiKey) {
        log.error(`[provision-via-tdata] ${agentId}: ASOCKS_API_KEY не задан — автозамена прокси пропущена`);
        return null;
    }

    const tdata = tdataPath(agentId);
    if (!fs.existsSync(tdata)) {
        log.warn(`[provision-via-tdata] ${agentId}: нет tdata (${tdata}) — автозамена прокси невозможна`);
        return null;
    }

    const account = loadAccountConfig(agentId);
    const available = await fetchAvailableMobileProxies(apiKey, country, log);
    const picker = createProxyPicker(available);

    for (let attempt = 1; attempt <= maxCandidates; attempt++) {
        const candidate = picker.takeNext();
        if (!candidate) {
            log.warn(`[provision-via-tdata] ${agentId}: пул страны "${country}" исчерпан после ${attempt - 1} попыток`);
            return null;
        }
        const proxy = toProxyConfig(candidate, country);
        log.info(`[provision-via-tdata] ${agentId}: попытка ${attempt}/${maxCandidates} — connectBootstrap через ${proxy.host}:${proxy.port}`);
        try {
            // ignoreVersion: true — как в reauthFromTdata (tdata часто новее формата,
            // понимаемого установленным @mtcute/convert).
            const client = await connectBootstrap(tdata, proxy, account.apiId, account.apiHash, account.device, log, true);
            // Успех: закрываем сокет (НЕ логаут — tdata-сессия остаётся живой на стороне
            // Telegram), затем пишем прокси в конфиг.
            await client.disconnect().catch(() => {});
            saveProxyToAccountConfig(agentId, proxy);
            log.info(`[provision-via-tdata] ${agentId}: рабочий прокси ${proxy.host}:${proxy.port} записан (попытка ${attempt})`);
            return proxy;
        } catch (err: any) {
            log.warn(`[provision-via-tdata] ${agentId}: кандидат ${proxy.host}:${proxy.port} не подошёл — ${err?.message ?? err}`);
        }
    }

    log.warn(`[provision-via-tdata] ${agentId}: рабочий прокси не найден за ${maxCandidates} попыток — конфиг не тронут`);
    return null;
}
