// scripts/ops/channel-niche.ts — ниша/тематика произвольного списка Telegram-каналов по CSV.
//
// Ручной операторский инструмент (не dispatcher/systemd): читает CSV со списком
// ссылок (колонка `link`), для каждой через MTProto резолвит канал, берёт
// описание + последние посты, и одним LLM-вызовом определяет нишу канала
// (короткая категория на русском — по факту контента, не по названию).
// Результат дописывается в выходной CSV построчно — прогон резюмируем: повторный
// запуск с тем же --output пропускает ссылки, уже присутствующие в файле
// (успешные и завершившиеся ошибкой), обрабатывает только остаток.
//
// Параллельность: --agents делится на "волны" по --parallel аккаунтов (по
// умолчанию 10). Внутри волны все аккаунты работают ОДНОВРЕМЕННО, разбирая одну
// общую очередь ссылок (каждая ссылка достаётся ровно одним воркером — гонок
// нет, т.к. курсор очереди продвигается синхронно, без await между чтением и
// инкрементом). Каждый воркер держит свою MTProto-сессию и останавливается
// сам по себе (не всю волну), когда: а) выбрал свою квоту --batch-size, б) поймал
// 2 FLOOD_WAIT подряд, в) поймал 6 "канал не найден" подряд (деградация
// резолвинга) — в любом из трёх случаев его недобранная доля ссылок просто
// достаётся другим воркерам той же волны из общей очереди. Когда вся волна
// (все её воркеры) завершилась, а очередь не пуста — стартует следующая волна
// со следующими --parallel аккаунтами из --agents. Прогон останавливается
// насовсем, только когда волны кончились, а очередь всё ещё не пуста.
//
// Пейсинг: случайные паузы из констант monitor-v5 (V5_MSG_MARK_DELAY внутри
// канала, V5_DELAY_EMPTY между каналами) — см. комментарий у констант ниже.
//
// Защита сессий: перед загрузкой аккаунта воркер берёт межпроцессный замок на
// сессию агента (core/telegram/session-lock). Если тот же агент уже занят другим
// живым процессом (второй запуск скрипта, диспетчер), воркер НЕ подключается, а
// сразу останавливается с понятной причиной — вместо `406 AUTH_KEY_DUPLICATED`,
// который Telegram отдаёт на два одновременных коннекта одной сессией.
//
// Остаток: с --until-done скрипт сам повторяет проходы, пока очередь не разобрана
// (внешняя bash-обёртка с циклом не нужна — именно она и приводила к запуску
// второго процесса поверх ещё живого первого). Проход без единого обработанного
// канала останавливает прогон, чтобы не крутиться вхолостую.
//
// Запуск (параллельно, 10 аккаунтов волной):
//   tsx src/scripts/ops/channel-niche.ts --input links.csv --output niches.csv \
//     --agents agent1,agent2,...,agent10,agent11,...,agent20 --parallel 10
// Запуск (один аккаунт, без параллельности — parallel по умолчанию 1 при одном agentId):
//   tsx src/scripts/ops/channel-niche.ts --input links.csv --output niches.csv --agent agent8
// Запуск до полного разбора списка (проходы повторяются автоматически):
//   tsx src/scripts/ops/channel-niche.ts --input links.csv --output niches.csv \
//     --agents agent1,agent2 --parallel 2 --until-done
// Родственный скрипт: channel-metrics.ts (подписчики/охват вместо ниши, без параллельности).

import * as fs from "fs";
import { z } from "zod";

import type { Logger } from "../../core/logger";
import { TelegramService, ChannelPost } from "../../core/telegram/service";
import {
    FloodWaitError,
    ClientNotConnectedError,
    SessionRevokedError,
    AccountBannedError,
} from "../../core/telegram/errors";
import { acquireSession, releaseSession, SessionBusyError } from "../../core/telegram/session-lock";
import { normalizeChannelLink } from "../../core/db/discovery";
import {
    V5_MSG_MARK_DELAY_MIN_SEC,
    V5_MSG_MARK_DELAY_MAX_SEC,
    V5_DELAY_EMPTY_MIN_SEC,
    V5_DELAY_EMPTY_MAX_SEC,
} from "../../core/config";
import { createLlmClient } from "../../llm/client";
import { classifyNiche } from "../../llm/prompts";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

