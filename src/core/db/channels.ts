// core/db/channels.ts — состояние батч-обработки каналов, DM-кандидаты,
// классификация сообщений и групповые треды.
//
// Перенесено из прежнего channels-db.ts: тела инструментов превращены в обычные
// экспортируемые функции без TypeBox и без формата { content: [...] }. Поведение
// и SQL сохранены (R-B2). Логирование инжектируется через Logger (DIP).

import * as fs from "fs";
import Database from "better-sqlite3";
import { channelsDbPath, CHANNEL_CHECK_PERIOD_SECONDS } from "../config";
import type { Logger } from "../logger";
import type { ChannelIdentity } from "../telegram/service";
import {
    findThreadByAgentMsgId,
    createThread,
    updateThread,
    expireOldThreads,
    findReplyByReplyMsgId,
    type ThreadMessage,
} from "./replies";

// ─── Constants ────────────────────────────────────────────────────────

/** Количество каналов, возвращаемых за один прогон по умолчанию */
const DEFAULT_BATCH_LIMIT = 50;
/**
 * Период обхода каждого канала по умолчанию — дефолт параметра `getChannelsBatch`
 * для прямых вызовов вне `monitor.ts` (который всегда передаёт период явно).
 * Источник истины значения — `CHANNEL_CHECK_PERIOD_SECONDS` в core/config.ts.
 */
const DEFAULT_PERIOD_SECONDS = CHANNEL_CHECK_PERIOD_SECONDS;
/** Период истечения тредов по умолчанию: 4 дня в секундах */
const DEFAULT_THREAD_EXPIRE_SECONDS = 345600;

// ─── Types ────────────────────────────────────────────────────────────

export type ChannelStatus = "banned" | "format_error" | "suspend" | "only_comment" | "sleep" | "should_leave" | "leaved_from_banned" | "leaved_manual" | "not_found";

interface ChannelRow {
    chatId: string;
    title: string;
    lastProcessedAt: number;
    /** telegram-error-handling: 'banned'/'suspend' останавливает обработку канала в monitor-v2, 'format_error' — нет. */
    status: ChannelStatus | null;
}

export interface ClassifyInputMessage {
    id: number;
    fromId: string;
    fromName: string;
    text: string;
    date: number;
    userAccessHash?: string;
    replyToMsgId?: number;
    /** Id корневого сообщения ветки обсуждения (post-freshness-gate, случай A). */
    replyToTopId?: number;
    /** Сообщение — служебная копия поста канала (post-freshness-gate, случай B). */
    isChannelPost?: boolean;
}

export interface AgentReplyRecord {
    msgId: number;
    msgText: string;
    replyMsgId: number;
    replyText: string;
}

export interface NewThreadEntry {
    agentReplyRecord: AgentReplyRecord;
    messages: ClassifyInputMessage[];
}

export interface ThreadReplyEntry {
    threadId: number;
    threadStatus: string;
    threadMessages: ThreadMessage[];
    newMessages: ClassifyInputMessage[];
}

export interface ClassifyResult {
    generalMessages: ClassifyInputMessage[];
    newThreadMessages: NewThreadEntry[];
    threadReplies: ThreadReplyEntry[];
}

export interface DmCandidateRow {
    id: number;
    userId: string;
    userAccessHash: string | null;
    sourceChatId: string;
    msgId: number;
    msgText: string;
    score: number;
    scoreReason: string | null;
    status: string;
    createdAt: number;
}

export interface DmCandidateRecord {
    userId: string;
    userAccessHash?: string;
    sourceChatId: string;
    msgId: number;
    msgText: string;
    score: number;
    scoreReason?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function openDb(dbPath: string, readonly = false): Database.Database {
    return new Database(dbPath, { readonly });
}

function ensureDmCandidatesTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS dm_candidates (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            userId         TEXT NOT NULL,
            userAccessHash TEXT,
            sourceChatId   TEXT NOT NULL,
            msgId          INTEGER NOT NULL,
            msgText        TEXT NOT NULL,
            score          REAL DEFAULT 0,
            scoreReason    TEXT,
            status         TEXT DEFAULT 'pending',
            createdAt      INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_candidates_msg
            ON dm_candidates (sourceChatId, msgId);
        CREATE INDEX IF NOT EXISTS idx_dm_candidates_status
            ON dm_candidates (status, score DESC);
    `);
}

// ─── Channels ─────────────────────────────────────────────────────────

export function initChannels(agentId: string, log: Logger): { ok: true } {
    const dbPath = channelsDbPath(agentId);
    log.info(`[tg-channels-db] tg_channels_init called — agentId=${agentId} dbPath=${dbPath}`);
    const db = openDb(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS channels (
                chatId            TEXT    PRIMARY KEY,
                title             TEXT    NOT NULL,
                lastProcessedAt   INTEGER NOT NULL DEFAULT 0,
                channelId         TEXT,
                channelAccessHash TEXT,
                channelUsername   TEXT,
                channelResolved   INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_lastProcessedAt
                ON channels(lastProcessedAt ASC);
            CREATE TABLE IF NOT EXISTS sync_state (
                id             INTEGER PRIMARY KEY CHECK (id = 1),
                lastFullSyncAt INTEGER NOT NULL DEFAULT 0
            );
        `);
        migrateChannelIdentityColumns(db);
        migrateCoverageColumns(db);
        migrateChatUsernameColumn(db);
        migrateStatusColumns(db);
        migratePostWatchColumns(db);
        migrateChannelContextColumns(db);
        migrateActivityColumns(db);
        log.info(`[tg-channels-db] tg_channels_init — done`);
        return { ok: true };
    } finally {
        db.close();
    }
}

/**
 * Аддитивная миграция колонок идентичности привязанного канала (channel-content-analysis):
 * существующие БД (до этих колонок) получают их через ALTER TABLE без потери данных.
 * channelResolved=0 у старых строк ⇒ они будут добраны резолвом на ближайших синках.
 */
function migrateChannelIdentityColumns(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map((c) => c.name);
    const add = (name: string, decl: string) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE channels ADD COLUMN ${name} ${decl}`);
    };
    add("channelId", "TEXT");
    add("channelAccessHash", "TEXT");
    add("channelUsername", "TEXT");
    add("channelTitle", "TEXT");
    add("channelResolved", "INTEGER NOT NULL DEFAULT 0");
}

function migrateCoverageColumns(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map((c) => c.name);
    const add = (name: string, decl: string) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE channels ADD COLUMN ${name} ${decl}`);
    };
    add("avg_views", "REAL");
    if (cols.includes("avg_views_updated_at") && !cols.includes("coverage_updated_at")) {
        db.exec(`ALTER TABLE channels RENAME COLUMN avg_views_updated_at TO coverage_updated_at`);
    } else {
        add("coverage_updated_at", "INTEGER");
    }
    add("subs_count", "INTEGER");
}

/**
 * Аддитивная миграция колонки username самого чата (funnel-tracking v3, US-5).
 * Не путать с `channelUsername` (migrateChannelIdentityColumns) — та хранит
 * username привязанного broadcast-канала обсуждения, другую сущность.
 */
function migrateChatUsernameColumn(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("chatUsername")) db.exec(`ALTER TABLE channels ADD COLUMN chatUsername TEXT`);
}

/**
 * Аддитивная миграция колонок статуса канала (telegram-error-handling):
 * `status` ('banned' | 'format_error' | 'suspend' | NULL) и время последнего
 * обновления. `statusDurationSeconds`/`status_description`
 * (channel-suspend-on-deletion) — длительность действия статуса (NULL =
 * бессрочно, как у существующих `banned`/`format_error`) и свободный текст
 * причины, без фиксированной таксономии (по аналогии с `send_errors.errorCode`).
 */
