// scripts/periodic/channel-activity-update.ts — плановый и ручной пересчёт двух групп
// метрик канала, объединённых в одном скрипте (design.md channel-activity-percentiles,
// Decision 8 — один проход по каналам агента вместо двух отдельных джобов):
//   • охват (avg_views/subs_count) — перенесено без изменений из бывшего
//     channel-coverage-update.ts;
//   • активность (active_writers_p50/p90) — новая метрика, channel-activity-percentiles.
//
// TTL каждой группы проверяется по своей колонке независимо
// (coverage_updated_at / activity_updated_at) — просрочка одной не запускает
// пересчёт другой.
//
// Плановый режим (без --agents), запускается ежедневно таймером: `listAgentIds()`,
// для каждого агента — только просроченные по своему TTL (30 дней) каналы
// каждой группы; окно данных активности — 7 дней (activity-percentile.ts),
// TTL пересчёта и ширина окна не совпадают специально.
// Ручной режим (--agents a1,a2,...): TTL игнорируется для ОБЕИХ групп —
// пересчитываются все каналы перечисленных агентов; --limit N — обработать
// только первые N каналов у каждого агента.
//
// Один TelegramService, агенты обрабатываются последовательно (design.md,
// Decision 2) — без параллелизма между агентами, как и у всех существующих
// скриптов (funnel-tracker.ts, daily-summary.ts).
//
// Режим списка (--input links.csv --output out.csv --agent agentN): считает те же
// две группы метрик для ПРОИЗВОЛЬНОГО списка ссылок, а не для каналов из БД агента.
// Каналы резолвятся по username и НЕ требуют вступления: охват берётся с самого
// канала, активность — из связанной группы обсуждения (linkedChatId), чтение
// истории которой доступно и без членства (проверено 2026-08-26). Результат
// пишется построчно в CSV, БД агента не трогается вовсе — прогон резюмируем:
// повторный запуск с тем же --output пропускает уже обработанные ссылки.
//
// Запуск: `tsx channel-activity-update.ts` (плановый) или
// `tsx channel-activity-update.ts --agents agent1,agent27 --limit 20` (ручной) или
// `tsx channel-activity-update.ts --input links.csv --output out.csv --agent agent27` (список).

import { Api } from "telegram";
import bigInt from "big-integer";

import type { Logger } from "../../core/logger";
import { TelegramService, computeAvgViews } from "../../core/telegram/service";
import { FloodWaitError, ClientNotConnectedError } from "../../core/telegram/errors";
import { listAgentIds, AVG_VIEWS_CACHE_TTL_SECONDS } from "../../core/config";
import {
    initChannels,
    getChannelsForCoverageUpdate,
    saveCoverage,
    getChannelsForActivityUpdate,
    getAllChannels,
    saveActivityPercentiles,
    type ChannelForActivityUpdate,
    type ChannelForAvgUpdate,
} from "../../core/db/channels";
import { activityWindow, ActivityAccumulator } from "../../features/activity-percentile";
import { sleep, sleepRandom } from "../../skills/util";
import * as fs from "fs";
import { normalizeChannelLink } from "../../core/db/discovery";
import {
    V5_MSG_MARK_DELAY_MIN_SEC,
    V5_MSG_MARK_DELAY_MAX_SEC,
    V5_DELAY_EMPTY_MIN_SEC,
    V5_DELAY_EMPTY_MAX_SEC,
} from "../../core/config";

/**
 * Потолок ожидания FLOOD_WAIT (тот же фикс, что в channel-niche.ts и
 * channel-metrics/run.ts, 2026-08-26): короткий лимит осмысленно переждать, а
 * многочасовой означает, что аккаунту закрыли доступ надолго — прогон молча
 * простаивал бы в sleep. Дольше потолка не ждём, канал пропускается.
 */
const MAX_FLOOD_WAIT_SEC = 600;

/** Пейсинг режима --input: те же диапазоны, что у monitor-v5 (см. channel-niche.ts). */
const INTRA_CHANNEL_MIN_SEC = V5_MSG_MARK_DELAY_MIN_SEC;
const INTRA_CHANNEL_MAX_SEC = V5_MSG_MARK_DELAY_MAX_SEC;
const INTER_CHANNEL_MIN_SEC = V5_DELAY_EMPTY_MIN_SEC;
const INTER_CHANNEL_MAX_SEC = V5_DELAY_EMPTY_MAX_SEC;

/** TTL кэша активности канала: 30 дней — тот же период, что у охвата (AVG_VIEWS_CACHE_TTL_SECONDS). */
const ACTIVITY_CACHE_TTL_SECONDS = 30 * 86400;

