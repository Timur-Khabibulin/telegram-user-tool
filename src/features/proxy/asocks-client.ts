// features/proxy/asocks-client.ts — клиент asocks.com для mobile-proxy-provisioning.
//
// REST API asocks (GET/POST/DELETE, apiKey в query-параметре). Формат create-port подтверждён
// официальной схемой ServerPortUserProxyForm (docs.asocks.com, 2026-08-25):
//   • country_code — код страны (как в /dir/countries).
//   • state/city — ИМЕНА строкой (не id из /dir/states,/dir/cities — те справочники нужны
//     только для резолва и проверки, что переданное имя реально существует).
//   • proxy_type_id — тип источника прокси: 1=RESIDENTIAL, 2=ALL, 3=MOBILE, 4=CORPORATE.
//   • type_id — НЕ тип прокси (несмотря на созвучное имя), а поведение IP на порте:
//     1=KEEP PROXY (держать один IP), 2=KEEP_CONNECTION, 3=ROTATE CONNECTION (новый IP на
//     каждый коннект). До 2026-08-25 здесь ошибочно стоял тот же ID, что и у proxy_type_id
//     (3) — порт создавался в режиме ROTATE CONNECTION вместо KEEP PROXY, из-за чего разным
//     агентам на одну гео-точку выдавался один и тот же общий вращающийся ресурс аккаунта
//     (login/host совпадали у десятков портов — см. mobile-proxy-shared-ip incident).
//   • server_port_type_id — 0=SHARED, 1=DEDICATED. Не передавался вовсе → уходил дефолт
//     (эмпирически SHARED), усиливая ту же проблему. Для персонального агентского прокси
//     нужен DEDICATED.
// API не даёт фильтр по имени порта ни в /proxy/ports, ни в /proxy/search — deleteProxyByName
// листает все порты постранично и ищет совпадение на своей стороне.

import type { Logger } from "../../core/logger";

const API_BASE = "https://api.asocks.com/v2";
const MOBILE_PROXY_TYPE_ID = 3;
/** KEEP PROXY — держать один и тот же IP на порте (не ROTATE CONNECTION). */
const KEEP_PROXY_TYPE_ID = 1;
/** DEDICATED — персональный порт, не общий с другими портами аккаунта на ту же гео-точку. */
const DEDICATED_SERVER_PORT_TYPE_ID = 1;
const PORTS_PAGE_SIZE = 100;

export interface CreatedProxy {
    id: number;
    name: string;
    host: string;
    port: number;
    username: string;
    password: string;
}

interface DirEntry {
    id: number;
    name: string;
}