function migrateStatusColumns(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map((c) => c.name);
    const add = (name: string, decl: string) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE channels ADD COLUMN ${name} ${decl}`);
    };
    add("status", "TEXT");
    add("statusUpdatedAt", "INTEGER");
    add("statusDurationSeconds", "INTEGER");
    add("status_description", "TEXT");
}

/**
 * Аддитивная миграция колонок отслеживания поста (channel-post-watch):
 * `lastSeenChannelPostId` — id последнего поста канала (в его собственной
 * нумерации, не чата обсуждения), который агент уже разобрал — либо
 * прокомментировал, либо осознанно отклонил (префильтр/LLM, см.
 * `markPostSeen`); `watchedThreadRootMsgId` — id служебной копии
 * прокомментированного поста в чате обсуждения, заполняется только при
 * успешной отправке комментария (`savePostWatchComment`). Обе nullable.
 * `lastSeenChannelPostId` не сбрасывается по истечении статусов
 * `only_comment`/`sleep` — служит защитой от повторной реакции/повторной
 * оценки того же поста в каналах, где посты выходят редко.
 */
function migratePostWatchColumns(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map((c) => c.name);
    const add = (name: string, decl: string) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE channels ADD COLUMN ${name} ${decl}`);
    };
    add("lastSeenChannelPostId", "INTEGER");
    add("watchedThreadRootMsgId", "INTEGER");
    // Кэш резолва целевого дня (monitor-v4, design.md решение 3) —
    // `lastCheckedTargetDate` ("YYYY-MM-DD" по Asia/Yekaterinburg) и
    // `lastCheckedTargetPostId` (id найденного поста; NULL = день резолвлен,
    // постов не было) экономят повторный обход веб-превью внутри одного и
    // того же целевого дня. Не путать с `lastSeenChannelPostId` выше — та
    // защищает от повторной РЕАКЦИИ, эта пара — от повторного ОБНАРУЖЕНИЯ.
    add("lastCheckedTargetDate", "TEXT");
    add("lastCheckedTargetPostId", "INTEGER");
    // chatAccessHash (post-comment-review, design.md решение 5) — персистентный
    // аналог channelAccessHash (accessHash broadcast-канала), но для самого чата
    // (channels.chatId). Заполняется оппортунистически, когда peerCache и так
    // узнаёт этот accessHash. Нужна, чтобы review-listener на свежем MTProto-
    // соединении мог отправить сообщение без похода в getDialogs — peerCache
    // живёт только в памяти процесса и не переживает рестарт.
    add("chatAccessHash", "TEXT");
}

/**
 * Аддитивная миграция колонок фонового анализа контента канала (channel-context):
 * `channel_context` — свободный текст-описание канала (10-50 строк, без
 * фиксированной структуры), `channel_context_updated_at` — unix-время последнего
 * анализа, источник TTL-отбора в `getChannelsForContextAnalysis` (90 дней).
 * Существующие `avg_views`/`subs_count` (см. `migrateCoverageColumns`) этой фичей
 * не заводятся заново — она пишет в них через уже существующий `saveCoverage`
 * (design.md channel-context, решение D3: общий кэш, `coverage_updated_at` не
 * трогается).
 */
function migrateChannelContextColumns(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map((c) => c.name);
    const add = (name: string, decl: string) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE channels ADD COLUMN ${name} ${decl}`);
    };
    add("channel_context", "TEXT");
    add("channel_context_updated_at", "INTEGER");
}

/**
 * Аддитивная миграция колонок активности чата (channel-activity-percentiles):
 * `active_writers_p50`/`active_writers_p90` — 50-й/90-й перцентиль числа
 * уникальных отправителей сообщений в сутки за скользящее окно 7 дней,
 * `activity_updated_at` — TTL-метка последнего пересчёта (30 дней, как
 * `coverage_updated_at`, но отдельная колонка — считается независимым
 * скриптом-джобом с собственным расписанием на канал).
 */
function migrateActivityColumns(db: Database.Database): void {
    const cols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map((c) => c.name);
    const add = (name: string, decl: string) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE channels ADD COLUMN ${name} ${decl}`);
    };
    add("active_writers_p50", "REAL");
    add("active_writers_p90", "REAL");
    add("activity_updated_at", "INTEGER");
}

/** Статусы, которые считаются терминальными (агент сам не участник чата) — channel-not-found-recovery. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    "banned", "suspend", "leaved_from_banned", "leaved_manual", "should_leave",
]);

/**
 * Синхронизирует таблицу channels с актуальными диалогами Telegram.
 * Карта chatId → {title, username} подготавливается вызывающей стороной
 * (TelegramService), чтобы слой БД не зависел от Telegram.
 *
 * channel-not-found-recovery: пропавшие из диалогов каналы больше не
 * удаляются — активный статус (null/only_comment/sleep/format_error)
 * переводится в 'not_found' (обратимо), терминальный статус не трогается
 * (агент и не должен быть в диалоге, если сам вышел/забанен). Канал,
 * вернувшийся в диалоги со status='not_found', возвращается в null.
 */
export function syncChannels(
    agentId: string,
    telegramChannels: Map<string, { title: string; username: string | null }>,
    log: Logger,
): { ok: true; added: number; updated: number; markedNotFound: number; clearedNotFound: number } {
    log.info(`[tg-channels-db] tg_channels_sync called — agentId=${agentId}`);
    const db = openDb(channelsDbPath(agentId));
    try {
        const dbChannels = new Map(
            (db.prepare("SELECT chatId, title, chatUsername, status FROM channels").all() as
                { chatId: string; title: string; chatUsername: string | null; status: string | null }[])
                .map(({ chatId, title, chatUsername, status }) => [chatId, { title, chatUsername, status }]),
        );

        const toAdd = [...telegramChannels.entries()].filter(([chatId]) => !dbChannels.has(chatId));
        const toUpdate = [...telegramChannels.entries()].filter(([chatId, { title, username }]) => {
            const existing = dbChannels.get(chatId);
            return existing !== undefined && (existing.title !== title || existing.chatUsername !== username);
        });

        // Пропали из диалогов: активный статус → not_found, терминальный — не трогаем.
        const toMarkNotFound = [...dbChannels.entries()]
            .filter(([chatId, { status }]) => !telegramChannels.has(chatId) && !TERMINAL_STATUSES.has(status ?? "") && status !== "not_found")
            .map(([chatId]) => chatId);

        // Снова в диалогах и раньше были not_found → снять статус.
        const toClearNotFound = [...telegramChannels.keys()]
            .filter((chatId) => dbChannels.get(chatId)?.status === "not_found");

        const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO channels (chatId, title, chatUsername, lastProcessedAt)
            VALUES (@chatId, @title, @chatUsername, 0)
        `);
        const updateStmt = db.prepare(`UPDATE channels SET title = @title, chatUsername = @chatUsername WHERE chatId = @chatId`);
        const markNotFoundStmt = db.prepare(`UPDATE channels SET status = 'not_found', statusUpdatedAt = strftime('%s','now') WHERE chatId = ?`);
        const clearNotFoundStmt = db.prepare(`UPDATE channels SET status = NULL, statusUpdatedAt = NULL WHERE chatId = ?`);

        db.transaction(() => {
            for (const [chatId, { title, username }] of toAdd) insertStmt.run({ chatId, title, chatUsername: username });
            for (const [chatId, { title, username }] of toUpdate) updateStmt.run({ chatId, title, chatUsername: username });
            for (const chatId of toMarkNotFound) markNotFoundStmt.run(chatId);
            for (const chatId of toClearNotFound) clearNotFoundStmt.run(chatId);
        })();

        log.info(
            `[tg-channels-db] tg_channels_sync — added=${toAdd.length} updated=${toUpdate.length} markedNotFound=${toMarkNotFound.length} clearedNotFound=${toClearNotFound.length}`,
        );
        return {
            ok: true,
            added: toAdd.length,
            updated: toUpdate.length,
            markedNotFound: toMarkNotFound.length,
            clearedNotFound: toClearNotFound.length,
        };
    } finally {
        db.close();
    }
}

export function getChannelsBatch(
    agentId: string,
    log: Logger,
    limit = DEFAULT_BATCH_LIMIT,
    periodSeconds = DEFAULT_PERIOD_SECONDS,
): { channels: ChannelRow[] } {
    log.info(
        `[tg-channels-db] tg_channels_get_batch called — agentId=${agentId} limit=${limit} periodSeconds=${periodSeconds}`,
    );
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const rows = db.prepare(`
            SELECT chatId, title, lastProcessedAt, status
            FROM channels
            WHERE (lastProcessedAt = 0
               OR lastProcessedAt <= strftime('%s','now') - @periodSeconds)
               AND (status IS NULL OR status NOT IN ('banned', 'suspend', 'leaved_from_banned', 'leaved_manual', 'should_leave', 'not_found'))
            ORDER BY lastProcessedAt ASC
            LIMIT @limit
        `).all({ periodSeconds, limit }) as ChannelRow[];

        log.info(`[tg-channels-db] tg_channels_get_batch — returned ${rows.length} channels`);
        return { channels: rows };
    } finally {
        db.close();
    }
}

/**
 * Due ли полная синхронизация списка каналов (monitor-v5-human-pacing-batching):
 * тот же periodSeconds-паттерн, что и у getChannelsBatch — прошло ли
 * periodSeconds с последнего lastFullSyncAt (0 = ещё не синхронизировались).
 */
export function isFullSyncDue(agentId: string, log: Logger, periodSeconds: number): boolean {
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const row = db.prepare(`SELECT lastFullSyncAt FROM sync_state WHERE id = 1`).get() as
            | { lastFullSyncAt: number }
            | undefined;
        const lastFullSyncAt = row?.lastFullSyncAt ?? 0;
        const due = lastFullSyncAt === 0 || lastFullSyncAt <= Math.floor(Date.now() / 1000) - periodSeconds;
        log.info(`[tg-channels-db] full_sync_due — agentId=${agentId} lastFullSyncAt=${lastFullSyncAt} due=${due}`);
        return due;
    } finally {
        db.close();
    }
}

/** Отметить полную синхронизацию выполненной текущим временем. */
export function markFullSyncDone(agentId: string, log: Logger): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        db.prepare(`
            INSERT INTO sync_state (id, lastFullSyncAt) VALUES (1, strftime('%s','now'))
            ON CONFLICT(id) DO UPDATE SET lastFullSyncAt = excluded.lastFullSyncAt
        `).run();
        log.info(`[tg-channels-db] full_sync_done — agentId=${agentId}`);
    } finally {
        db.close();
    }
}

/** Общее число каналов агента (этап 1 воронки «каналов у агента»). */
export function countChannels(agentId: string): number {
    if (!fs.existsSync(channelsDbPath(agentId))) return 0;
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM channels`).get() as { c: number };
        return row.c;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

export function markChannelProcessed(agentId: string, chatId: string, log: Logger): { ok: true } {
    log.info(`[tg-channels-db] tg_channels_mark_processed called — agentId=${agentId} chatId=${chatId}`);
    const db = openDb(channelsDbPath(agentId));
    try {
        const result = db.prepare(`
            UPDATE channels
            SET lastProcessedAt = strftime('%s','now')
            WHERE chatId = ?
        `).run(chatId);

        if (result.changes === 0) {
            log.error(`[tg-channels-db] tg_channels_mark_processed — chatId=${chatId} not found`);
            throw new Error(`Channel ${chatId} not found in database`);
        }

        log.info(`[tg-channels-db] tg_channels_mark_processed — updated chatId=${chatId}`);
        return { ok: true };
    } finally {
        db.close();
    }
}

// ─── Статус канала (telegram-error-handling) ───────────────────────────

/**
 * Проставляет статус канала (`banned`/`format_error`) и время обновления
 * (`monitor-v2`, на шаге обработки исхода отправки ответа). `banned` —
 * останавливает обработку канала (см. проверку в `getChannelsBatch`
 * потребителем), `format_error` — только метка, не влияет на обработку.
 */
/**
 * `durationSeconds` — длительность действия статуса в секундах; `undefined`/не
 * передан = бессрочно (текущее поведение `banned`/`format_error`, без
 * изменений). `description` — свободный текст причины (channel-suspend-on-deletion),
 * без фиксированной таксономии.
 */
export function markChannelStatus(
    agentId: string,
    chatId: string,
    status: ChannelStatus,
    log: Logger,
    durationSeconds?: number,
    description?: string,
): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        migrateStatusColumns(db);
        db.prepare(`
            UPDATE channels
            SET status = @status, statusUpdatedAt = @now, statusDurationSeconds = @durationSeconds, status_description = @description
            WHERE chatId = @chatId
        `).run({
            status,
            now: Math.floor(Date.now() / 1000),
            durationSeconds: durationSeconds ?? null,
            description: description ?? null,
            chatId,
        });
        log.info(`[tg-channels-db] markChannelStatus — agentId=${agentId} chatId=${chatId} status=${status} durationSeconds=${durationSeconds ?? "infinite"}`);
    } finally {
        db.close();
    }
}