const log: Logger = {
    info: (m) => console.log(m),
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

// ─── Охват (avg_views/subs_count) — перенесено из channel-coverage-update.ts ──

async function updateCoverage(tg: TelegramService, agentId: string, channels: ChannelForAvgUpdate[]): Promise<void> {
    for (const ch of channels) {
        const inputChannel = new Api.InputChannel({
            channelId: bigInt(ch.channelId),
            accessHash: bigInt(ch.channelAccessHash),
        });

        let posts: Awaited<ReturnType<typeof tg.getPostsOneByOne>>;
        try {
            posts = await tg.getPostsOneByOne(inputChannel, 11);
        } catch (err) {
            if (err instanceof FloodWaitError) {
                log.warn(`[channel-activity-update] coverage FLOOD_WAIT ${err.waitSeconds}s — chatId=${ch.chatId}, waiting...`);
                await sleep(err.waitSeconds * 1000);
                try {
                    posts = await tg.getPostsOneByOne(inputChannel, 11);
                } catch {
                    log.warn(`[channel-activity-update] coverage retry failed for chatId=${ch.chatId}, skipping`);
                    await sleepRandom(1, 3);
                    continue;
                }
            } else {
                log.warn(`[channel-activity-update] coverage error for chatId=${ch.chatId}: ${(err as Error).message ?? err}`);
                await sleepRandom(1, 3);
                continue;
            }
        }

        const avgViews = computeAvgViews(posts);
        await sleepRandom(0.3, 0.8);
        let subsCount: number | null = null;
        try {
            subsCount = await tg.getChannelSubscribers(inputChannel);
        } catch (err) {
            if (err instanceof FloodWaitError) {
                log.warn(`[channel-activity-update] coverage subs FLOOD_WAIT ${err.waitSeconds}s — chatId=${ch.chatId}, waiting...`);
                await sleep(err.waitSeconds * 1000);
                try {
                    subsCount = await tg.getChannelSubscribers(inputChannel);
                } catch {
                    log.warn(`[channel-activity-update] coverage subs retry failed chatId=${ch.chatId}, subsCount=null`);
                }
            } else {
                log.warn(`[channel-activity-update] coverage subs error chatId=${ch.chatId}: ${(err as Error).message ?? err}`);
            }
        }

        saveCoverage(agentId, ch.chatId, avgViews, subsCount);
        log.info(`[channel-activity-update] coverage chatId=${ch.chatId} — avg_views=${avgViews ?? "null"} subs_count=${subsCount ?? "null"}`);
        await sleepRandom(1, 3);
    }
}

// ─── Активность (active_writers_p50/p90) ──────────────────────────────

/**
 * Читает историю потоково через `iterChatHistorySince` в `ActivityAccumulator`
 * — не накапливает сообщения в массиве (инцидент 2026-08-25: канал с 42690
 * сообщениями/30д ронял процесс по OOM при полном накоплении перед подсчётом).
 * FLOOD_WAIT посреди чтения — генератор не умеет возобновляться с середины,
 * поэтому повтор (в вызывающем) начинает канал заново, не восстанавливает
 * прогресс частично прочитанного канала.
 */
async function readChannelActivity(
    tg: TelegramService,
    chatId: string,
    startSec: number,
    endSec: number,
): Promise<{ p50: number; p90: number; count: number }> {
    const acc = new ActivityAccumulator();
    for await (const msg of tg.iterChatHistorySince(chatId, startSec, endSec)) {
        acc.add(msg);
    }
    return { ...acc.finalize(), count: acc.count };
}

async function updateActivity(tg: TelegramService, agentId: string, channels: ChannelForActivityUpdate[]): Promise<void> {
    const { startSec, endSec } = activityWindow();
    for (const ch of channels) {
        let result: { p50: number; p90: number; count: number };
        try {
            result = await readChannelActivity(tg, ch.chatId, startSec, endSec);
        } catch (err) {
            if (err instanceof FloodWaitError) {
                log.warn(`[channel-activity-update] activity FLOOD_WAIT ${err.waitSeconds}s — chatId=${ch.chatId}, waiting...`);
                await sleep(err.waitSeconds * 1000);
                try {
                    result = await readChannelActivity(tg, ch.chatId, startSec, endSec);
                } catch {
                    log.warn(`[channel-activity-update] activity retry failed for chatId=${ch.chatId}, skipping`);
                    continue;
                }
            } else {
                log.warn(`[channel-activity-update] activity error for chatId=${ch.chatId}: ${(err as Error).message ?? err}`);
                continue;
            }
        }

        saveActivityPercentiles(agentId, ch.chatId, result.p50, result.p90);
        log.info(`[channel-activity-update] activity chatId=${ch.chatId} — p50=${result.p50} p90=${result.p90} (messages=${result.count})`);
    }
}

// ─── Прогон по агенту ──────────────────────────────────────────────────

async function updateAgent(
    tg: TelegramService,
    agentId: string,
    opts: { forceAll: boolean; limit?: number },
): Promise<void> {
    initChannels(agentId, log);

    let coverageChannels: ChannelForAvgUpdate[];
    let activityChannels: ChannelForActivityUpdate[];

    if (opts.forceAll) {
        const all = getAllChannels(agentId);
        const limited = opts.limit != null ? all.slice(0, opts.limit) : all;
        coverageChannels = limited
            .filter((c) => c.channelResolved === 1 && c.channelId != null && c.channelAccessHash != null)
            .map((c) => ({ chatId: c.chatId, channelId: c.channelId!, channelAccessHash: c.channelAccessHash! }));
        activityChannels = limited.map((c) => ({ chatId: c.chatId }));
    } else {
        coverageChannels = getChannelsForCoverageUpdate(agentId, AVG_VIEWS_CACHE_TTL_SECONDS);
        activityChannels = getChannelsForActivityUpdate(agentId, ACTIVITY_CACHE_TTL_SECONDS);
    }

    if (coverageChannels.length === 0 && activityChannels.length === 0) {
        log.info(`[channel-activity-update] agentId=${agentId} — nothing to update`);
        return;
    }

    log.info(
        `[channel-activity-update] agentId=${agentId} — coverage=${coverageChannels.length} activity=${activityChannels.length}`,
    );
    tg.loadAccount(agentId);

    if (coverageChannels.length > 0) await updateCoverage(tg, agentId, coverageChannels);
    if (activityChannels.length > 0) await updateActivity(tg, agentId, activityChannels);
}

// ─── Режим списка (--input) ───────────────────────────────────────────
// Метрики произвольного списка ссылок без БД и без вступления в каналы.

// Охват (avg_views) в режиме списка НЕ считается намеренно: getPostsOneByOne
// тянет посты по одному, 11 запросов с паузой 10-30с между ними — 2-5 минут на
// канал сверх чтения истории (на 235 каналах это 8-20 часов впустую). Те же
// avg_views/subs_count дешевле берутся из channel-metrics (там getRecentPosts
// одним запросом). Здесь считаем только то, ради чего скрипт и нужен —
// активность пишущих; subs_count идёт бесплатно, он приходит в том же
// GetFullChannel, который нужен ради linkedChatId.
const INPUT_COLUMNS = ["link", "title", "subs_count", "active_writers_p50", "active_writers_p90", "messages", "error"] as const;

function csvCell(v: string): string {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function csvRow(cells: readonly string[]): string {
    return cells.map((c) => csvCell(c ?? "")).join(",") + "\n";
}

/** Ссылки из входного CSV (колонка `link` обязательна). */
function readInputLinks(inputPath: string): string[] {
    const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error(`входной файл пуст: ${inputPath}`);
    const header = lines[0].split(",").map((s) => s.trim().replace(/^﻿/, ""));
    const idx = header.indexOf("link");
    if (idx === -1) throw new Error(`во входном CSV нет колонки "link": ${inputPath}`);
    return lines.slice(1).map((l) => (l.split(",")[idx] ?? "").trim()).filter((v) => v.length > 0);
}

/** Уже обработанные ссылки из выходного CSV — для резюмируемости. */
function readProcessed(outputPath: string): Set<string> {
    if (!fs.existsSync(outputPath)) return new Set();
    const lines = fs.readFileSync(outputPath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    return new Set(lines.slice(1).map((l) => (l.split(",")[0] ?? "").trim()).filter((v) => v.length > 0));
}

async function runFromInput(agentId: string, inputPath: string, outputPath: string): Promise<void> {
    const links = readInputLinks(inputPath);
    const processed = readProcessed(outputPath);
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8").trim().length === 0) {
        fs.writeFileSync(outputPath, csvRow(INPUT_COLUMNS));
    }

    log.info(`[channel-activity-update] режим списка: агент=${agentId}, ссылок=${links.length}, уже обработано=${processed.size}`);

    const tg = new TelegramService(log);
    const { startSec, endSec } = activityWindow();
    let done = 0;

    try {
        tg.loadAccount(agentId);

        for (const raw of links) {
            const key = normalizeChannelLink(raw);
            if (processed.has(key)) continue;

            const username = key.replace(/^https:\/\/t\.me\//, "");
            let row: string[];

            try {
                const handle = await tg.resolveChannelByUsername(username);
                await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);

                if (!handle) {
                    row = [key, "", "", "", "", "", "канал не найден"];
                } else {
                    // GetFullChannel нужен ради linkedChatId; subs_count приходит тем же
                    // ответом, поэтому берём его бесплатно.
                    const gate = await tg.getChannelGateInfo(handle.inputChannel);
                    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);

                    // Активность считается по связанной группе обсуждения; без неё
                    // писать некому — метрика неприменима, это не ошибка канала.
                    let p50 = "", p90 = "", msgs = "", err = "";
                    if (gate.linkedChatId) {
                        const acc = new ActivityAccumulator();
                        for await (const m of tg.iterChatHistorySince(gate.linkedChatId, startSec, endSec)) acc.add(m);
                        const r = acc.finalize();
                        p50 = String(r.p50);
                        p90 = String(r.p90);
                        msgs = String(acc.count);
                    } else {
                        err = "нет группы обсуждения";
                    }

                    row = [
                        key,
                        handle.title,
                        gate.subscribers != null ? String(gate.subscribers) : "",
                        p50, p90, msgs, err,
                    ];
                }
            } catch (err: any) {
                if (err instanceof FloodWaitError && err.waitSeconds > MAX_FLOOD_WAIT_SEC) {
                    log.error(
                        `[channel-activity-update] FLOOD_WAIT ${err.waitSeconds}s дольше потолка ${MAX_FLOOD_WAIT_SEC}s — прогон остановлен`,
                    );
                    break;
                }
                if (err instanceof FloodWaitError) {
                    log.warn(`[channel-activity-update] FLOOD_WAIT ${err.waitSeconds}s — ждём`);
                    await sleep(err.waitSeconds * 1000);
                    continue; // ссылка не помечена обработанной — будет повторена
                }
                // Сбой САМОЙ сессии (AUTH_KEY_DUPLICATED, отозвана, бан, таймаут
                // коннекта): канал не осматривался, виноват аккаунт. Строку не
                // пишем и ссылку не занимаем — иначе канал потеряется молча.
                // Прогон останавливаем сразу: 2026-08-27 agent126 с мёртвой
                // сессией перемолол весь свой чанк, записав 19 каналов подряд
                // как ошибочные. Ограничение агента ставит сам сервис.
                if (err instanceof ClientNotConnectedError) {
                    log.error(
                        `[channel-activity-update] ${key} — сессия непригодна (${err.message}); ` +
                        "прогон остановлен, необработанные ссылки остались в очереди",
                    );
                    break;
                }
                row = [key, "", "", "", "", "", err?.message ?? String(err)];
            }

            fs.appendFileSync(outputPath, csvRow(row));
            processed.add(key);
            done++;
            log.info(`[channel-activity-update] ${key} — ${row[6] ? `error: ${row[6]}` : `p50=${row[3]} p90=${row[4]} msgs=${row[5]}`}`);
            await sleepRandom(INTER_CHANNEL_MIN_SEC, INTER_CHANNEL_MAX_SEC);
        }
    } finally {
        await tg.disconnect().catch(() => {});
    }

    log.info(`[channel-activity-update] режим списка завершён — обработано ${done}`);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const inputArg = parseArg(argv, "--input");
    if (inputArg) {
        const outputArg = parseArg(argv, "--output");
        const agentArg = parseArg(argv, "--agent") ?? parseArg(argv, "--agents");
        if (!outputArg || !agentArg) {
            log.error("usage: tsx channel-activity-update.ts --input <links.csv> --output <out.csv> --agent <agentId>");
            process.exit(1);
        }
        await runFromInput(agentArg, inputArg, outputArg);
        return;
    }

    const agentsArg = parseArg(argv, "--agents");
    const limitArg = parseArg(argv, "--limit");
    const limit = limitArg != null ? Number(limitArg) : undefined;

    const agentIds = agentsArg ? agentsArg.split(",").map((s) => s.trim()).filter(Boolean) : listAgentIds();
    const forceAll = agentsArg != null;

    if (agentIds.length === 0) {
        log.info("[channel-activity-update] no agents found — nothing to do");
        return;
    }

    log.info(
        `[channel-activity-update] starting — ${agentIds.length} agents, mode=${forceAll ? "manual" : "scheduled"}${limit != null ? ` limit=${limit}` : ""}`,
    );

    const tg = new TelegramService(log);
    for (const agentId of agentIds) {
        try {
            await updateAgent(tg, agentId, { forceAll, limit });
        } catch (err) {
            log.error(`[channel-activity-update] fatal error for agentId=${agentId}: ${(err as Error).message ?? err}`);
        } finally {
            await tg.disconnect();
        }
    }

    log.info("[channel-activity-update] done");
}

main().catch((err) => {
    log.error(`[channel-activity-update] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
