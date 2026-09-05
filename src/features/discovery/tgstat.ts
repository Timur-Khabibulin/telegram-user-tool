// features/discovery/tgstat.ts — клиент TGStat для channel-discovery.
//
// REST API TGStat (GET, токен в query-параметре). Используем два метода:
//   • channels/search — поиск каналов по ключевому слову (до 100 на запрос).
//   • channels/stat  — статистика канала по tgId (avg_post_reach для гейта охвата).
// Названия полей — по документации TGStat (https://api.tgstat.ru/docs/ru), она —
// источник истины, не память. Детерминированный модуль, без LLM.

import type { Logger } from "../../core/logger";
import { DISCOVERY_COUNTRY, DISCOVERY_LANGUAGE } from "../../core/config";

const API_BASE = "https://api.tgstat.ru";
const SEARCH_LIMIT = 100; // максимум каналов на запрос channels/search (без пагинации)

export interface TgstatChannel {
    link: string;              // ссылка t.me/... из выдачи
    username: string | null;   // @username (если есть)
    participantsCount: number; // число подписчиков (participants_count)
    tgId: number | null;       // Telegram ID (tg_id)
}

export interface TgstatChannelStat {
    avgPostReach: number;      // средний охват публикации (avg_post_reach)
}

async function callApi(pathname: string, token: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams({ token, ...params }).toString();
    const res = await fetch(`${API_BASE}/${pathname}?${qs}`);
    if (!res.ok) {
        throw new Error(`TGStat ${pathname} HTTP ${res.status}`);
    }
    const json: any = await res.json();
    if (json?.status !== "ok") {
        throw new Error(`TGStat ${pathname} status!=ok: ${json?.error ?? JSON.stringify(json)}`);
    }
    return json.response;
}

/** Статистика канала по tgId — возвращает avg_post_reach. */
export async function getChannelStat(tgId: number, token: string, log: Logger): Promise<TgstatChannelStat> {
    log.info(`[tgstat] channels/stat tgId=${tgId}`);
    const response = await callApi("channels/stat", token, { channelId: String(tgId) });
    return { avgPostReach: Number(response?.avg_post_reach ?? 0) };
}

/** Поиск каналов по ключевому слову — одна страница (до 100, у TGStat пагинации нет). */
export async function searchChannels(keyword: string, token: string, log: Logger): Promise<TgstatChannel[]> {
    log.info(`[tgstat] channels/search q="${keyword}"`);
    const response = await callApi("channels/search", token, {
        q: keyword,
        country: DISCOVERY_COUNTRY,
        language: DISCOVERY_LANGUAGE,
        peer_type: "channel",
        limit: String(SEARCH_LIMIT),
    });
    const items: any[] = response?.items ?? [];
    return items.map((it) => ({
        link: String(it.link ?? ""),
        username: it.username ? String(it.username) : null,
        participantsCount: Number(it.participants_count ?? 0),
        tgId: it.tg_id != null ? Number(it.tg_id) : null,
    }));
}