export interface ChannelStatusInfoRow {
    chatId: string;
    channelUsername: string | null;
    chatUsername: string | null;
    status: ChannelStatus | null;
    statusUpdatedAt: number | null;
}

/**
 * Каналы агента с идентичностью и статусом (channel-not-found-recovery,
 * разовая миграция cat4/cat5) — сырьё для сопоставления с `join_queue` по
 * `channelUsername`/`chatUsername` (в очереди нет `chatId`).
 */
export function getChannelsStatusInfo(agentId: string, log: Logger): ChannelStatusInfoRow[] {
    const dbPath = channelsDbPath(agentId);
    if (!fs.existsSync(dbPath)) return [];
    const db = openDb(dbPath, true);
    try {
        const rows = db.prepare(`
            SELECT chatId, channelUsername, chatUsername, status, statusUpdatedAt FROM channels
        `).all() as ChannelStatusInfoRow[];
        log.info(`[tg-channels-db] getChannelsStatusInfo — agentId=${agentId} returned=${rows.length}`);
        return rows;
    } finally {
        db.close();
    }
}

/**
 * Разовая миграция (channel-not-found-recovery, cat4/cat5): сбрасывает статус
 * и всё связанное с ним (`statusUpdatedAt`/`statusDurationSeconds`/
 * `status_description`) в NULL для перечисленных `chatId` — тем же набором
 * полей, что и self-heal при join (`upsertChannelIdentityFromJoin`), но для
 * каналов, которые уже стоят в `channels.db` и не проходят через join заново.
 */
export function resetChannelStatuses(agentId: string, chatIds: string[], log: Logger): { reset: number } {
    if (chatIds.length === 0) return { reset: 0 };
    const db = openDb(channelsDbPath(agentId));
    try {
        migrateStatusColumns(db);
        const placeholders = chatIds.map(() => "?").join(",");
        const result = db.prepare(`
            UPDATE channels
            SET status = NULL, statusUpdatedAt = NULL, statusDurationSeconds = NULL, status_description = NULL
            WHERE chatId IN (${placeholders})
        `).run(...chatIds);
        log.info(`[tg-channels-db] resetChannelStatuses — agentId=${agentId} reset=${result.changes}`);
        return { reset: result.changes };
    } finally {
        db.close();
    }
}

/**
 * Снимает статусы с истёкшей длительностью (channel-suspend-on-deletion) —
 * `statusDurationSeconds IS NOT NULL` и с момента `statusUpdatedAt` прошло
 * больше этого числа секунд. Бессрочные статусы (`statusDurationSeconds IS
 * NULL`, т.е. текущие `banned`/`format_error`) не затрагиваются.
 */
export function expireChannelStatuses(agentId: string, log: Logger): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        migrateStatusColumns(db);
        const now = Math.floor(Date.now() / 1000);
        const result = db.prepare(`
            UPDATE channels
            SET status = NULL, statusUpdatedAt = NULL, statusDurationSeconds = NULL, status_description = NULL
            WHERE statusDurationSeconds IS NOT NULL AND @now >= statusUpdatedAt + statusDurationSeconds
        `).run({ now });
        if (result.changes > 0) {
            log.info(`[tg-channels-db] expireChannelStatuses — agentId=${agentId} expired=${result.changes}`);
        }
    } finally {
        db.close();
    }
}

/**
 * Число каналов агента со `status='banned'`, у которых `statusUpdatedAt`
 * попадает в последние `windowSeconds` — правило «2 канала banned за 2 дня»
 * (agent-restrictions, суспенд-триггер 2). Считается ПОСЛЕ простановки
 * статуса текущему каналу (включает его).
 */