const OUTPUT_COLUMNS = ["link", "title", "subscribers", "niche", "error"] as const;
const N_POSTS = 8; // постов для LLM-классификации темы (меньше, чем 11 у channel-metrics — там нужна точная средняя, здесь только смысл контента)
// Пейсинг подобран вручную (2025-08-03) после того, как дефолтный 0.7-1.0с дважды
// за один день привёл к деградации резолвинга username у сессии (agent6/agent8/agent9
// переставали находить заведомо существующие публичные каналы в середине прогона —
// см. MAX_CONSECUTIVE_NOT_FOUND ниже). Разнесли на две паузы: между отдельными
// MTProto-запросами ВНУТРИ обработки одного канала (resolve → gate → posts) и между
// каналами — предположительно резолвинг username бьёт по более узкому лимиту
// Telegram, чем обычные вызовы, поэтому его пауза больше. Это пейсинг ВНУТРИ одного
// аккаунта — при параллельных воркерах у каждого аккаунта своя пара таймеров, они
// друг другу не мешают (у каждого аккаунта свой MTProto-сессия и свой, как правило,
// отдельный прокси — см. account.proxy в конфиге агента).
//
// 2026-08-26: фиксированные 2.0с/1.0с оказались слишком агрессивными — agent221
// на длинном списке словил FLOOD_WAIT на 23 часа. Перешли на пейсинг monitor-v5:
// случайные интервалы вместо фиксированных (ровный «машинный» ритм сам по себе
// заметен) и заметно длиннее. Значения берём прямо из констант v5, чтобы пейсинг
// не разъезжался: правка порогов v5 подтягивает и просмотр каналов.
//   • внутри канала (resolve → gate → posts) — V5_MSG_MARK_DELAY (1-7с),
//     мелкое действие внутри одной сущности;
//   • между каналами — V5_DELAY_EMPTY (8-20с), переход к следующему чату
//     без «активного» действия.
const INTRA_CHANNEL_MIN_SEC = V5_MSG_MARK_DELAY_MIN_SEC;
const INTRA_CHANNEL_MAX_SEC = V5_MSG_MARK_DELAY_MAX_SEC;
const INTER_CHANNEL_MIN_SEC = V5_DELAY_EMPTY_MIN_SEC;
const INTER_CHANNEL_MAX_SEC = V5_DELAY_EMPTY_MAX_SEC;
const PASS_PAUSE_MS = 5000; // пауза между проходами в режиме --until-done
const MAX_CONSECUTIVE_FLOOD = 2; // 2 FLOOD_WAIT подряд → этот воркер останавливается

/**
 * Потолок ожидания FLOOD_WAIT. Короткий лимит (секунды-минуты) осмысленно
 * переждать, а длинный означает, что Telegram закрыл аккаунту резолв надолго:
 * 2026-08-26 agent221 получил FLOOD_WAIT на 83412s (23 часа) и прогон молча
 * простоял в sleep, пока его не сняли руками. Дольше потолка не ждём — воркер
 * снимается с прогона, недообработанная ссылка остаётся в очереди и достаётся
 * следующему проходу (или другому аккаунту той же волны).
 */
const MAX_FLOOD_WAIT_SEC = 600;

/**
 * Отдельный порог от FLOOD_WAIT: у некоторых аккаунтов resolveChannelByUsername
 * тихо перестаёт находить каналы (возвращает null без исключения) после ~70-80
 * резолвов за сессию — не ошибка API, а молчаливая деградация конкретной сессии.
 * Замечено на практике (agent6/agent8/agent9 в одном прогоне, agent10/agent14
 * работали нормально) — природа ограничения не выяснена (вероятно, лимит
 * Telegram на поиск по username для конкретного аккаунта/IP). N подряд "канал не
 * найден" — тоже стоп-сигнал для ЭТОГО воркера: без него длинный список молча
 * зарастает ложноотрицательными "канал не найден" вместо реальной классификации.
 * Порог выше, чем у FLOOD_WAIT (2), — единичные реально не найденные каналы в
 * списке не должны останавливать воркер.
 */
const MAX_CONSECUTIVE_NOT_FOUND = 6;

