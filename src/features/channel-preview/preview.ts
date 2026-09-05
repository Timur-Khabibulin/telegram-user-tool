// features/channel-preview/preview.ts — публичное веб-превью канала (channel-post-watch).
//
// Проверка последнего поста канала через t.me/s/<username> — обычный HTTP-запрос
// к публичной странице, без MTProto и без привязки к аккаунту (openspec/changes/
// monitor-v3/design.md, решение 1). Разбор — cheerio по тем же селекторам, что
// использует RSSHub для своего маршрута Telegram-канала (решение 2): headless-
// браузер не нужен, страница статический HTML без JS-рендеринга.

import * as cheerio from "cheerio";
import type { Logger } from "../../core/logger";

export interface ChannelLatestPost {
    id: number;
    date: number; // unix-сек публикации
    text: string;
}

/**
 * Исход проверки — различает «проверка успешно выполнена» (`ok: true`, вне
 * зависимости от того, нашёлся пост или нет — `post: null` означает «постов
 * нет») и «проверка не удалась» (`ok: false` — сеть, бан IP, неразобранная
 * разметка). Это различие нужно вызывающей стороне (monitor-v3): в
 * `channel_visits` должны попадать только успешно проверенные каналы, а не
 * каналы, которые вообще не удалось проверить.
 */
export interface ChannelPreviewCheck {
    ok: boolean;
    post: ChannelLatestPost | null;
}

/**
 * Последний пост публичного канала по t.me/s/<username>. Функция не бросает
 * исключение — все сбои (сеть, HTTP-ошибка, нераспознанная разметка)
 * возвращаются как `{ ok: false, post: null }`, залогированные `warn`ом.
 */
export async function fetchLatestChannelPost(username: string, log: Logger): Promise<ChannelPreviewCheck> {
    let html: string;
    try {
        const res = await fetch(`https://t.me/s/${encodeURIComponent(username)}`);
        if (!res.ok) {
            log.warn(`[channel-preview] fetchLatestChannelPost — @${username} HTTP ${res.status}`);
            return { ok: false, post: null };
        }
        html = await res.text();
    } catch (err: any) {
        log.warn(`[channel-preview] fetchLatestChannelPost — @${username} запрос не удался: ${err?.message ?? err}`);
        return { ok: false, post: null };
    }

    const $ = cheerio.load(html);
    const posts = $(".tgme_widget_message_wrap").filter((_, el) => {
        const $el = $(el);
        return $el.find(".service_message").length === 0 && $el.find(".tme_no_messages_found").length === 0;
    });
    if (posts.length === 0) {
        log.info(`[channel-preview] fetchLatestChannelPost — @${username} постов не найдено`);
        return { ok: true, post: null };
    }

    // Порядок в HTML — от старых к новым, последний элемент — самый свежий пост.
    const last = posts.last();
    const href = last.find(".tgme_widget_message_date").attr("href");
    const datetime = last.find(".tgme_widget_message_date time").attr("datetime");
    const text = last.find(".tgme_widget_message_bubble > .tgme_widget_message_text").text().trim();

    const idMatch = href?.match(/\/(\d+)$/);
    if (!idMatch || !datetime) {
        log.warn(`[channel-preview] fetchLatestChannelPost — @${username} не удалось разобрать id/дату последнего поста`);
        return { ok: false, post: null };
    }

    const date = Math.floor(new Date(datetime).getTime() / 1000);
    if (!Number.isFinite(date)) {
        log.warn(`[channel-preview] fetchLatestChannelPost — @${username} нераспознанная дата: ${datetime}`);
        return { ok: false, post: null };
    }

    const id = Number(idMatch[1]);
    log.info(`[channel-preview] fetchLatestChannelPost — @${username} найден пост id=${id} date=${new Date(date * 1000).toISOString()}`);
    return { ok: true, post: { id, date, text } };
}

/**
 * Разбор одной страницы `t.me/s/<username>` в список постов, в порядке DOM
 * (от старых к новым) — та же выборка `.tgme_widget_message_wrap` и те же
 * поля, что `fetchLatestChannelPost`. Возвращает `null`, если хотя бы один
 * пост не удалось разобрать (id/дата) — вызывающий трактует это как отказ
 * всей проверки, не как «постов нет» (monitor-v4, design.md, Risks).
 */