export function countRecentlyBannedChannels(agentId: string, windowSeconds: number): number {
    if (!fs.existsSync(channelsDbPath(agentId))) return 0;
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
        const row = db.prepare(`
            SELECT COUNT(*) AS c FROM channels WHERE status = 'banned' AND statusUpdatedAt >= @cutoff
        `).get({ cutoff }) as { c: number };
        return row.c;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

/**
 * Число каналов агента, у которых `status='banned'` появился в окне
 * [startSec, endSec) — отчётные сутки воронки (funnel-report-restrictions),
 * не скользящее окно от `now()` (см. `countRecentlyBannedChannels` для триггера suspend).
 */
export function countChannelsBannedInWindow(agentId: string, startSec: number, endSec: number): number {
    if (!fs.existsSync(channelsDbPath(agentId))) return 0;
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c FROM channels
            WHERE status = 'banned' AND statusUpdatedAt >= @startSec AND statusUpdatedAt < @endSec
        `).get({ startSec, endSec }) as { c: number };
        return row.c;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

/**
 * Число каналов агента, у которых `status='suspend'` появился в окне
 * [startSec, endSec) — отчётные сутки воронки (channel-suspend-on-deletion),
 * по образцу `countChannelsBannedInWindow`.
 */
export function countChannelsSuspendedInWindow(agentId: string, startSec: number, endSec: number): number {
    if (!fs.existsSync(channelsDbPath(agentId))) return 0;
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c FROM channels
            WHERE status = 'suspend' AND statusUpdatedAt >= @startSec AND statusUpdatedAt < @endSec
        `).get({ startSec, endSec }) as { c: number };
        return row.c;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

// ─── Отслеживание поста канала (channel-post-watch) ────────────────────

export interface PostWatchChannelRow {
    chatId: string;
    title: string;
    channelId: string;
    channelAccessHash: string;
    channelUsername: string;
    status: ChannelStatus | null;
    statusUpdatedAt: number | null;
    lastSeenChannelPostId: number | null;
    watchedThreadRootMsgId: number | null;
    chatAccessHash: string | null;
    /** Кэш резолва целевого дня (monitor-v4) — см. `saveTargetDayCache`. */
    lastCheckedTargetDate: string | null;
    lastCheckedTargetPostId: number | null;
    /** Свободное текстовое описание канала (channel-context, monitor-v4 generatePostCommentV5) — nullable, TTL 90 дней. */
    channel_context: string | null;
}

/**
 * Активные каналы с публичным username (channel-post-watch, design-v1.md
 * §0.5) — `status` NULL/`format_error`/`only_comment`, `channelUsername`
 * задан (значит и `channelId`/`channelAccessHash` уже резолвлены).
 * `banned`/`suspend`/`sleep` исключаются на уровне запроса — тем же
 * способом, каким `getChannelsBatch` исключает `banned`/`suspend`, не
 * проверкой в цикле monitor-v3.
 */
export function getPostWatchChannels(agentId: string, log: Logger): PostWatchChannelRow[] {
    const dbPath = channelsDbPath(agentId);
    if (!fs.existsSync(dbPath)) return [];
    const db = openDb(dbPath, true);
    try {
        const rows = db.prepare(`
            SELECT chatId, title, channelId, channelAccessHash, channelUsername,
                   status, statusUpdatedAt, lastSeenChannelPostId, watchedThreadRootMsgId,
                   chatAccessHash, lastCheckedTargetDate, lastCheckedTargetPostId, channel_context
            FROM channels
            WHERE channelUsername IS NOT NULL
              AND (status IS NULL OR status IN ('format_error', 'only_comment'))
        `).all() as PostWatchChannelRow[];
        log.info(`[tg-channels-db] getPostWatchChannels — agentId=${agentId} returned ${rows.length} channels`);
        return rows;
    } finally {
        db.close();
    }
}

/**
 * Записывает id прокомментированного поста и корня ветки обсуждения после
 * успешной отправки комментария (`monitor-v3`). Установку `status =
 * 'only_comment'` делает отдельно `markChannelStatus` — эта функция только
 * про сами id, не про статус.
 */
export function savePostWatchComment(
    agentId: string,
    chatId: string,
    params: { lastSeenChannelPostId: number; watchedThreadRootMsgId: number },
    log: Logger,
): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        migratePostWatchColumns(db);
        db.prepare(`
            UPDATE channels
            SET lastSeenChannelPostId = @lastSeenChannelPostId, watchedThreadRootMsgId = @watchedThreadRootMsgId
            WHERE chatId = @chatId
        `).run({ ...params, chatId });
        log.info(
            `[tg-channels-db] savePostWatchComment — agentId=${agentId} chatId=${chatId} postId=${params.lastSeenChannelPostId} threadRoot=${params.watchedThreadRootMsgId}`,
        );
    } finally {
        db.close();
    }
}

/**
 * Помечает пост как разобранный без отправки комментария — префильтр
 * отсеял текст или LLM решила не писать (`monitor-v3`). Пишет только
 * `lastSeenChannelPostId`, не трогает `watchedThreadRootMsgId` и статус
 * канала: в отличие от `savePostWatchComment`, тут нет реального
 * комментария и нет ветки обсуждения, за которой следить. Без этой
 * пометки один и тот же отклонённый пост фетчится и оценивается заново
 * на каждом следующем прогоне, пока не устареет по freshness-гейту.
 */
export function markPostSeen(agentId: string, chatId: string, postId: number, log: Logger): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        migratePostWatchColumns(db);
        db.prepare(`
            UPDATE channels
            SET lastSeenChannelPostId = @postId
            WHERE chatId = @chatId
        `).run({ postId, chatId });
        log.info(`[tg-channels-db] markPostSeen — agentId=${agentId} chatId=${chatId} postId=${postId}`);
    } finally {
        db.close();
    }
}

/**
 * Сохраняет результат резолва целевого дня (monitor-v4, design.md решение 3):
 * `postId = null` — валидный резолв «в этом дне постов не было», не «попробовать
 * снова». Вызывается только при успешной проверке (`ok: true` у
 * `fetchLastPostInDateRange`) — при отказе проверки (`ok: false`) кэш не
 * трогается, вызывающий (`monitor-v4`) просто не вызывает эту функцию.
 */
export function saveTargetDayCache(
    agentId: string,
    chatId: string,
    params: { dateKey: string; postId: number | null },
    log: Logger,
): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        migratePostWatchColumns(db);
        db.prepare(`
            UPDATE channels
            SET lastCheckedTargetDate = @dateKey, lastCheckedTargetPostId = @postId
            WHERE chatId = @chatId
        `).run({ dateKey: params.dateKey, postId: params.postId, chatId });
        log.info(
            `[tg-channels-db] saveTargetDayCache — agentId=${agentId} chatId=${chatId} dateKey=${params.dateKey} postId=${params.postId ?? "null"}`,
        );
    } finally {
        db.close();
    }
}

/**
 * Персистит accessHash чата обсуждения, когда `TelegramService.peerCache`
 * узнаёт его в текущем прогоне (post-comment-review, design.md решение 5).
 * Не блокирует остальную обработку канала при сбое — вызывающий (`monitor-v3`)
 * не должен падать из-за этого.
 */
export function saveChatAccessHash(agentId: string, chatId: string, accessHash: string, log: Logger): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        migratePostWatchColumns(db);
        db.prepare(`UPDATE channels SET chatAccessHash = @accessHash WHERE chatId = @chatId`)
            .run({ accessHash, chatId });
    } finally {
        db.close();
    }
}

/**
 * Персистентный accessHash чата обсуждения (post-comment-review) — для
 * review-listener, который на свежем MTProto-соединении сидирует peerCache
 * напрямую из БД (design.md решение 5), без похода в getDialogs.
 */
export function getChatAccessHash(agentId: string, chatId: string, log: Logger): string | null {
    const dbPath = channelsDbPath(agentId);
    if (!fs.existsSync(dbPath)) return null;
    const db = openDb(dbPath, true);
    try {
        const row = db.prepare(`SELECT chatAccessHash FROM channels WHERE chatId = ?`).get(chatId) as { chatAccessHash: string | null } | undefined;
        if (!row) log.warn(`[tg-channels-db] getChatAccessHash — agentId=${agentId} chatId=${chatId} не найден`);
        return row?.chatAccessHash ?? null;
    } finally {
        db.close();
    }
}

// ─── Идентичность привязанного канала (channel-content-analysis) ──────

/** Канал агента в таблице channels с резолвленной идентичностью привязанного канала. */
export interface AnalysisChannelRow {
    chatId: string;
    title: string;
    channelId: string;
    channelAccessHash: string;
    channelUsername: string | null;
}

/**
 * Чаты, у которых идентичность привязанного канала ещё не определена
 * (`channelResolved = 0`) — для инкрементального резолва на синхронизации. Лимит
 * размазывает разовый бэкафилл старых строк по тикам монитора.
 */
export function getUnresolvedChats(agentId: string, log: Logger, limit = 20): string[] {
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const rows = db.prepare(
            `SELECT chatId FROM channels WHERE channelResolved = 0 LIMIT @limit`,
        ).all({ limit }) as { chatId: string }[];
        return rows.map((r) => r.chatId);
    } finally {
        db.close();
    }
}

/**
 * Сохраняет идентичность привязанного канала чата и помечает его резолвленным.
 * `identity = null` ⇒ у чата нет привязанного канала (обычная группа) — помечаем
 * резолвленным с пустой идентичностью, чтобы не резолвить повторно.
 */
export function saveChannelIdentity(
    agentId: string,
    chatId: string,
    identity: ChannelIdentity | null,
    log: Logger,
): { ok: true } {
    const db = openDb(channelsDbPath(agentId));
    try {
        db.prepare(`
            UPDATE channels
            SET channelId = @channelId, channelAccessHash = @accessHash,
                channelUsername = @username, channelTitle = @title, channelResolved = 1
            WHERE chatId = @chatId
        `).run({
            chatId,
            channelId: identity?.channelId ?? null,
            accessHash: identity?.accessHash ?? null,
            username: identity?.username ?? null,
            title: identity?.title ?? null,
        });
        return { ok: true };
    } finally {
        db.close();
    }
}

export interface JoinedChannelIdentityRow {
    chatId: string;
    title: string;
    chatAccessHash: string;
    chatUsername: string | null;
    channelId: string;
    channelAccessHash: string;
    channelUsername: string | null;
}

/**
 * Записывает identity канала сразу при успешном вступлении через join-queue
 * (join-queue-populate-channel-identity) — вместо ожидания следующего
 * syncChannels/cacheChannelIdentities, которая иначе делает повторный
 * GetFullChannel за тот же факт. `initChannels` — на случай, если это первое
 * обращение к channels.db у агента (join-queue может отработать раньше
 * первого тика монитора).
 *
 * channel-not-found-recovery (design D2): для уже существующей строки
 * обновление ПОЛНОЕ — `status`/`statusUpdatedAt`/`statusDurationSeconds`/
 * `status_description` сбрасываются в NULL безусловно (в т.ч. если было
 * `banned`), `title`/`chatUsername` освежаются. Успешное вступление — это
 * подтверждённый факт членства, поэтому любой прежний статус (в частности
 * залипший `leaved_manual`) неактуален. `lastProcessedAt`, история визитов и
 * метрики этим шагом не затрагиваются.
 */