/**
 * Сбой САМОЙ сессии (не удалось подключиться: AUTH_KEY_DUPLICATED, таймаут
 * коннекта и т.п.) — канал при этом вообще не осматривался. Такие ссылки нельзя
 * писать в выходной CSV: строка с ошибкой помечает ссылку обработанной, и канал
 * молча теряется навсегда, хотя виноват аккаунт, а не канал. Поэтому ссылка
 * остаётся в очереди (её подберёт следующий проход/здоровый аккаунт), а воркер
 * после N сбоев подряд снимается с прогона — сломанный аккаунт не должен
 * «съедать» очередь. Отозванная сессия/бан останавливают воркер сразу: это не
 * лечится повтором, нужен перелогин аккаунта.
 */
const MAX_CONSECUTIVE_SESSION_ERRORS = 3;

/**
 * Сколько каналов резолвить одним аккаунтом за волну, прежде чем этот воркер
 * сам остановится (квота выбрана) — до того как упрёмся в FLOOD_WAIT или
 * деградацию резолвинга. На практике деградация начиналась около ~70-80
 * резолвов за сессию, но конкретное значение "плавает" (один раз словили её уже
 * на 5-м после рестарта), так что квота ниже этого порога — снижение риска,
 * а не гарантия. 55 — середина диапазона 50-60.
 */
const AGENT_BATCH_SIZE = 55;

/** Сколько аккаунтов работает одновременно в одной волне. */
const DEFAULT_PARALLELISM = 10;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Случайная пауза в диапазоне [minSec, maxSec] — тот же приём, что sleepRandom в скиллах (monitor-v5). */
const sleepRandom = (minSec: number, maxSec: number): Promise<void> =>
    sleep((minSec + Math.random() * (maxSec - minSec)) * 1000);

const NICHE_SYSTEM = "Ты — классификатор ниши Telegram-каналов. Отвечай только JSON.";
const nicheSchema = z.object({ niche: z.string() });

/** Внутренний сигнал остановки текущего воркера (не всей волны/прогона). */
class WorkerStop extends Error {
    constructor(public readonly reason: string) { super(reason); }
}

function makeFloodAware(onStop: (reason: string) => never) {
    let consecutive = 0;
    return async function floodAware<T>(fn: () => Promise<T>): Promise<T> {
        for (;;) {
            try {
                const r = await fn();
                consecutive = 0;
                return r;
            } catch (err) {
                if (err instanceof FloodWaitError) {
                    consecutive += 1;
                    if (consecutive >= MAX_CONSECUTIVE_FLOOD) {
                        onStop(`FLOOD_WAIT ${MAX_CONSECUTIVE_FLOOD} раза подряд`);
                    }
                    if (err.waitSeconds > MAX_FLOOD_WAIT_SEC) {
                        onStop(
                            `FLOOD_WAIT ${err.waitSeconds}s дольше потолка ожидания ${MAX_FLOOD_WAIT_SEC}s — ` +
                            "аккаунт снят с прогона (ждать столько внутри прогона бессмысленно)",
                        );
                    }
                    log.warn(`[channel-niche] FLOOD_WAIT ${err.waitSeconds}s — ждём и повторяем`);
                    await sleep(err.waitSeconds * 1000);
                    continue;
                }
                throw err;
            }
        }
    };
}

// ─── CLI / CSV (те же примитивы, что и channel-metrics.ts) ─────────────

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
            } else cur += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") { cells.push(cur); cur = ""; }
        else cur += c;
    }
    cells.push(cur);
    return cells;
}

function readCsvRows(text: string): string[][] {
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.map(parseCsvLine);
}

