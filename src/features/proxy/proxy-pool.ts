// features/proxy/proxy-pool.ts — подбор мобильного прокси, уникального между агентами
// (mobile-proxy-unique-exit-ip).
//
// Источник кандидатов — `searchMobileProxies` (asocks-client.ts, GET /proxy/search): готовый
// инвентарь аккаунта по стране, без создания/удаления ресурсов. Уникальность обеспечивается
// сверкой по логину с `listUsedProxyUsernames()` (core/config.ts, сканирует tg-account.json
// всех агентов) — без отдельной БД, без сетевой проверки exit IP на каждый подбор (design.md,
// Decisions: логин↔exit IP стабилен, сверка по логину эквивалентна сверке по IP).

import type { Logger } from "../../core/logger";
import { searchMobileProxies, type MobileProxyCandidate } from "./asocks-client";
import { listUsedProxyUsernames } from "../../core/config";

/** Большой запас с учётом текущего размера пула (1642 для country=US, замер 2026-08-27) —
 *  эндпоинт не пагинирует, весь пул приходит одним ответом при достаточном limit. */
const SEARCH_LIMIT = 5000;

/**
 * Кандидаты страны за вычетом логинов, уже занятых любым агентом на диске. Список берётся один
 * раз на весь прогон скрипта (не на каждого агента) — при обработке нескольких agentId подряд
 * дополнительно исключать уже выданных в рамках этого же прогона (см. `takeNext`), пока диск ещё
 * не обновился.
 */
export async function fetchAvailableMobileProxies(
    apiKey: string,
    countryCode: string,
    log: Logger,
): Promise<MobileProxyCandidate[]> {
    const all = await searchMobileProxies(apiKey, countryCode, SEARCH_LIMIT, log);
    const used = listUsedProxyUsernames();
    const available = all.filter((c) => !used.has(c.username));
    log.info(
        `[proxy-pool] country=${countryCode}: ${all.length} всего, ${used.size} занято другими агентами, ${available.length} доступно`,
    );
    return available;
}

/**
 * Пикер поверх уже полученного списка (`fetchAvailableMobileProxies`) — выдаёт кандидатов по
 * одному, из очереди в порядке списка (порядок уже рандомизирован провайдером). Взятый кандидат
 * не предлагается повторно в рамках этого прогона независимо от исхода проверки — неудачный
 * кандидат не «чинится» повторной попыткой того же ресурса (то же решение, что было в
 * create-port цикле: неудачный кандидат больше не рассматривается).
 */
export function createProxyPicker(candidates: MobileProxyCandidate[]) {
    let index = 0;
    return {
        takeNext(): MobileProxyCandidate | null {
            if (index >= candidates.length) return null;
            return candidates[index++];
        },
        remaining(): number {
            return candidates.length - index;
        },
    };
}