export function upsertChannelIdentityFromJoin(
    agentId: string,
    identity: JoinedChannelIdentityRow,
    log: Logger,
): void {
    initChannels(agentId, log);
    const db = openDb(channelsDbPath(agentId));
    try {
        db.prepare(`
            INSERT INTO channels (chatId, title, chatUsername, lastProcessedAt, channelId, channelAccessHash, channelUsername, channelResolved, chatAccessHash)
            VALUES (@chatId, @title, @chatUsername, 0, @channelId, @channelAccessHash, @channelUsername, 1, @chatAccessHash)
            ON CONFLICT(chatId) DO UPDATE SET
                title = excluded.title,
                chatUsername = excluded.chatUsername,
                channelId = excluded.channelId,
                channelAccessHash = excluded.channelAccessHash,
                channelUsername = excluded.channelUsername,
                channelResolved = 1,
                chatAccessHash = excluded.chatAccessHash,
                status = NULL,
                statusUpdatedAt = NULL,
                statusDurationSeconds = NULL,
                status_description = NULL
        `).run(identity);
        log.info(`[tg-channels-db] upsertChannelIdentityFromJoin — agentId=${agentId} chatId=${identity.chatId}`);
    } finally {
        db.close();
    }
}

/** Каналы агента с резолвленной идентичностью (для прогона анализа). */
export function getAnalysisChannels(agentId: string, log: Logger): AnalysisChannelRow[] {
    const db = openDb(channelsDbPath(agentId), true);
    try {
        return db.prepare(`
            SELECT chatId, title, channelId, channelAccessHash, channelUsername
            FROM channels
            WHERE channelResolved = 1 AND channelId IS NOT NULL
        `).all() as AnalysisChannelRow[];
    } finally {
        db.close();
    }
}

// ─── Фоновый анализ контента канала (channel-context) ──────────────────

/**
 * Каналы, отобранные на анализ контекста (design.md channel-context, решение D2):
 * та же резолвленная идентичность привязанного broadcast-канала, что и
 * `getAnalysisChannels` (`channelResolved=1 AND channelId IS NOT NULL`), БЕЗ
 * фильтра по `status` (banned/suspend не исключаются — сознательное решение
 * оператора, анализ описывает канал как источник контента, а не как канал для
 * активности агента). TTL — `ttlSeconds`, по умолчанию отбираются каналы без
 * анализа (`channel_context_updated_at IS NULL`, идут первыми) либо с истёкшим
 * анализом, `LIMIT limit`.
 */
export function getChannelsForContextAnalysis(
    agentId: string,
    log: Logger,
    limit: number,
    ttlSeconds: number,
): AnalysisChannelRow[] {
    const dbPath = channelsDbPath(agentId);
    if (!fs.existsSync(dbPath)) return [];
    const db = openDb(dbPath, true);
    try {
        const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;
        const rows = db.prepare(`
            SELECT chatId, title, channelId, channelAccessHash, channelUsername
            FROM channels
            WHERE channelResolved = 1 AND channelId IS NOT NULL
              AND (channel_context_updated_at IS NULL OR channel_context_updated_at <= @cutoff)
            ORDER BY channel_context_updated_at IS NOT NULL, channel_context_updated_at ASC
            LIMIT @limit
        `).all({ cutoff, limit }) as AnalysisChannelRow[];
        log.info(`[tg-channels-db] getChannelsForContextAnalysis — agentId=${agentId} returned ${rows.length} channels`);
        return rows;
    } finally {
        db.close();
    }
}

/**
 * Сохраняет результат анализа контекста канала (channel-context) — только
 * `channel_context`/`channel_context_updated_at`. `avg_views`/`subs_count`
 * сохраняются отдельно через уже существующий `saveCoverage` (независимо от
 * исхода LLM-анализа — design.md решение D3, fail-soft для LLM не должен терять
 * уже пересчитанные подписчики/охват).
 */
export function saveChannelContext(agentId: string, chatId: string, context: string, log: Logger): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        migrateChannelContextColumns(db);
        db.prepare(`
            UPDATE channels
            SET channel_context = @context, channel_context_updated_at = strftime('%s','now')
            WHERE chatId = @chatId
        `).run({ context, chatId });
        log.info(`[tg-channels-db] saveChannelContext — agentId=${agentId} chatId=${chatId}`);
    } finally {
        db.close();
    }
}

// ─── DM candidates ────────────────────────────────────────────────────

export function insertDmCandidate(agentId: string, record: DmCandidateRecord, log: Logger): { ok: true } {
    log.info(
        `[tg-channels-db] dm_candidates_insert called — agentId=${agentId} sourceChatId=${record.sourceChatId} msgId=${record.msgId}`,
    );
    const db = openDb(channelsDbPath(agentId));
    try {
        ensureDmCandidatesTable(db);
        const { userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason } = record;
        const now = Math.floor(Date.now() / 1000);
        db.prepare(`
            INSERT OR IGNORE INTO dm_candidates
                (userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason, status, createdAt)
            VALUES
                (@userId, @userAccessHash, @sourceChatId, @msgId, @msgText, @score, @scoreReason, 'pending', @createdAt)
        `).run({
            userId,
            userAccessHash: userAccessHash ?? null,
            sourceChatId,
            msgId,
            msgText,
            score,
            scoreReason: scoreReason ?? null,
            createdAt: now,
        });

        log.info(`[tg-channels-db] dm_candidates_insert — done`);
        return { ok: true };
    } finally {
        db.close();
    }
}

export function getPendingDmCandidates(agentId: string, limit: number, log: Logger): { candidates: DmCandidateRow[] } {
    log.info(`[tg-channels-db] dm_candidates_get_pending called — agentId=${agentId} limit=${limit}`);
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const rows = db.prepare(`
            SELECT id, userId, userAccessHash, sourceChatId, msgId, msgText, score, scoreReason, status, createdAt
            FROM dm_candidates
            WHERE status = 'pending'
            ORDER BY score DESC
            LIMIT @limit
        `).all({ limit }) as DmCandidateRow[];

        log.info(`[tg-channels-db] dm_candidates_get_pending — returned ${rows.length} rows`);
        return { candidates: rows };
    } finally {
        db.close();
    }
}

export function updateDmCandidateStatus(agentId: string, id: number, status: string, log: Logger): { ok: true } {
    log.info(`[tg-channels-db] dm_candidates_update_status called — agentId=${agentId} id=${id} status=${status}`);
    const db = openDb(channelsDbPath(agentId));
    try {
        const result = db.prepare(`
            UPDATE dm_candidates SET status = @status WHERE id = @id
        `).run({ status, id });

        if (result.changes === 0) {
            throw new Error(`dm_candidates row id=${id} not found`);
        }

        log.info(`[tg-channels-db] dm_candidates_update_status — done`);
        return { ok: true };
    } finally {
        db.close();
    }
}

export function expireOldDmCandidates(agentId: string, olderThanDays: number, log: Logger): { ok: true; expired: number } {
    log.info(`[tg-channels-db] dm_candidates_expire_old called — agentId=${agentId} olderThanDays=${olderThanDays}`);
    const db = openDb(channelsDbPath(agentId));
    try {
        const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
        const result = db.prepare(`
            UPDATE dm_candidates
            SET status = 'expired'
            WHERE status = 'pending' AND createdAt < @cutoff
        `).run({ cutoff });

        log.info(`[tg-channels-db] dm_candidates_expire_old — expired ${result.changes} rows`);
        return { ok: true, expired: result.changes };
    } finally {
        db.close();
    }
}

// ─── Classification ───────────────────────────────────────────────────

export function classifyMessages(
    agentId: string,
    chatId: string,
    messages: ClassifyInputMessage[],
    log: Logger,
): ClassifyResult {
    log.info(
        `[tg-channels-db] tg_classify_messages called — agentId=${agentId} chatId=${chatId} total=${messages.length}`,
    );
    const generalMessages: ClassifyInputMessage[] = [];
    const newThreadByReplyToMsgId = new Map<number, NewThreadEntry>();
    const threadRepliesByThreadId = new Map<number, ThreadReplyEntry>();

    for (const msg of messages) {
        if (msg.replyToMsgId === undefined || msg.replyToMsgId === null) {
            generalMessages.push(msg);
            continue;
        }

        const thread = findThreadByAgentMsgId(agentId, chatId, msg.replyToMsgId);
        if (thread) {
            let entry = threadRepliesByThreadId.get(thread.id);
            if (!entry) {
                entry = {
                    threadId: thread.id,
                    threadStatus: thread.status,
                    threadMessages: thread.messages,
                    newMessages: [],
                };
                threadRepliesByThreadId.set(thread.id, entry);
            }
            entry.newMessages.push(msg);
            continue;
        }

        const reply = findReplyByReplyMsgId(agentId, chatId, msg.replyToMsgId);
        if (reply) {
            let entry = newThreadByReplyToMsgId.get(msg.replyToMsgId);
            if (!entry) {
                entry = {
                    agentReplyRecord: {
                        msgId: reply.msgId,
                        msgText: reply.msgText ?? "",
                        replyMsgId: reply.replyMsgId ?? msg.replyToMsgId,
                        replyText: reply.replyText,
                    },
                    messages: [],
                };
                newThreadByReplyToMsgId.set(msg.replyToMsgId, entry);
            }
            entry.messages.push(msg);
            continue;
        }

        generalMessages.push(msg);
    }

    const newThreadMessages = Array.from(newThreadByReplyToMsgId.values());
    const threadReplies = Array.from(threadRepliesByThreadId.values());

    log.info(
        `[tg-channels-db] tg_classify_messages — general=${generalMessages.length} newThreads=${newThreadMessages.length} threadReplies=${threadReplies.length}`,
    );
    return { generalMessages, newThreadMessages, threadReplies };
}