async function callApi(
    method: "GET" | "POST" | "DELETE",
    pathname: string,
    apiKey: string,
    params: Record<string, string | number> = {},
    body?: Record<string, unknown>,
): Promise<any> {
    const url = new URL(`${API_BASE}${pathname}`);
    url.searchParams.set("apiKey", apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const res = await fetch(url.toString(), {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json();
    if (!res.ok || json?.success === false) {
        throw new Error(`asocks ${method} ${pathname} failed: HTTP ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
}

/** Страна из /dir/countries — код нужен для create-port, id для резолва регионов. */
export interface CountryEntry extends DirEntry {
    code: string;
}

/**
 * Список стран asocks (`/dir/countries`) — для пошагового подбора локации
 * (tg-agent-create-proxy-provisioning): юзер выбирает страну из показанного списка.
 */
export async function listCountries(apiKey: string): Promise<CountryEntry[]> {
    const res = await callApi("GET", "/dir/countries", apiKey);
    return res.countries as CountryEntry[];
}

/**
 * Список регионов страны (`/dir/states`) по её id (см. `listCountries`) — для пошагового
 * подбора локации: юзер выбирает регион из показанного списка.
 */
export async function listStates(apiKey: string, countryId: number): Promise<DirEntry[]> {
    const res = await callApi("GET", "/dir/states", apiKey, { countryId });
    return res.states as DirEntry[];
}

/**
 * Список городов региона (`/dir/cities`) по его id (см. `listStates`) — для пошагового
 * подбора локации: юзер выбирает город из показанного списка.
 */
export async function listCities(apiKey: string, stateId: number): Promise<DirEntry[]> {
    const res = await callApi("GET", "/dir/cities", apiKey, { stateId });
    return res.cities as DirEntry[];
}

/**
 * Резолвит страну/регион/город в подтверждённые имена через /dir/* (переиспользует
 * listCountries/listStates/listCities) — ловит опечатки во входных параметрах явной ошибкой
 * здесь, а не невнятным отказом create-port.
 */
export async function resolveLocation(
    apiKey: string,
    countryCode: string,
    stateName?: string,
    cityName?: string,
): Promise<{ countryCode: string; state?: string; city?: string }> {
    const countries = await listCountries(apiKey);
    const country = countries.find((c) => c.code.toLowerCase() === countryCode.toLowerCase());
    if (!country) throw new Error(`asocks: неизвестный код страны "${countryCode}"`);

    let state: DirEntry | undefined;
    if (stateName) {
        const states = await listStates(apiKey, country.id);
        state = states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
        if (!state) throw new Error(`asocks: неизвестный регион "${stateName}" в стране "${countryCode}"`);
    }

    if (cityName) {
        if (!state) throw new Error(`asocks: для указания города "${cityName}" нужен регион (state)`);
        const cities = await listCities(apiKey, state.id);
        const city = cities.find((c) => c.name.toLowerCase() === cityName.toLowerCase());
        if (!city) throw new Error(`asocks: неизвестный город "${cityName}" в регионе "${stateName}"`);
    }

    return { countryCode: country.code, state: state?.name, city: cityName };
}

/**
 * Создаёт мобильный прокси-порт. Имя должно быть уникальным на аккаунте asocks —
 * `deleteProxyByName` ищет порт именно по нему.
 */
export async function createMobileProxy(
    apiKey: string,
    name: string,
    countryCode: string,
    state: string | undefined,
    city: string | undefined,
    log: Logger,
): Promise<CreatedProxy> {
    const resolved = await resolveLocation(apiKey, countryCode, state, city);
    log.info(
        `[asocks] create-port name="${name}" country=${resolved.countryCode} state=${resolved.state ?? "-"} city=${resolved.city ?? "-"}`,
    );

    const body: Record<string, unknown> = {
        country_code: resolved.countryCode,
        type_id: KEEP_PROXY_TYPE_ID,
        proxy_type_id: MOBILE_PROXY_TYPE_ID,
        server_port_type_id: DEDICATED_SERVER_PORT_TYPE_ID,
        name,
        count: 1,
    };
    if (resolved.state) body.state = resolved.state;
    if (resolved.city) body.city = resolved.city;

    const res = await callApi("POST", "/proxy/create-port", apiKey, {}, body);
    const created = res.data?.[0];
    if (!created) throw new Error(`asocks: create-port вернул пустой data для имени "${name}"`);

    log.info(`[asocks] create-port OK id=${created.id} ${created.server}:${created.port}`);
    return {
        id: created.id,
        name: created.name,
        host: created.server,
        port: created.port,
        username: created.login,
        password: created.password,
    };
}

export interface MobileProxyCandidate {
    host: string;
    port: number;
    username: string;
    password: string;
}

/**
 * Существующий инвентарь мобильных прокси аккаунта (`GET /proxy/search`) — в отличие от
 * `createMobileProxy`, ничего не создаёт: возвращает уже существующие сессии, отфильтрованные
 * только по стране и типу (без state/city — эндпоинт их не поддерживает, mobile-proxy-unique-
 * exit-ip). Состав списка стабилен между вызовами при одинаковых параметрах (порядок — нет,
 * провайдер его рандомизирует), логин↔exit IP стабилен на повторных подключениях — проверено
 * прямыми запросами 2026-08-27 (1642 кандидата для `country=US`, три разных логина дали три
 * разных exit IP, повтор одного логина дал тот же IP).
 */
export async function searchMobileProxies(
    apiKey: string,
    countryCode: string,
    limit: number,
    log: Logger,
): Promise<MobileProxyCandidate[]> {
    const url = new URL(`${API_BASE}/proxy/search`);
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("country", countryCode);
    url.searchParams.append("types[]", "mobile");
    url.searchParams.set("limit", String(limit));

    const res = await fetch(url.toString());
    const json: any = await res.json();
    if (!res.ok) {
        throw new Error(`asocks GET /proxy/search failed: HTTP ${res.status} ${JSON.stringify(json)}`);
    }

    const entries: unknown[] = Array.isArray(json) ? json.slice(1) : [];
    const candidates: MobileProxyCandidate[] = [];
    for (const entry of entries) {
        if (typeof entry !== "string") continue;
        const m = entry.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
        if (!m) continue;
        candidates.push({ username: m[1], password: m[2], host: m[3], port: Number(m[4]) });
    }
    log.info(`[asocks] proxy/search country=${countryCode} types=mobile limit=${limit} → ${candidates.length} кандидатов`);
    return candidates;
}

/**
 * Ищет прокси-порт по имени среди всех портов аккаунта (API не даёт фильтр по имени — ни
 * /proxy/ports, ни /proxy/search) и удаляет его. Порт не найден — не ошибка (идемпотентно):
 * повторный вызов для уже удалённого имени ничего не ломает.
 */
export async function deleteProxyByName(apiKey: string, name: string, log: Logger): Promise<boolean> {
    for (let page = 1; ; page++) {
        const res = await callApi("GET", "/proxy/ports", apiKey, { page, per_page: PORTS_PAGE_SIZE });
        const proxies = res.message.proxies as Array<{ id: number; name: string }>;
        const found = proxies.find((p) => p.name === name);
        if (found) {
            await callApi("DELETE", "/proxy/delete-port", apiKey, { id: found.id });
            log.info(`[asocks] delete-port name="${name}" id=${found.id}`);
            return true;
        }
        if (page >= res.message.pagination.pageCount) {
            log.warn(`[asocks] delete-port: имя "${name}" не найдено среди портов аккаунта`);
            return false;
        }
    }
}