function parsePostsPage($: cheerio.CheerioAPI): ChannelLatestPost[] | null {
    const posts = $(".tgme_widget_message_wrap").filter((_, el) => {
        const $el = $(el);
        return $el.find(".service_message").length === 0 && $el.find(".tme_no_messages_found").length === 0;
    });

    const parsed: ChannelLatestPost[] = [];
    let failed = false;
    posts.each((_, el) => {
        const $el = $(el);
        const href = $el.find(".tgme_widget_message_date").attr("href");
        const datetime = $el.find(".tgme_widget_message_date time").attr("datetime");
        const text = $el.find(".tgme_widget_message_bubble > .tgme_widget_message_text").text().trim();

        const idMatch = href?.match(/\/(\d+)$/);
        if (!idMatch || !datetime) {
            failed = true;
            return;
        }
        const date = Math.floor(new Date(datetime).getTime() / 1000);
        if (!Number.isFinite(date)) {
            failed = true;
            return;
        }
        parsed.push({ id: Number(idMatch[1]), date, text });
    });

    return failed ? null : parsed;
}

/**
 * Последний пост канала внутри окна дат `[startSec, endSec)` — monitor-v4
 * (design.md, Decision 2). В отличие от `fetchLatestChannelPost` (берёт
 * только самый свежий пост), обходит `t.me/s/<username>` постранично назад
 * через `?before=<id>`, пока не найдёт пост внутри окна или не пройдёт его
 * насквозь (пост старше `startSec` без единого попадания — окно пусто).
 * Без ограничения глубины пагинации (design.md, Risks — осознанно принято).
 *
 * Контракт исходов — как у `fetchLatestChannelPost`: `{ ok: false }` — сама
 * проверка не удалась (сеть/HTTP/разбор, на любой странице пагинации);
 * `{ ok: true, post: null }` — проверка выполнена, в окне постов нет;
 * `{ ok: true, post }` — найден последний по времени пост внутри окна.
 */
export async function fetchLastPostInDateRange(
    username: string,
    startSec: number,
    endSec: number,
    log: Logger,
): Promise<ChannelPreviewCheck> {
    let beforeId: number | undefined;
    let page = 0;

    for (;;) {
        page += 1;
        const url = beforeId
            ? `https://t.me/s/${encodeURIComponent(username)}?before=${beforeId}`
            : `https://t.me/s/${encodeURIComponent(username)}`;

        let html: string;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                log.warn(`[channel-preview] fetchLastPostInDateRange — @${username} HTTP ${res.status} (page=${page})`);
                return { ok: false, post: null };
            }
            html = await res.text();
        } catch (err: any) {
            log.warn(`[channel-preview] fetchLastPostInDateRange — @${username} запрос не удался (page=${page}): ${err?.message ?? err}`);
            return { ok: false, post: null };
        }

        const $ = cheerio.load(html);
        const parsed = parsePostsPage($);
        if (parsed === null) {
            log.warn(`[channel-preview] fetchLastPostInDateRange — @${username} не удалось разобрать id/дату поста (page=${page})`);
            return { ok: false, post: null };
        }
        if (parsed.length === 0) {
            // Пустая лента — либо у канала вовсе нет постов, либо пагинация дошла
            // до самого начала истории канала без единого попадания в окно.
            log.info(`[channel-preview] fetchLastPostInDateRange — @${username} лента пуста (page=${page})`);
            return { ok: true, post: null };
        }

        // parsed идёт от старых к новым (порядок DOM) — сканируем от новых к старым.
        for (let i = parsed.length - 1; i >= 0; i--) {
            const post = parsed[i];
            if (post.date >= endSec) continue; // новее окна — идём к более старому
            if (post.date >= startSec) {
                log.info(
                    `[channel-preview] fetchLastPostInDateRange — @${username} найден пост id=${post.id} date=${new Date(post.date * 1000).toISOString()} (page=${page})`,
                );
                return { ok: true, post };
            }
            // post.date < startSec — прошли окно насквозь, ни разу не попав в него.
            log.info(`[channel-preview] fetchLastPostInDateRange — @${username} окно [${startSec}, ${endSec}) пусто (page=${page})`);
            return { ok: true, post: null };
        }

        // Вся страница новее endSec — целевое окно ещё не достигнуто, страница глубже.
        const oldestId = parsed[0].id;
        if (beforeId !== undefined && oldestId >= beforeId) {
            // Пагинация не продвинулась — не тот случай, что «дошли до начала»
            // (parsed.length === 0 обработан выше); трактуем как отказ проверки,
            // чтобы не зациклиться.
            log.warn(`[channel-preview] fetchLastPostInDateRange — @${username} пагинация не продвинулась (page=${page}, before=${beforeId}, oldestId=${oldestId})`);
            return { ok: false, post: null };
        }
        beforeId = oldestId;
    }
}