// ─── Group threads ────────────────────────────────────────────────────

export function createGroupThread(
    agentId: string,
    params: { chatId: string; startMsgId: number; startMsgText: string; agentMsgId: number; agentMsgText: string },
    log: Logger,
): { ok: true; threadId: number } {
    log.info(
        `[tg-channels-db] tg_group_thread_create called — agentId=${agentId} chatId=${params.chatId} startMsgId=${params.startMsgId}`,
    );
    const messages: ThreadMessage[] = [
        { role: "user", msgId: params.startMsgId, text: params.startMsgText },
        { role: "agent", msgId: params.agentMsgId, text: params.agentMsgText },
    ];
    const threadId = createThread(agentId, params.chatId, params.startMsgId, messages, params.agentMsgId);
    log.info(`[tg-channels-db] tg_group_thread_create — created threadId=${threadId}`);
    return { ok: true, threadId };
}

export function updateGroupThread(
    agentId: string,
    threadId: number,
    newMessages: string,
    newAgentMsgId: number,
    log: Logger,
): { ok: true } {
    log.info(
        `[tg-channels-db] tg_group_thread_update called — agentId=${agentId} threadId=${threadId} newAgentMsgId=${newAgentMsgId}`,
    );
    const parsed = JSON.parse(newMessages) as ThreadMessage[];
    updateThread(agentId, threadId, parsed, newAgentMsgId);
    log.info(`[tg-channels-db] tg_group_thread_update — done threadId=${threadId}`);
    return { ok: true };
}

export function expireGroupThreads(
    agentId: string,
    log: Logger,
    olderThanSeconds = DEFAULT_THREAD_EXPIRE_SECONDS,
): { ok: true; expired: number } {
    log.info(`[tg-channels-db] tg_group_thread_expire called — agentId=${agentId} olderThanSeconds=${olderThanSeconds}`);
    const expired = expireOldThreads(agentId, olderThanSeconds);
    log.info(`[tg-channels-db] tg_group_thread_expire — expired ${expired} threads`);
    return { ok: true, expired };
}

// ─── Журнал визитов монитора (funnel-tracking, этапы 2-3) ─────────────
//
// Append-only история визитов монитора в канал: на каждой итерации цикла
// монитор пишет факт визита и его исход. Состояние «последний визит» хранит
// `channels.lastProcessedAt`; здесь — именно история (нужна для дневного счёта
// просмотренных/активных каналов и медианы activityRate), которую состояние
// не даёт. Лежит в той же per-agent БД, что и `channels` — монитор уже её
// открывает каждый прогон. `agentId` не дублируется колонкой: файл БД уже
// per-agent.

export type VisitOutcome = "empty" | "active" | "error";

function ensureChannelVisitsTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS channel_visits (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId        TEXT    NOT NULL,
            visitedAt     INTEGER NOT NULL,
            outcome       TEXT    NOT NULL,
            messagesCount INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_channel_visits_chat_time
            ON channel_visits(chatId, visitedAt DESC);
    `);
}

/** Записать факт визита монитора в канал (этапы 2-3). `messagesCount`=0 для empty/error. */
export function recordChannelVisit(
    agentId: string,
    record: { chatId: string; outcome: VisitOutcome; messagesCount: number },
    log: Logger,
): { ok: true } {
    const db = openDb(channelsDbPath(agentId));
    try {
        ensureChannelVisitsTable(db);
        db.prepare(`
            INSERT INTO channel_visits (chatId, visitedAt, outcome, messagesCount)
            VALUES (@chatId, @visitedAt, @outcome, @messagesCount)
        `).run({
            chatId: record.chatId,
            visitedAt: Math.floor(Date.now() / 1000),
            outcome: record.outcome,
            messagesCount: record.messagesCount,
        });
        return { ok: true };
    } finally {
        db.close();
    }
}

/** Число визитов за окно [startSec, endSec): всего (просмотрено) и активных. */
export function countVisitsToday(
    agentId: string,
    startSec: number,
    endSec: number,
): { visited: number; active: number } {
    if (!fs.existsSync(channelsDbPath(agentId))) return { visited: 0, active: 0 };
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS visited,
                   SUM(CASE WHEN outcome = 'active' THEN 1 ELSE 0 END) AS active
            FROM channel_visits
            WHERE visitedAt >= @startSec AND visitedAt < @endSec
        `).get({ startSec, endSec }) as { visited: number; active: number | null };
        return { visited: row.visited, active: row.active ?? 0 };
    } catch {
        // Таблица ещё не создана (монитор не прогонялся) → 0.
        return { visited: 0, active: 0 };
    } finally {
        db.close();
    }
}

// ─── Журнал ошибок отправки (funnel-tracking, этап 4) ─────────────────
//
// Append-only журнал ошибок отправки по попытке/каналу — отдельно от `runs`
// (та хранит одну строку ошибки на весь прогон скилла, здесь — на отдельную
// попытку отправки в конкретном канале). Источники: монитор (ошибка
// get_messages, не-flood ошибка ответа) и dm-send (любой исход sendDm-ошибки).
// `errorCode` — те же строки, что код уже вычисляет, без новой таксономии.

export type SendErrorSource = "monitor" | "dm_send" | "monitor_v2" | "monitor_v3" | "monitor_v4" | "monitor_v5" | "review_listener";

export interface SendErrorBreakdownRow {
    errorCode: string;
    count: number;
}

export interface ProblemChannelRow {
    chatId: string;
    title: string | null;
    errorCode: string;
    count: number;
}

function ensureSendErrorsTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS send_errors (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId     TEXT    NOT NULL,
            occurredAt INTEGER NOT NULL,
            source     TEXT    NOT NULL,
            errorCode  TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_send_errors_time ON send_errors(occurredAt);
        CREATE INDEX IF NOT EXISTS idx_send_errors_chat ON send_errors(chatId, occurredAt);
    `);
}

/** Записать ошибку отправки в канале (этап 4). */
export function recordSendError(
    agentId: string,
    record: { chatId: string; source: SendErrorSource; errorCode: string },
    log: Logger,
): { ok: true } {
    const db = openDb(channelsDbPath(agentId));
    try {
        ensureSendErrorsTable(db);
        db.prepare(`
            INSERT INTO send_errors (chatId, occurredAt, source, errorCode)
            VALUES (@chatId, @occurredAt, @source, @errorCode)
        `).run({
            chatId: record.chatId,
            occurredAt: Math.floor(Date.now() / 1000),
            source: record.source,
            errorCode: record.errorCode,
        });
        return { ok: true };
    } finally {
        db.close();
    }
}

/**
 * Коды `send_errors`, не являющиеся ошибкой ОТПРАВКИ — сбой снятия статуса
 * диалога/чтения, не попытки что-то отправить (funnel-report). Пишутся в
 * `send_errors` как есть (видны в БД/логах для отладки), но не должны
 * попадать в «ошибок_отправки»/«Ошибки за день» отчёта воронки — иначе
 * читатель отчёта делает вывод о проблемах с отправкой там, где монитор
 * просто не смог прочитать канал (см. funnel-report 2026-08-29: 468 из 470
 * «ошибок» были dialog_status_unknown — промах peerCache, не отказ Telegram).
 */
const NON_SEND_ERROR_CODES = ["dialog_status_unknown"];
const NON_SEND_ERROR_CODES_SQL = NON_SEND_ERROR_CODES.map(() => "?").join(", ");

/** Число ошибок отправки агента за окно [startSec, endSec). */
export function countSendErrorsToday(agentId: string, startSec: number, endSec: number): number {
    if (!fs.existsSync(channelsDbPath(agentId))) return 0;
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c FROM send_errors
            WHERE occurredAt >= ? AND occurredAt < ? AND errorCode NOT IN (${NON_SEND_ERROR_CODES_SQL})
        `).get(startSec, endSec, ...NON_SEND_ERROR_CODES) as { c: number };
        return row.c;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