function csvCell(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(values: readonly string[]): string {
    return values.map(csvCell).join(",") + "\n";
}

function readInputLinks(inputPath: string): string[] {
    const rows = readCsvRows(fs.readFileSync(inputPath, "utf8"));
    if (rows.length === 0) throw new Error(`входной файл пуст: ${inputPath}`);
    const header = rows[0];
    const linkIdx = header.indexOf("link");
    if (linkIdx === -1) throw new Error(`во входном CSV нет колонки "link": ${inputPath}`);
    return rows.slice(1).map((r) => (r[linkIdx] ?? "").trim()).filter((v) => v.length > 0);
}

function readProcessedLinks(outputPath: string): Set<string> {
    if (!fs.existsSync(outputPath)) return new Set();
    const text = fs.readFileSync(outputPath, "utf8");
    if (text.trim().length === 0) return new Set();
    const rows = readCsvRows(text);
    if (rows.length <= 1) return new Set();
    const linkIdx = rows[0].indexOf("link");
    if (linkIdx === -1) return new Set();
    return new Set(rows.slice(1).map((r) => r[linkIdx] ?? "").filter((v) => v.length > 0));
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

interface LinkKey {
    key: string;
    username: string | null;
}

function resolveLinkKey(raw: string): LinkKey {
    const normalized = normalizeChannelLink(raw);
    const tail = normalized.replace(/^https:\/\/t\.me\//, "");
    const isPrivate = tail === "" || tail.startsWith("+") || tail === "joinchat";
    if (isPrivate) return { key: raw.trim().toLowerCase(), username: null };
    return { key: normalized, username: tail };
}

// ─── Классификация одного канала ────────────────────────────────────────

interface ChannelNiche {
    title: string;
    subscribers: string;
    niche: string;
    error: string;
}

async function classifyChannel(
    tg: TelegramService,
    llm: ReturnType<typeof createLlmClient>,
    username: string,
    floodAware: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<ChannelNiche> {
    const empty: ChannelNiche = { title: "", subscribers: "", niche: "", error: "" };

    const handle = await floodAware(() => tg.resolveChannelByUsername(username));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);
    if (!handle) return { ...empty, error: "канал не найден" };

    const gate = await floodAware(() => tg.getChannelGateInfo(handle.inputChannel));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);

    const posts = await floodAware(() => tg.getRecentPosts(handle.inputChannel, N_POSTS));
    await sleepRandom(INTRA_CHANNEL_MIN_SEC, INTRA_CHANNEL_MAX_SEC);

    const texts = posts.map((p: ChannelPost) => p.text.trim()).filter((t) => t.length > 0);
    const about = gate.about ?? "";
    if (about.trim().length === 0 && texts.length === 0) {
        return {
            title: handle.title,
            subscribers: gate.subscribers != null ? String(gate.subscribers) : "",
            niche: "",
            error: "нет текста (about пуст, посты без текста)",
        };
    }

    try {
        const r = await llm.completeObject({ system: NICHE_SYSTEM, prompt: classifyNiche(handle.title, about, texts) }, nicheSchema);
        return {
            title: handle.title,
            subscribers: gate.subscribers != null ? String(gate.subscribers) : "",
            niche: r.niche ?? "",
            error: "",
        };
    } catch (err: any) {
        return {
            title: handle.title,
            subscribers: gate.subscribers != null ? String(gate.subscribers) : "",
            niche: "",
            error: `LLM: ${err?.message ?? err}`,
        };
    }
}

// ─── Один воркер = один аккаунт внутри волны ────────────────────────────

interface WorkerResult {
    agentId: string;
    done: number;
    stopReason: string; // "квота выбрана" | "очередь пуста" | причина FLOOD/деградации | "fatal: ..."
}

/**
 * Общее состояние волны, шарится между всеми воркерами синхронно (без await
 * между чтением и записью) — гонок при параллельном доступе не возникает,
 * т.к. Node однопоточный и каждый доступ к nextLink()/processed укладывается
 * в один синхронный тик.
 */
interface SharedQueue {
    nextLink(): string | undefined;
    processed: Set<string>;
    outputPath: string;
}

async function runWorker(
    agentId: string,
    batchSize: number,
    llm: ReturnType<typeof createLlmClient>,
    queue: SharedQueue,
): Promise<WorkerResult> {
    const tg = new TelegramService(log);
    let done = 0;
    let consecutiveNotFound = 0;
    let consecutiveSessionErrors = 0;
    let stopReason = "";

    const stop = (reason: string): never => { throw new WorkerStop(reason); };
    const floodAware = makeFloodAware(stop);
    let locked = false;

    try {
        // Замок берём ДО loadAccount: если агента уже держит другой живой процесс,
        // подключаться нельзя — два коннекта одной сессией дают AUTH_KEY_DUPLICATED.
        acquireSession(agentId, "channel-niche");
        locked = true;
        tg.loadAccount(agentId);

        for (;;) {
            if (done >= batchSize) { stopReason = `квота из ${batchSize} каналов выбрана`; break; }

            const raw = queue.nextLink();
            if (raw === undefined) { stopReason = "очередь пуста"; break; }

            const { key, username } = resolveLinkKey(raw);
            if (queue.processed.has(key)) continue; // уже обработано в прошлом прогоне — просто следующая ссылка

            let result: ChannelNiche;
            if (!username) {
                result = { title: "", subscribers: "", niche: "", error: "приватная ссылка, резолв по username невозможен" };
            } else {
                try {
                    result = await classifyChannel(tg, llm, username, floodAware);
                    consecutiveSessionErrors = 0;
                } catch (err) {
                    if (err instanceof WorkerStop) { stopReason = err.reason; break; }

                    // Сбой сессии/коннекта: канал НЕ осмотрен. Не пишем строку и не
                    // помечаем ссылку обработанной — иначе она потеряется навсегда,
                    // хотя виноват аккаунт. Ссылку подберёт следующий проход.
                    if (err instanceof ClientNotConnectedError) {
                        if (err instanceof SessionRevokedError || err instanceof AccountBannedError) {
                            stopReason = `сессия непригодна (${err.message}) — аккаунту нужен перелогин`;
                            break;
                        }
                        consecutiveSessionErrors += 1;
                        log.warn(
                            `[channel-niche:${agentId}] ${key} — ссылка возвращена в очередь, сбой сессии ` +
                            `(${consecutiveSessionErrors}/${MAX_CONSECUTIVE_SESSION_ERRORS}): ${err.message}`,
                        );
                        if (consecutiveSessionErrors >= MAX_CONSECUTIVE_SESSION_ERRORS) {
                            stopReason = `${MAX_CONSECUTIVE_SESSION_ERRORS} сбоя сессии подряд — аккаунт снят с прогона`;
                            break;
                        }
                        continue;
                    }

                    result = { title: "", subscribers: "", niche: "", error: (err as any)?.message ?? String(err) };
                }
            }

            if (result.error === "канал не найден") {
                consecutiveNotFound += 1;
                if (consecutiveNotFound >= MAX_CONSECUTIVE_NOT_FOUND) {
                    fs.appendFileSync(queue.outputPath, csvRow([key, result.title, result.subscribers, result.niche, result.error]));
                    queue.processed.add(key);
                    done++;
                    stopReason = `"канал не найден" ${MAX_CONSECUTIVE_NOT_FOUND} раз(а) подряд (похоже на деградацию резолвинга сессии)`;
                    break;
                }
            } else {
                consecutiveNotFound = 0;
            }

            fs.appendFileSync(queue.outputPath, csvRow([key, result.title, result.subscribers, result.niche, result.error]));
            queue.processed.add(key);
            done++;
            log.info(`[channel-niche:${agentId}] ${key} — ${result.error ? `error: ${result.error}` : `niche="${result.niche}"`}`);

            await sleepRandom(INTER_CHANNEL_MIN_SEC, INTER_CHANNEL_MAX_SEC);
        }
    } catch (err: any) {
        // Занятая сессия — не аварийная ситуация: агент просто пропускается, его
        // доля ссылок достаётся другим воркерам волны (или следующему проходу).
        stopReason = err instanceof SessionBusyError
            ? `пропущен — ${err.message}`
            : `fatal: ${err?.message ?? err}`;
    } finally {
        await tg.disconnect().catch(() => {});
        if (locked) releaseSession(agentId);
    }

    log.info(`[channel-niche:${agentId}] воркер остановлен — обработано ${done}, причина: ${stopReason}`);
    return { agentId, done, stopReason };
}

// ─── Прогон ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const inputPath = parseArg(argv, "--input");
    const outputPath = parseArg(argv, "--output");
    // --agents принимает список через запятую; --agent остаётся алиасом для
    // одного аккаунта (прежние вызовы не ломаются — просто волна из одного).
    const agentsRaw = parseArg(argv, "--agents") ?? parseArg(argv, "--agent");
    const batchSizeRaw = parseArg(argv, "--batch-size");
    const parallelRaw = parseArg(argv, "--parallel");
    // Повторять проходы, пока список не разобран (замена внешнему bash-циклу).
    const untilDone = argv.includes("--until-done");
    // Дедуп обязателен: два воркера одного агента живут в ОДНОМ процессе, а замок
    // сессии реентрантный (он защищает от чужих процессов, а не от самого себя) —
    // такая пара пошла бы в Telegram одной сессией и получила AUTH_KEY_DUPLICATED.
    const agentIdsRaw = (agentsRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const agentIds = [...new Set(agentIdsRaw)];
    if (agentIds.length !== agentIdsRaw.length) {
        log.warn(
            `[channel-niche] в --agents повторы (${agentIdsRaw.length} → ${agentIds.length} уникальных): ` +
            "один агент = одна сессия, дубликаты отброшены",
        );
    }
    const batchSize = batchSizeRaw ? Number(batchSizeRaw) : AGENT_BATCH_SIZE;
    const parallelism = parallelRaw ? Number(parallelRaw) : DEFAULT_PARALLELISM;

    if (
        !inputPath || !outputPath || agentIds.length === 0 ||
        !Number.isFinite(batchSize) || batchSize <= 0 ||
        !Number.isFinite(parallelism) || parallelism <= 0
    ) {
        log.error(
            "usage: tsx src/scripts/ops/channel-niche.ts --input <links.csv> --output <niches.csv> " +
            "--agents <agentId1,agentId2,...> [--batch-size 55] [--parallel 10] [--until-done]",
        );
        process.exit(1);
    }

    const links = readInputLinks(inputPath);
    const processed = readProcessedLinks(outputPath);
    const waves = chunk(agentIds, parallelism);
    log.info(
        `[channel-niche] агенты=${agentIds.length} (волнами по ${parallelism}, ${waves.length} волн(ы)), ` +
        `батч ${batchSize}/аккаунт, вход: ${links.length} ссылок, уже обработано: ${processed.size}`,
    );

    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8").trim().length === 0) {
        fs.writeFileSync(outputPath, csvRow(OUTPUT_COLUMNS));
    }

    const llm = createLlmClient();

    let cursor = 0;
    const queue: SharedQueue = {
        nextLink: () => (cursor < links.length ? links[cursor++] : undefined),
        processed,
        outputPath,
    };

    let totalDone = 0;

    for (let pass = 1; ; pass++) {
        // Каждый проход перечитывает очередь с начала: уже обработанные ссылки
        // отсекает queue.processed, а недобранные из-за квоты/пропущенных агентов
        // достаются воркерам этого прохода.
        cursor = 0;
        let passDone = 0;

        for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
            if (cursor >= links.length) break; // очередь уже вся разобрана предыдущими волнами
            const waveAgents = waves[waveIdx];
            log.info(`[channel-niche] проход ${pass}, волна ${waveIdx + 1}/${waves.length}: агенты=${waveAgents.join(",")}`);

            const results = await Promise.all(waveAgents.map((agentId) => runWorker(agentId, batchSize, llm, queue)));
            for (const r of results) passDone += r.done;

            const waveSummary = results.map((r) => `${r.agentId}=${r.done} (${r.stopReason})`).join("; ");
            log.info(`[channel-niche] проход ${pass}, волна ${waveIdx + 1}/${waves.length} завершена: ${waveSummary}`);
        }

        totalDone += passDone;
        const left = links.length - processed.size;

        if (!untilDone || left <= 0) break;
        // Проход, не обработавший ни одного канала (все агенты заняты/деградировали),
        // означает, что повторять бессмысленно — иначе прогон крутился бы вхолостую.
        if (passDone === 0) {
            log.warn(`[channel-niche] проход ${pass} не обработал ни одного канала — останавливаюсь, остаток ${left}`);
            break;
        }
        log.info(`[channel-niche] проход ${pass} завершён: +${passDone}, остаток ${left} — продолжаю (--until-done)`);
        await sleep(PASS_PAUSE_MS);
    }

    const remaining = links.length - processed.size;
    const tail = remaining > 0
        ? `, необработанного остатка: ${remaining} ` +
          "(перезапустите с тем же --output, чтобы добить остаток; --until-done повторяет проходы сам)"
        : "";
    log.info(`[channel-niche] done — всего обработано за прогон: ${totalDone}${tail}`);
}

main().catch((err) => {
    log.error(`[channel-niche] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