/**
 * Разбивка ошибок отправки агента по `errorCode` за окно. Агрегация по всем
 * агентам (для общего блока «Ошибки за день») делается слиянием результатов
 * этой per-agent функции на стороне отчёта — модуль остаётся per-agent.
 */
export function groupSendErrorsByCode(agentId: string, startSec: number, endSec: number): SendErrorBreakdownRow[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId), true);
    try {
        return db.prepare(`
            SELECT errorCode, COUNT(*) AS count FROM send_errors
            WHERE occurredAt >= ? AND occurredAt < ? AND errorCode NOT IN (${NON_SEND_ERROR_CODES_SQL})
            GROUP BY errorCode
            ORDER BY count DESC
        `).all(startSec, endSec, ...NON_SEND_ERROR_CODES) as SendErrorBreakdownRow[];
    } catch {
        return [];
    } finally {
        db.close();
    }
}

// ─── Очередь каналов на выход (leave-banned-channels) ──────────────────
//
// Per-agent очередь работ: каналы со status IN ('banned', 'should_leave') —
// 'banned' проставляется монитором при CHAT_WRITE_FORBIDDEN, 'should_leave' —
// вручную оператором (вне скоупа этого модуля). Скилл leave-banned-channels
// обходит выборку, выходит из канала, чистит данные и проставляет терминальный
// статус (leave-banned-terminal-status): 'banned' → 'leaved_from_banned',
// 'should_leave' → 'leaved_manual' — не сброс в NULL.
// Раньше очередь дублировалась отдельной таблицей banned_channels —
// убрано (leave-banned-human-pacing), источник — только channels.status.

export interface LeaveQueueRow {
    chatId: string;
    statusUpdatedAt: number | null;
    /** Исходный триггер очереди — выбирает терминальный статус после выхода (leave-banned-terminal-status). */
    status: "banned" | "should_leave";
}

/** Каналы, ожидающие выхода (status IN ('banned', 'should_leave')), по возрастанию statusUpdatedAt. */
export function getLeaveQueue(agentId: string, log: Logger, limit: number): LeaveQueueRow[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const rows = db.prepare(`
            SELECT chatId, statusUpdatedAt, status FROM channels
            WHERE status IN ('banned', 'should_leave')
            ORDER BY statusUpdatedAt ASC
            LIMIT @limit
        `).all({ limit }) as LeaveQueueRow[];
        log.info(`[tg-channels-db] getLeaveQueue — agentId=${agentId} limit=${limit} returned=${rows.length}`);
        return rows;
    } catch {
        // Таблицы/колонок ещё нет → пустая очередь.
        return [];
    } finally {
        db.close();
    }
}

/**
 * Терминальный статус канала после успешного выхода (leave-banned-terminal-status)
 * — зависит от исходного триггера очереди (`LeaveQueueRow.status`), не сброс в
 * NULL: 'banned' → 'leaved_from_banned', 'should_leave' → 'leaved_manual'.
 * statusUpdatedAt — время завершения выхода; statusDurationSeconds/
 * status_description относились к пред-выходной классификации, после выхода
 * не актуальны — сбрасываются в NULL.
 */
export function setLeftChannelStatus(
    agentId: string,
    chatId: string,
    status: "leaved_from_banned" | "leaved_manual",
    log: Logger,
): { ok: true } {
    const db = openDb(channelsDbPath(agentId));
    try {
        db.prepare(`
            UPDATE channels
            SET status = @status, statusUpdatedAt = strftime('%s','now'), statusDurationSeconds = NULL, status_description = NULL
            WHERE chatId = @chatId
        `).run({ chatId, status });
        log.info(`[tg-channels-db] setLeftChannelStatus — agentId=${agentId} chatId=${chatId} status=${status}`);
        return { ok: true };
    } finally {
        db.close();
    }
}

/**
 * Удаляет DM-кандидатов агента по каналу после выхода (leave-banned-channels):
 * только `dm_candidates` (по `sourceChatId`, tg-channels.db). `channels`,
 * `channel_visits` (tg-channels.db), `replies`, `group_threads`,
 * `group_thread_agent_msgs` (tg-replies.db) сохраняются — telegram-error-handling
 * №24 (to-be) сузил прежнюю полную очистку до одной таблицы, для истории/
 * отчётности по каналу. `send_errors`/`dm_threads` по-прежнему не трогаются.
 * Строку `channels` не удаляет — терминальный статус проставляется отдельно (setLeftChannelStatus).
 */
export function purgeChannelData(agentId: string, chatId: string, log: Logger): { ok: true } {
    const db = openDb(channelsDbPath(agentId));
    try {
        ensureDmCandidatesTable(db);
        db.prepare(`DELETE FROM dm_candidates WHERE sourceChatId = ?`).run(chatId);
    } finally {
        db.close();
    }
    log.info(`[tg-channels-db] purgeChannelData — agentId=${agentId} chatId=${chatId} (только dm_candidates; channels/channel_visits/replies/group_threads сохранены)`);
    return { ok: true };
}

// ─── Очередь ротации (channel-rotation) ────────────────────────────────
//
// Кросс-агентная суточная задача переносит каналы, покинутые из-за бана
// (status='leaved_from_banned'), менее загруженному активному агенту.
// Ссылка для повторного вступления — channelUsername (юзернейм привязанного
// broadcast-канала, тот же приём, что channel-cleanup: normalizeChannelLink
// (channelUsername) → forceAssignChannel/addJoinQueue). Без channelUsername
// канал непередаваем — нет ссылки для нового агента.

export interface RotationCandidateRow {
    chatId: string;
    channelUsername: string;
    statusUpdatedAt: number | null;
}

/**
 * Каналы агента в статусе 'leaved_from_banned' с известным channelUsername —
 * кандидаты на перенос другому агенту, по возрастанию statusUpdatedAt
 * (дольше всего висящие без хозяина — первыми).
 */
export function getRotationCandidates(agentId: string, log: Logger): RotationCandidateRow[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const rows = db.prepare(`
            SELECT chatId, channelUsername, statusUpdatedAt FROM channels
            WHERE status = 'leaved_from_banned' AND channelUsername IS NOT NULL
            ORDER BY statusUpdatedAt ASC
        `).all() as RotationCandidateRow[];
        log.info(`[tg-channels-db] getRotationCandidates — agentId=${agentId} returned=${rows.length}`);
        return rows;
    } catch {
        return [];
    } finally {
        db.close();
    }
}

/**
 * Число каналов агента в статусе 'leaved_from_banned' без channelUsername —
 * непередаваемые ротацией (нет ссылки для нового агента), считаются отдельно
 * для сводки прогона channel-rotation.
 */
export function countLeavedFromBannedWithoutUsername(agentId: string): number {
    if (!fs.existsSync(channelsDbPath(agentId))) return 0;
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c FROM channels WHERE status = 'leaved_from_banned' AND channelUsername IS NULL
        `).get() as { c: number };
        return row.c;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

/**
 * Активная нагрузка агента (channel-rotation) — число каналов, не исключённых
 * фильтром «активен для обработки» (тот же список статусов, что getChannelsBatch).
 * Используется для сортировки целевых агентов по возрастанию нагрузки.
 */
export function countActiveChannels(agentId: string): number {
    if (!fs.existsSync(channelsDbPath(agentId))) return 0;
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS c FROM channels
            WHERE status IS NULL OR status NOT IN ('banned', 'suspend', 'leaved_from_banned', 'leaved_manual', 'should_leave', 'not_found')
        `).get() as { c: number };
        return row.c;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

/**
 * Удаляет строку канала у агента-источника после успешного переноса другому
 * агенту (channel-rotation) — канал уже покинут (leaveChannel выполнен
 * leave-banned-channels ранее), данные ему на этом агенте больше не нужны.
 */
export function deleteChannelRow(agentId: string, chatId: string, log: Logger): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        const result = db.prepare(`DELETE FROM channels WHERE chatId = ?`).run(chatId);
        log.info(`[tg-channels-db] deleteChannelRow — agentId=${agentId} chatId=${chatId} deleted=${result.changes}`);
    } finally {
        db.close();
    }
}

// ─── Средний охват канала (channel-coverage-report) ──────────────────

export interface ChannelForAvgUpdate {
    chatId: string;
    channelId: string;
    channelAccessHash: string;
}

export interface CoverageChannelRow {
    chatId: string;
    title: string;
    channelUsername: string | null;
    avg_views: number | null;
    subs_count: number | null;
    coverage_updated_at: number | null;
}

export interface CleanupChannelRow {
    chatId: string;
    title: string;
    avg_views: number | null;
    subs_count: number | null;
    channelUsername: string | null;
    channelResolved: number;
}

/** Каналы, у которых TTL кэша coverage истёк или никогда не считался. */
export function getChannelsForCoverageUpdate(agentId: string, ttlSeconds: number): ChannelForAvgUpdate[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId), true);
    try {
        return db.prepare(`
            SELECT chatId, channelId, channelAccessHash
            FROM channels
            WHERE channelResolved = 1
              AND channelId IS NOT NULL
              AND (coverage_updated_at IS NULL
                   OR coverage_updated_at <= strftime('%s','now') - @ttlSeconds)
        `).all({ ttlSeconds }) as ChannelForAvgUpdate[];
    } finally {
        db.close();
    }
}

/** Сохранить результат вычисления avg_views и subs_count (null — если нет данных). */
export function saveCoverage(agentId: string, chatId: string, avgViews: number | null, subsCount: number | null): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        db.prepare(`
            UPDATE channels
            SET avg_views = @avgViews,
                subs_count = @subsCount,
                coverage_updated_at = strftime('%s','now')
            WHERE chatId = @chatId
        `).run({ avgViews, subsCount, chatId });
    } finally {
        db.close();
    }
}

/** Потенциальный охват агента: SUM(avg_views) по каналам из переданного списка chatId. */
export function sumAvgViewsForRepliedChannels(agentId: string, chatIds: string[]): number {
    if (chatIds.length === 0) return 0;
    if (!fs.existsSync(channelsDbPath(agentId))) return 0;
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const placeholders = chatIds.map(() => "?").join(",");
        const row = db.prepare(`
            SELECT COALESCE(SUM(avg_views), 0) AS potential_reach
            FROM channels
            WHERE chatId IN (${placeholders})
              AND avg_views IS NOT NULL
        `).get(...chatIds) as { potential_reach: number };
        return row.potential_reach;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

/** Все каналы агента с полями для отчёта об охвате. */
export function getAllChannelsWithAvgViews(agentId: string): CoverageChannelRow[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId));
    try {
        migrateCoverageColumns(db);
        return db.prepare(`
            SELECT chatId, title, channelUsername, avg_views, subs_count, coverage_updated_at
            FROM channels
        `).all() as CoverageChannelRow[];
    } finally {
        db.close();
    }
}

/** Все каналы агента для операции чистки. */
export function getChannelsForCleanup(agentId: string): CleanupChannelRow[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId), true);
    try {
        return db.prepare(`
            SELECT chatId, title, avg_views, subs_count, channelUsername, channelResolved
            FROM channels
        `).all() as CleanupChannelRow[];
    } finally {
        db.close();
    }
}

/** Проблемные каналы агента за окно: (канал, тип ошибки, число), с названием из `channels`. */
export function problemChannels(agentId: string, startSec: number, endSec: number): ProblemChannelRow[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId), true);
    try {
        return db.prepare(`
            SELECT se.chatId AS chatId, c.title AS title, se.errorCode AS errorCode, COUNT(*) AS count
            FROM send_errors se
            LEFT JOIN channels c ON c.chatId = se.chatId
            WHERE se.occurredAt >= @startSec AND se.occurredAt < @endSec
            GROUP BY se.chatId, se.errorCode
            ORDER BY count DESC
        `).all({ startSec, endSec }) as ProblemChannelRow[];
    } catch {
        return [];
    } finally {
        db.close();
    }
}

// ─── Разбивка по каналам со ссылкой (funnel-tracking v3, US-5) ────────

/**
 * Строки channels по списку chatId — для сборки разбивки по каналам (funnel-tracking).
 * `title`/`chatUsername` — сам чат (обсуждение); `channelTitle`/`channelUsername` —
 * привязанный broadcast-канал (channel-content-analysis), не путать друг с другом.
 */
export function getChatTitlesAndUsernames(
    agentId: string,
    chatIds: string[],
): Map<string, { title: string; chatUsername: string | null; channelTitle: string | null; channelUsername: string | null }> {
    if (chatIds.length === 0) return new Map();
    if (!fs.existsSync(channelsDbPath(agentId))) return new Map();
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const placeholders = chatIds.map(() => "?").join(",");
        const rows = db.prepare(`
            SELECT chatId, title, chatUsername, channelTitle, channelUsername FROM channels WHERE chatId IN (${placeholders})
        `).all(...chatIds) as { chatId: string; title: string; chatUsername: string | null; channelTitle: string | null; channelUsername: string | null }[];
        return new Map(rows.map((r) => [r.chatId, { title: r.title, chatUsername: r.chatUsername, channelTitle: r.channelTitle, channelUsername: r.channelUsername }]));
    } catch {
        return new Map();
    } finally {
        db.close();
    }
}

/**
 * Переходимая ссылка на чат: публичный username → `t.me/<username>/<msgId>`;
 * приватная супергруппа/канал (marked id с префиксом `-100`) → `t.me/c/<internal>/<msgId>`
 * (internal = marked id без префикса `-100`). Требует msgId (формат `t.me/c/` без него
 * не строится, см. core.telegram.org/api/links) — возвращает null без него. «Базовые»
 * (не апгрейженные) группы Telegram не дают постоянной ссылки в принципе — null,
 * это свойство типа чата, не пробел данных.
 */
export function buildChannelUrl(chatId: string, chatUsername: string | null, msgId: number | null): string | null {
    if (msgId == null) return null;
    if (chatUsername) return `https://t.me/${chatUsername}/${msgId}`;
    if (chatId.startsWith("-100")) return `https://t.me/c/${chatId.slice(4)}/${msgId}`;
    return null;
}

// ─── Активность чата (channel-activity-percentiles) ───────────────────

export interface ChannelForActivityUpdate {
    chatId: string;
}

/**
 * Каналы, у которых TTL кэша активности истёк или никогда не считался —
 * все строки `channels` агента, без исключения `banned`/`suspend` (в отличие
 * от `getChannelsBatch`): метрика описывает канал как площадку независимо от
 * текущего статуса агента в нём.
 */
export function getChannelsForActivityUpdate(agentId: string, ttlSeconds: number): ChannelForActivityUpdate[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId), true);
    try {
        return db.prepare(`
            SELECT chatId
            FROM channels
            WHERE activity_updated_at IS NULL
               OR activity_updated_at <= strftime('%s','now') - @ttlSeconds
        `).all({ ttlSeconds }) as ChannelForActivityUpdate[];
    } finally {
        db.close();
    }
}

/**
 * Все каналы агента, без учёта TTL — для ручного пересчёта по явному списку
 * агентов (channel-activity-percentiles). Возвращает идентичность привязанного
 * канала тоже — ручной режим форсирует пересчёт ОБЕИХ групп метрик
 * (активность + `avg_views`/`subs_count`, design.md Decision 8), а охват
 * применим только к каналам с резолвленной идентичностью (`channelResolved=1
 * AND channelId IS NOT NULL`), как и в плановом режиме.
 */
export interface AllChannelRow {
    chatId: string;
    channelId: string | null;
    channelAccessHash: string | null;
    channelResolved: number;
}

export function getAllChannels(agentId: string): AllChannelRow[] {
    if (!fs.existsSync(channelsDbPath(agentId))) return [];
    const db = openDb(channelsDbPath(agentId), true);
    try {
        return db.prepare(`
            SELECT chatId, channelId, channelAccessHash, channelResolved FROM channels
        `).all() as AllChannelRow[];
    } finally {
        db.close();
    }
}

/**
 * Сохранить перцентили активности канала. Вызывается только при успешном
 * расчёте (0 — валидное значение для полностью тихого канала за окно, а не
 * признак ошибки) — при сбое чтения истории вызывающий SHALL NOT вызывать эту
 * функцию, оставляя предыдущие значения без изменений (Requirement
 * «Изоляция сбоев по каналу», channel-activity-percentiles).
 */
export function saveActivityPercentiles(agentId: string, chatId: string, p50: number, p90: number): void {
    const db = openDb(channelsDbPath(agentId));
    try {
        db.prepare(`
            UPDATE channels
            SET active_writers_p50 = @p50,
                active_writers_p90 = @p90,
                activity_updated_at = strftime('%s','now')
            WHERE chatId = @chatId
        `).run({ p50, p90, chatId });
    } finally {
        db.close();
    }
}

/** Перцентили активности по списку chatId — для резолва в CSV-разбивке funnel-отчёта. */
export function getActivityPercentilesByChatIds(
    agentId: string,
    chatIds: string[],
): Map<string, { p50: number | null; p90: number | null }> {
    if (chatIds.length === 0) return new Map();
    if (!fs.existsSync(channelsDbPath(agentId))) return new Map();
    const db = openDb(channelsDbPath(agentId), true);
    try {
        const placeholders = chatIds.map(() => "?").join(",");
        const rows = db.prepare(`
            SELECT chatId, active_writers_p50 AS p50, active_writers_p90 AS p90
            FROM channels WHERE chatId IN (${placeholders})
        `).all(...chatIds) as { chatId: string; p50: number | null; p90: number | null }[];
        return new Map(rows.map((r) => [r.chatId, { p50: r.p50, p90: r.p90 }]));
    } catch {
        return new Map();
    } finally {
        db.close();
    }
}
