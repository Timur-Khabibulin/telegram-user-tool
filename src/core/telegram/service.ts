// core/telegram/service.ts — MTProto-операции поверх GramJS.
//
// Чистое ядро Telegram: управление клиентом (ленивый singleton по аккаунту),
// peerCache и сами операции (dialogs, messages, mark_as_read, reply, send_dm,
// dm_dialogs, join). Не зависит от OpenClaw — логирование инжектируется через
// Logger, результаты возвращаются обычными объектами. Логика перенесена
// один-в-один из прежнего плагина (R-B2): лимиты, паузы, ретраи, обработка
// ошибок Telegram сохранены.

import * as fs from "fs";
import * as path from "path";
import { TelegramClient, Api, utils } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import bigInt from "big-integer";
import { StringSession } from "telegram/sessions";
import { ConnectionTCPObfuscated } from "telegram/network/connection/TCPObfuscated";
import { computeCheck } from "telegram/Password";
import type { Logger } from "../logger";
import type { AccountConfig, ProxyConfig } from "../config";
import { loadAccountConfig, FUNNEL_ADMIN_AGENT_ID, V5_SYNC_PAGE_SIZE, V5_SYNC_PAGE_DELAY_MIN_SEC, V5_SYNC_PAGE_DELAY_MAX_SEC } from "../config";
import { upsertRestriction, type RestrictionType } from "../db/agent-restrictions";
import { GramJsBridgeLogger } from "./gramjs-logger";
import { loadPersonaTemplate } from "../../features/tg-agent-autoregistration/persona-template";
import { createPersonaChannel } from "../tdata/account-setup";
import { acquireSession, releaseSession } from "./session-lock";
export { FloodWaitError, ClientNotConnectedError, MissingAccountConfigError, ConnectTimeoutError, SessionRevokedError, AccountBannedError } from "./errors";
import { FloodWaitError, ClientNotConnectedError, MissingAccountConfigError, ConnectTimeoutError, SessionRevokedError, AccountBannedError, parseFloodWait, classifyAccountError, classifyTelegramErrorTag, retryOnFloodWait } from "./errors";

// ─── Result types ─────────────────────────────────────────────────────

export interface GroupDialog {
    chatId: string;
    title: string;
    unreadCount: number;
    readInboxMaxId: number;
}

export interface TgMessage {
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

export interface DmDialog {
    userId: string;
    accessHash: string;
    userName: string | null;
    firstName: string | null;
    unreadCount: number;
    readInboxMaxId: number;
}

/**
 * Идентичность канала и его группы обсуждения, уже резолвленная в процессе
 * вступления (join-queue-populate-channel-identity) — избавляет от повторного
 * GetFullChannel в cacheChannelIdentities для каналов, вступление в которые
 * прошло через join-queue. Присутствует только при status='joined'.
 */
export interface JoinedChannelIdentity {
    chatId: string; // маркированный вид (-100…), через utils.getPeerId
    title: string;
    chatAccessHash: string;
    chatUsername: string | null;
    channelId: string;
    channelAccessHash: string;
    channelUsername: string | null;
}

export interface JoinResult {
    link: string;
    status: "joined" | "skipped";
    reason?: string;
    discussionChatId?: string;
    identity?: JoinedChannelIdentity;
}

export interface JoinSummary {
    joined: number;
    skipped: number;
    total: number;
    hadFloodWait: boolean;
    floodWaits: Array<{ link: string; waitSeconds: number }>;
    results: JoinResult[];
}

/**
 * Ожидаемый исход отправки DM: либо успех с messageId, либо штатная ошибка
 * Telegram (типизированный результат — coding-standards §6, ожидаемые ветвления).
 * Непредвиденные ошибки бросаются исключением.
 */
export type SendDmResult =
    | { ok: true; messageId: number }
    | { error: "privacy_blocked" | "deactivated" | "peer_id_invalid" | "peer_flood" | "flood_wait" };

export interface AuthSendCodeResult {
    phoneCodeHash: string;
    codeType: string;
}

/**
 * Override для ensureClient/requireClient (mobile-proxy-provisioning): прокси и/или бюджет
 * попыток на конкретный вызов, не затрагивая persistent AccountConfig/tg-account.json и не
 * попадая в кэш подключённых клиентов — вызывающий сам управляет жизненным циклом
 * (disconnect) возвращённого клиента при успехе. Без override поведение ensureClient не меняется.
 */
export interface EnsureClientOverride {
    proxy?: ProxyConfig;
    maxAttempts?: number;
    connectTimeoutMs?: number;
}


/** Канал как непрозрачная ручка для обхода рекомендаций (channel-discovery-similar). */
export interface ChannelHandle {
    inputChannel: Api.InputChannel;
    username: string | null;
    title: string;
    /** true — broadcast-канал, false — мегагруппа. Не все конструкторы ручки его знают (undefined). */
    isBroadcast?: boolean;
}

/** Канал из диалогов агента: broadcast-канал или мегагруппа (в т.ч. обсуждение). */
export interface DialogChannel extends ChannelHandle {
    isBroadcast: boolean;
    chatId: string; // marked id диалога (как в channels.db: вид -100…)
}

/**
 * Персистентная идентичность привязанного broadcast-канала (channel-content-analysis):
 * кэшируется в channels.db, чтобы анализ не резолвил канал на каждом прогоне. Поля —
 * строки (как chatId), чтобы пережить сериализацию в SQLite.
 */
export interface ChannelIdentity {
    channelId: string;
    accessHash: string;
    username: string | null;
    title: string;
}

/**
 * Пост broadcast-канала с метриками вовлечённости (channel-content-analysis).
 * Все счётчики берутся из объекта сообщения MTProto одной выборкой истории;
 * отсутствующие/выключенные — это валидный 0 (реакции/комментарии могут быть
 * отключены у канала), а не ошибка.
 */
export interface ChannelPost {
    id: number;
    text: string;
    date: number;      // unix-секунды
    views: number;     // 0 если нет
    reactions: number; // сумма m.reactions.results[].count, 0 если нет
    forwards: number;  // 0 если нет
    comments: number;  // m.replies.replies, 0 если обсуждение выключено
}

// ─── Helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Пауза между отключением от сессии и снятием замка. Сервер Telegram убирает
 * запись о подключении не мгновенно: отдать агента следующему процессу сразу
 * после disconnect() — значит показать серверу два подключения одним ключом и
 * получить безвозвратный AUTH_KEY_DUPLICATED (так был потерян agent126).
 * Диапазон случайный — как весь остальной пейсинг платформы.
 */
const POST_DISCONNECT_DELAY_MIN_SEC = 15;
const POST_DISCONNECT_DELAY_MAX_SEC = 22;
const randomDelayMs = (minSec: number, maxSec: number): number =>
    (minSec + Math.random() * (maxSec - minSec)) * 1000;

/**
 * Средний охват публикации канала (channel-coverage-update, channel-metrics): среднее
 * `views` по постам с индекса 1 по 10 включительно — самый свежий пост (индекс 0)
 * исключается, его охват ещё не набран. `null`, если постов меньше 2 (среднее не
 * имеет смысла). Единственный дом этой формулы — используется везде, где нужен
 * средний охват канала, чтобы не разойтись в двух местах кодовой базы.
 */
export function computeAvgViews(posts: ChannelPost[]): number | null {
    if (posts.length < 2) return null;
    const sample = posts.slice(1, 11);
    return sample.reduce((sum, p) => sum + p.views, 0) / sample.length;
}

/** Общий маппер сырого сообщения GramJS в `ChannelPost` — используется `getRecentPosts` и `getPostsOneByOne`. */
function mapMessageToPost(m: any): ChannelPost | null {
    if (typeof m?.id !== "number") return null;
    const reactions = Array.isArray(m.reactions?.results)
        ? m.reactions.results.reduce((sum: number, r: any) => sum + (typeof r.count === "number" ? r.count : 0), 0)
        : 0;
    return {
        id: m.id,
        text: typeof m.message === "string" ? m.message : "",
        date: typeof m.date === "number" ? m.date : 0,
        views: typeof m.views === "number" ? m.views : 0,
        reactions,
        forwards: typeof m.forwards === "number" ? m.forwards : 0,
        comments: typeof m.replies?.replies === "number" ? m.replies.replies : 0,
    };
}

/**
 * Потолок страниц дозапроса в getDialogsForBatch (group-monitoring): защита от
 * вырожденного случая (батч не пересекается с диалогами агента), не штатный
 * параметр тюнинга — см. design.md monitor-dialogs-pagination, Решение 4.
 */
const GET_DIALOGS_FOR_BATCH_MAX_PAGES = 5;

/** Лимит Telegram на число id за один вызов messages.getMessages/channels.getMessages (channel-suspend-on-deletion). */
const GET_MESSAGES_BY_ID_CHUNK_SIZE = 100;

function buildProxyOptions(proxy?: ProxyConfig) {
    if (!proxy) return {};
    // Аннотация сохраняет литеральный тип 5 | 4: вне контекста аргумента
    // TelegramClient числовой литерал иначе расширяется до number.
    const socksType: 5 | 4 = proxy.type === "socks5" ? 5 : 4;
    return {
        proxy: {
            socksType,
            ip: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            timeout: 10,
        },
    };
}

// ─── Service ──────────────────────────────────────────────────────────

export class TelegramService {
    // Клиенты Telegram — ленивый singleton по ключу аккаунта (accountId).
    //
    // Сколько клиентов в мапе — зависит от владельца инстанса сервиса:
    //   • Диспетчер (standalone, вне OpenClaw): один TelegramService на процесс,
    //     процесс обслуживает одного агента (--agent <id>) → загружается ОДИН
    //     аккаунт, в мапе РОВНО ОДИН клиент. Между прогонами инстанс не живёт.
    //   • Плагин OpenClaw: один общий TelegramService на весь gateway, шарится
    //     между всеми агентами → в мапе накапливаются клиенты ВСЕХ аккаунтов,
    //     которые загружались (по одному на accountId). При этом accountConfig —
    //     одно поле (последний loadAccount), поэтому «активный» аккаунт в моменте
    //     один, а мапа лишь хранит уже поднятые соединения для переиспользования.
    private readonly clients = new Map<string, TelegramClient>();
    // Сессии незавершённой авторизации, по номеру телефона.
    private readonly authSessions = new Map<string, TelegramClient>();
    // InputPeer-кэш: chatId/userId → InputPeer с access_hash.
    // Заполняется в getDialogs/getDmDialogs, где GramJS уже имеет полный
    // InputPeer. Используется в markAsRead/reply/sendDm — не восстанавливаем
    // пиров через getEntity(BigInt): in-memory кэш GramJS не переживает
    // пересоздание клиента и даёт PEER_ID_INVALID.
    private readonly peerCache = new Map<string, Api.TypeInputPeer>();

    private accountConfig: AccountConfig | null = null;
    // agentId последнего loadAccount — ключ замка сессии (session-lock). Именно
    // agentId, а не accountId: сессия живёт в workspace-<agentId>/tg-account.json,
    // и ключ должен быть одинаковым во всех процессах, иначе замок не защищает.
    private agentId: string | null = null;
    // clientKey → agentId: у gateway в мапе клиентов лежат сразу несколько
    // аккаунтов, и при выселении клиента надо снять замок именно его агента.
    private readonly agentIdByKey = new Map<string, string>();

    constructor(private readonly log: Logger) {}

    // ── Account ───────────────────────────────────────────────────────

    /** Загружает и фиксирует конфиг аккаунта агента. */
    loadAccount(agentId: string): { ok: true; accountId: string } {
        const configPath = `~/.openclaw/workspace-${agentId}/tg-account.json`;
        this.log.info(`[telegram-user-tool] tg_load_account — loading from ${configPath}`);
        const cfg = loadAccountConfig(agentId);
        this.accountConfig = cfg;
        this.agentId = agentId;
        this.log.info(`[telegram-user-tool] tg_load_account — loaded accountId=${cfg.accountId}`);
        return { ok: true, accountId: cfg.accountId };
    }

    private resolveAccountConfig(): AccountConfig {
        if (!this.accountConfig) {
            throw new Error("Account config not loaded. Call tg_load_account first.");
        }
        return this.accountConfig;
    }

    /** Конфиг аккаунта, загруженный через loadAccount() (agent-persona-template — резолв персоны). */
    getAccountConfig(): AccountConfig {
        return this.resolveAccountConfig();
    }

    private clientKey(accountId: string): string {
        return `tg-user:${accountId}`;
    }

    // ── Lazy client init ──────────────────────────────────────────────

    private async ensureClient(override?: EnsureClientOverride): Promise<TelegramClient> {
        const account = this.resolveAccountConfig();
        const proxy = override ? override.proxy : account.proxy;
        const key = this.clientKey(account.accountId);

        if (!override) {
            const existing = this.clients.get(key);
            if (existing) {
                if (existing.connected) return existing;
                // Лок НЕ снимаем: переподключение — продолжение той же непрерывной
                // работы этого процесса с агентом, а не её завершение. acquireSession
                // ниже для уже удерживаемого лока — no-op (реентрантность), поэтому
                // отпускать и брать заново незачем — только лишний зазор, в который
                // другой процесс мог бы забрать агента.
                await existing.disconnect().catch(() => {});
                this.clients.delete(key);
            }
        }

        // Замок на сессию берём ДО первого коннекта — здесь, а не в скиллах:
        // точка подключения одна на всех потребителей (скиллы, скрипты,
        // диспетчер, gateway), поэтому и защита от AUTH_KEY_DUPLICATED одна.
        // Замок реентрантный: в пределах процесса повторные подключения тем же
        // агентом (кэш клиентов, override-клиент провижининга) проходят свободно,
        // а чужой процесс получает SessionBusyError вместо второго коннекта.
        // Ключ — agentId; разные агенты друг друга не блокируют.
        const lockAgentId = this.agentId;
        if (lockAgentId) {
            acquireSession(lockAgentId, "telegram-user-tool");
        }

        if (!account.apiId || !account.apiHash) {
            this.log.error("[telegram-user-tool] ensureClient — missing apiId or apiHash");
            throw new MissingAccountConfigError(!account.apiId ? "apiId" : "apiHash");
        }
        if (!account.sessionString) {
            this.log.error("[telegram-user-tool] ensureClient — missing sessionString");
            throw new MissingAccountConfigError("sessionString");
        }

        const MAX_ATTEMPTS = override?.maxAttempts ?? 3;
        const CONNECT_TIMEOUT_MS = override?.connectTimeoutMs ?? 60_000;
        const proxyInfo = proxy ? ` via proxy ${proxy.host}:${proxy.port}` : "";

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            this.log.info(
                `[telegram-user-tool] ensureClient — attempt ${attempt}/${MAX_ATTEMPTS}, connecting...${proxyInfo}`,
            );

            const client = new TelegramClient(new StringSession(account.sessionString), account.apiId, account.apiHash, {
                connectionRetries: 1,
                autoReconnect: false,
                retryDelay: 1000,
                baseLogger: new GramJsBridgeLogger(this.log),
                deviceModel:    account.device?.deviceModel,
                systemVersion:  account.device?.systemVersion,
                appVersion:     account.device?.appVersion,
                // Фолбэк "ru", не "en" — агенты платформы всегда пишут по-русски,
                // независимо от гео прокси (см. device-pool.ts/device-assignment.ts).
                langCode:       account.device?.langCode       ?? "ru",
                systemLangCode: account.device?.systemLangCode ?? "ru",
                connection: ConnectionTCPObfuscated,
                useWSS: !proxy,
                ...buildProxyOptions(proxy),
            });

            try {
                const connectTimeout = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS),
                );
                await Promise.race([client.connect(), connectTimeout]);

                if (!override) {
                    this.clients.set(key, client);
                    if (lockAgentId) this.agentIdByKey.set(key, lockAgentId);
                }
                const me = await client.getMe();
                this.log.info(
                    `[telegram-user-tool] ensureClient — connected as ${(me as any).firstName ?? ""} ${(me as any).lastName ?? ""} (ID: ${me.id})`,
                );
                return client;
            } catch (err: any) {
                await client.disconnect().catch(() => {});
                this.log.warn(
                    `[telegram-user-tool] ensureClient — attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message ?? err}`,
                );
                if (attempt === MAX_ATTEMPTS) {
                    this.log.error(`[telegram-user-tool] ensureClient — all ${MAX_ATTEMPTS} attempts failed`);
                    // Подключиться не удалось — замок отпускаем (это и есть конец
                    // работы процесса с агентом), иначе неудачный коннект держал бы
                    // агента занятым до конца процесса (для долгоживущего gateway
                    // это заблокировало бы агента навсегда). Только если живого
                    // клиента этого агента в мапе не осталось. Та же пауза перед
                    // снятием, что в disconnect(): один из отклонённых attempt'ов
                    // мог успеть установить соединение с Telegram до сбоя на
                    // getMe()/login — серверу нужно время увидеть его закрытым.
                    if (!this.clients.has(key)) {
                        await sleep(randomDelayMs(POST_DISCONNECT_DELAY_MIN_SEC, POST_DISCONNECT_DELAY_MAX_SEC));
                        this.releaseFor(key, lockAgentId);
                    }
                    // RPC-ошибки GramJS несут code/errorMessage как сырые поля (не
                    // regex по форматированному message) — классификация по тексту/коду,
                    // не только 401 (telegram-error-handling, охватывает и API_ID_INVALID/
                    // деактивацию/заморозку, если они всплывают уже на connect()/getMe()).
                    const accountFailure = classifyAccountError(err);
                    if (accountFailure === "need_update_session") {
                        this.restrictAgent(lockAgentId, "need_update_session", err);
                        throw new SessionRevokedError(err.code, err.errorMessage ?? err.message);
                    }
                    if (accountFailure === "banned") {
                        this.restrictAgent(lockAgentId, "banned", err);
                        throw new AccountBannedError(err.code, err.errorMessage ?? err.message);
                    }
                    throw new ConnectTimeoutError(CONNECT_TIMEOUT_MS, attempt, MAX_ATTEMPTS, proxy, err);
                }
            }
        }

        // Недостижимо: цикл на последней попытке либо возвращает client, либо бросает.
        throw new ConnectTimeoutError(CONNECT_TIMEOUT_MS, MAX_ATTEMPTS, MAX_ATTEMPTS, proxy);
    }

    /** Возвращает подключённый клиент или бросает конкретный подкласс ClientNotConnectedError. */
    private async requireClient(override?: EnsureClientOverride): Promise<TelegramClient> {
        return this.ensureClient(override);
    }

    /**
     * Единая точка перехвата аккаунтных ошибок (telegram-error-handling, №5/6/11/12):
     * классифицирует пойманное исключение и бросает `AccountBannedError`/
     * `SessionRevokedError`, если оно означает деактивацию/бан/заморозку/невалидную
     * сессию — независимо от того, какой конкретно MTProto-вызов её вернул (не
     * только connect()/getMe(), как раньше). Прочие ошибки пробрасываются как есть —
     * операционные ошибки (join/send) классифицируются и обрабатываются отдельно,
     * своими вызывающими (не проходят через эту обёртку).
     */
    private async invokeChecked<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (err: any) {
            const accountFailure = classifyAccountError(err);
            if (accountFailure === "need_update_session") {
                this.restrictAgent(this.agentId, "need_update_session", err);
                throw new SessionRevokedError(err.code, err.errorMessage ?? err.message);
            }
            if (accountFailure === "banned") {
                this.restrictAgent(this.agentId, "banned", err);
                throw new AccountBannedError(err.code, err.errorMessage ?? err.message);
            }
            throw err;
        }
    }

    /**
     * Непригодная сессия (AUTH_KEY_DUPLICATED / AUTH_KEY_UNREGISTERED / бан) —
     * сразу записываем ограничение агента, чтобы диспетчер не поднимал его
     * задачи, а операторские скрипты видели его мёртвым до подключения.
     * Пишем здесь, в единственной точке подключения, — тогда ограничение
     * ставится независимо от того, какой скилл или скрипт наткнулся на сбой.
     * Ошибка записи не должна маскировать исходную ошибку Telegram.
     */
    private restrictAgent(agentId: string | null, type: RestrictionType, err: any): void {
        if (!agentId) return;
        const reason = err?.errorMessage ?? err?.message ?? String(err);
        try {
            upsertRestriction(FUNNEL_ADMIN_AGENT_ID, agentId, type, reason, null);
            this.log.error(
                `[telegram-user-tool] агент ${agentId} ограничен (${type}): ${reason} — снят с работы до перелогина`,
            );
        } catch (dbErr: any) {
            this.log.warn(
                `[telegram-user-tool] не удалось записать ограничение для ${agentId}: ${dbErr?.message ?? dbErr}`,
            );
        }
    }

    /**
     * Проверяет подключение с указанным прокси/бюджетом, не затрагивая persistent
     * AccountConfig (mobile-proxy-provisioning). Отключается сразу после успешной проверки —
     * вызывающему не нужно держать соединение открытым, ему нужен только сам факт успеха.
     * При неудаче бросает конкретный подкласс ClientNotConnectedError (см.
     * telegram-connection-errors) — вызывающий сам решает, что делать с конкретной причиной.
     */
    async verifyConnection(override: EnsureClientOverride): Promise<void> {
        const client = await this.ensureClient(override);
        await client.disconnect().catch(() => {});
    }

    /**
     * Быстрая проверка подключения уже настроенного аккаунта (persisted
     * AccountConfig, не кандидат прокси, в отличие от verifyConnection) —
     * loadAccount + requireClient + getMe, без побочных эффектов и без
     * персиста. Для массовой проверки "жив ли агент" по списку.
     */
    async checkConnection(): Promise<{ ok: true; userId: string; username: string | null } | { ok: false; reason: string }> {
        try {
            const client = await this.requireClient();
            const me = await client.getMe();
            return { ok: true, userId: (me as any).id?.toString() ?? "", username: (me as any).username ?? null };
        } catch (err: any) {
            return { ok: false, reason: err?.errorMessage ?? err?.message ?? String(err) };
        }
    }

    /**
     * Закрывает все подключённые клиенты. Диспетчер вызывает в конце прогона
     * (раздел 4, шаг 6), чтобы процесс мог штатно завершиться. Идемпотентно.
     */
    async disconnect(): Promise<void> {
        for (const [key, client] of this.clients) {
            await client.disconnect().catch(() => {});
            this.clients.delete(key);
            // Пауза ПЕРЕД снятием замка. client.disconnect() лишь отправляет
            // «ухожу» и закрывает сокет — сервер Telegram ещё какое-то время
            // считает старое подключение живым. Если отдать агента следующему
            // процессу сразу, тот подключится (с другого IP — прокси мобильные,
            // ротирующиеся), Telegram увидит ДВА подключения одним ключом и
            // пометит его дубликатом безвозвратно. Так был потерян agent126:
            // очередь ждала исчезновения файла-замка и стартовала через секунды.
            await sleep(randomDelayMs(POST_DISCONNECT_DELAY_MIN_SEC, POST_DISCONNECT_DELAY_MAX_SEC));
            this.releaseFor(key);
        }
    }

    /**
     * Снимает замок сессии для выселенного клиента: пока соединения нет, держать
     * агента занятым незачем — иначе диспетчер/скрипт не смогут его взять.
     * Идемпотентно; agentId можно передать явно, когда клиента в мапе уже нет.
     */
    private releaseFor(key: string, agentId?: string | null): void {
        const id = agentId ?? this.agentIdByKey.get(key);
        this.agentIdByKey.delete(key);
        if (id) releaseSession(id);
    }

    // ── telegram_get_dialogs ──────────────────────────────────────────

    /**
     * Строит InputPeer из entity диалога и кладёт в peerCache, если тип диалога
     * и accessHash это позволяют. Общая логика для mapDialogToGroup и
     * listGroupChannels (dialog-peer-cache-coverage) — оба обязаны прогревать
     * peerCache для всех групп/каналов диалога, а не только для того подмножества,
     * что видел вызывающий раньше: getPeerDialog (human-pacing monitor-v5)
     * читает peer ТОЛЬКО из этого кэша и, если чат туда не попал, молча
     * возвращает null (dialog_status_unknown), даже если чат абсолютно
     * рабочий — см. design.md dialog-peer-cache-coverage. peerCache
     * заполняется для ВСЕХ групп/каналов, а не только с непрочитанными —
     * иначе mark_as_read не сможет пометить чаты без unread (BUG-002).
     */
    private cachePeerForDialog(chatId: string, entity: any): void {
        // Конструируем InputPeer явно из entity — у него всегда есть accessHash
        // пока мы внутри текущего ответа Telegram.
        let inputPeer: Api.TypeInputPeer | undefined;
        if (entity instanceof Api.Channel && entity.accessHash != null) {
            if (entity.min) {
                // min-конструктор: accessHash неполный, для ReadHistory/sendMessage
                // непригоден (CHANNEL_INVALID). Пропускаем — лучше пропустить, чем падать.
                this.log.warn(
                    `[telegram-user-tool] get_dialogs — skipping min entity for chatId=${chatId} (${entity.title ?? ""}), full access_hash not available`,
                );
            } else {
                inputPeer = new Api.InputPeerChannel({
                    channelId: entity.id,
                    accessHash: entity.accessHash,
                });
            }
        } else if (entity instanceof Api.Chat) {
            // Базовые группы: access_hash не нужен
            inputPeer = new Api.InputPeerChat({ chatId: entity.id });
        }
        if (chatId && inputPeer) {
            this.peerCache.set(chatId, inputPeer);
        } else if (chatId) {
            this.log.warn(
                `[telegram-user-tool] get_dialogs — could not build InputPeer for chatId=${chatId} entity type=${entity?.className ?? "unknown"}`,
            );
        }
    }

    /**
     * Группа/канал из ответа getDialogs → GroupDialog + заполнение peerCache.
     * Возвращает null для диалогов, которые не группы/каналы (личные чаты).
     */
    private mapDialogToGroup(d: any): GroupDialog | null {
        if (!(d.isGroup || d.isChannel)) return null;
        const chatId: string = d.id?.toString();
        this.cachePeerForDialog(chatId, d.entity);

        return {
            chatId,
            title: d.title ?? "",
            unreadCount: d.dialog?.unreadCount ?? 0,
            readInboxMaxId: d.dialog?.readInboxMaxId ?? 0,
        };
    }

    async getDialogs(): Promise<{ groups: GroupDialog[] }> {
        this.log.info("[telegram-user-tool] tool:telegram_get_dialogs called");
        const client = await this.requireClient();

        // ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (peerCache window): берём только первые 200 диалогов.
        // Группы/каналы за пределами топ-200 не попадают в peerCache → действия по
        // ним (mark_as_read/reply, а в dm-send — отправка по sourceChatId кандидата
        // из БД) промахиваются мимо кэша. Скиллы пропускают такие чаты / dm-send
        // ловит "No InputPeer cached" и делает skip — не краш, но «хвост» диалогов
        // не обрабатывается. Монитор обходит это ограничение через
        // getDialogsForBatch (пагинация по конкретным chatId батча); для
        // getDmDialogs/listDialogChannels ограничение остаётся.
        const dialogs = await this.invokeChecked(() => client.getDialogs({ limit: 200 }));

        const groups = dialogs
            .map((d: any) => this.mapDialogToGroup(d))
            .filter((g): g is GroupDialog => g !== null && g.unreadCount > 0);

        this.log.info(
            `[telegram-user-tool] tool:telegram_get_dialogs — found ${groups.length} groups with unread messages`,
        );
        return { groups };
    }

    // ── telegram_get_dialogs_for_batch (group-monitoring, дозапрос по батчу) ──

    /**
     * Достоверный статус непрочитанности для набора chatId (батч монитора):
     * дозапрашивает страницы диалогов Telegram (`iterDialogs`), пока каждый
     * chatId не встретится (с любым unreadCount, в т.ч. 0) или диалоги не
     * закончатся/не достигнут потолок. peerCache заполняется для всех
     * встреченных по пути диалогов, не только из батча (design.md, Решение 1-3).
     * Канал, не попавший в возвращённую карту — статус не определён (вызывающий
     * не должен трактовать это как «пусто»).
     */
    async getDialogsForBatch(
        chatIds: string[],
    ): Promise<Map<string, { unreadCount: number; readInboxMaxId: number }>> {
        const client = await this.requireClient();
        const targets = new Set(chatIds);
        const found = new Map<string, { unreadCount: number; readInboxMaxId: number }>();

        const pageSize = 200; // тот же размер страницы, что и у getDialogs
        const maxDialogs = pageSize * GET_DIALOGS_FOR_BATCH_MAX_PAGES;
        let seen = 0;

        // Оборачиваем весь for-await целиком (не отдельный вызов) — invokeChecked
        // принимает () => Promise<T>, а не async-итератор напрямую.
        await this.invokeChecked(async () => {
            for await (const d of client.iterDialogs({ limit: maxDialogs })) {
                seen += 1;
                const group = this.mapDialogToGroup(d);
                if (group) {
                    found.set(group.chatId, { unreadCount: group.unreadCount, readInboxMaxId: group.readInboxMaxId });
                    targets.delete(group.chatId);
                }
                if (targets.size === 0) break;
            }
        });

        if (targets.size > 0 && seen >= maxDialogs) {
            this.log.warn(
                `[telegram-user-tool] get_dialogs_for_batch — достигнут потолок ${GET_DIALOGS_FOR_BATCH_MAX_PAGES} страниц ` +
                    `(${maxDialogs} диалогов), ${targets.size} канал(ов) батча не определены`,
            );
        }

        return found;
    }

    /**
     * Заполняет peerCache для указанных chatId, итерируя все диалоги без потолка —
     * останавливается когда все id найдены или диалоги кончились. Используется
     * в channel-cleanup: слабые каналы оседают в хвосте и за пределами топ-200.
     */
    async populatePeerCacheForIds(chatIds: string[]): Promise<void> {
        const client = await this.requireClient();
        const targets = new Set(chatIds);
        let seen = 0;

        for await (const d of client.iterDialogs({})) {
            seen += 1;
            const group = this.mapDialogToGroup(d);
            if (group) targets.delete(group.chatId);
            if (targets.size === 0) break;
        }

        if (targets.size > 0) {
            this.log.warn(
                `[telegram-user-tool] populatePeerCacheForIds — ${targets.size} канал(ов) не найдено в ${seen} диалогах: ${[...targets].join(", ")}`,
            );
        } else {
            this.log.info(
                `[telegram-user-tool] populatePeerCacheForIds — все ${chatIds.length} каналов найдены за ${seen} итераций`,
            );
        }
    }

    /**
     * Возвращает accessHash закэшированного в памяти InputPeer чата (post-comment-review) —
     * для персиста в `channels.chatAccessHash`, чтобы холодное соединение могло
     * собрать InputPeer напрямую из БД, без повторного похода в getDialogs
     * (design.md решение 5). null, если чат ещё не встречался в peerCache в
     * этом прогоне, или это не канал/супергруппа (только у них есть accessHash).
     */
    getCachedChatAccessHash(chatId: string): string | null {
        const peer = this.peerCache.get(chatId);
        return peer instanceof Api.InputPeerChannel ? peer.accessHash.toString() : null;
    }

    /**
     * Сидирует peerCache для одного chatId напрямую из персистентного
     * accessHash (`channels.chatAccessHash`), без похода в getDialogs —
     * для review-listener (post-comment-review), который поднимает свежее
     * соединение специально под один чат и не проходит обычный путь
     * getDialogs/getDialogsForBatch/populatePeerCacheForIds. `chatId` —
     * маркированный id чата (как в `channels.chatId`), не raw channelId;
     * переводится в raw id тем же способом, каким GramJS сам это делает
     * (utils.resolveId), не изобретаем свою арифметику -100-префикса.
     */
    seedPeerCache(chatId: string, accessHash: string): void {
        const [rawId, peerType] = utils.resolveId(bigInt(chatId));
        if (peerType !== Api.PeerChannel) {
            this.log.warn(`[telegram-user-tool] seedPeerCache — chatId=${chatId} не резолвится в канал, пропущено`);
            return;
        }
        this.peerCache.set(chatId, new Api.InputPeerChannel({ channelId: rawId, accessHash: bigInt(accessHash) }));
    }

    /**
     * Карта chatId → {title, username} для всех групп/каналов диалогов.
     * Используется синхронизацией БД каналов (отделяет Telegram от слоя БД).
     * `username` — публичный username самого чата (funnel-tracking v3, US-5:
     * якорь для переходимой ссылки), берётся из того же ответа `getDialogs`,
     * без дополнительного MTProto-вызова.
     *
     * Прогревает peerCache для каждого найденного диалога (dialog-peer-cache-coverage,
     * та же логика, что mapDialogToGroup) — вызывающие (monitor-v5 human-pacing:
     * getPeerDialog) читают peer только из этого кэша, без запасного похода в
     * Telegram, поэтому пропуск прогрева здесь означает «канал не найден» для
     * абсолютно рабочих каналов. Без лимита — в отличие от getDialogs()/
     * getDialogsForBatch, здесь нет обрезки по топ-200/топ-1000.
     *
     * Постранично (monitor-v5-human-pacing-batching): `client.iterDialogs({})`
     * уже пагинирует запросы к Telegram чанками по 100 внутри себя (см.
     * _DialogsIter в GramJS) — здесь лишь вставляется пауза каждые
     * V5_SYNC_PAGE_SIZE обработанных диалогов, чтобы полная синхронизация не
     * выглядела одним мгновенным запросом на весь список.
     */
    async listGroupChannels(): Promise<Map<string, { title: string; username: string | null }>> {
        const client = await this.requireClient();
        const result = new Map<string, { title: string; username: string | null }>();
        await this.invokeChecked(async () => {
            let seenSincePause = 0;
            for await (const d of client.iterDialogs({})) {
                const dd = d as any;
                if (dd.isGroup || dd.isChannel) {
                    const chatId: string = dd.id?.toString() ?? "";
                    if (chatId) {
                        this.cachePeerForDialog(chatId, dd.entity);
                        result.set(chatId, { title: dd.title ?? "", username: dd.entity?.username ?? null });
                    }
                }
                seenSincePause += 1;
                if (seenSincePause >= V5_SYNC_PAGE_SIZE) {
                    seenSincePause = 0;
                    await sleep((V5_SYNC_PAGE_DELAY_MIN_SEC + Math.random() * (V5_SYNC_PAGE_DELAY_MAX_SEC - V5_SYNC_PAGE_DELAY_MIN_SEC)) * 1000);
                }
            }
        });
        return result;
    }

    // ── telegram_get_messages ─────────────────────────────────────────

    async getMessages(
        chatId: string,
        minId: number,
        limit: number,
        opts?: { includeChannelPosts?: boolean; reverse?: boolean },
    ): Promise<{ chatId: string; messages: TgMessage[] }> {
        this.log.info(
            `[telegram-user-tool] tool:telegram_get_messages called — chatId=${chatId} minId=${minId} limit=${limit} reverse=${!!opts?.reverse}`,
        );
        const client = await this.requireClient();
        // Лимит задаёт вызывающий скилл (свой GET_MESSAGES_LIMIT) — здесь потолка
        // нет. GramJS сам пагинирует запросы >100 (несколько GetHistory под капотом).
        // reverse=true (monitor-v5-human-pacing-batching, чанкинг чтения): minId
        // становится нижней границей курсора, сообщения идут от старых к новым —
        // подтверждено по типам GramJS (IterMessagesParams.reverse), не по памяти.
        const peer = BigInt(chatId);
        const messages = await this.invokeChecked(() =>
            client.getMessages(peer, opts?.reverse ? { minId, limit, reverse: true } : { minId, limit }),
        );
        const includeChannelPosts = opts?.includeChannelPosts ?? false;

        const result = messages
            .filter((m: any) => {
                // Собственные исходящие сообщения (агент сам их отправил) исключаются
                // безусловно. read_inbox_max_id не продвигается по своим сообщениям
                // (у них нет read/unread-статуса), поэтому диапазон "новых" сообщений
                // может случайно включать прошлый ответ самого агента — без этого
                // фильтра он уходит в general-классификацию наравне с чужими
                // сообщениями, и LLM может выбрать его как повод для ответа (self-reply,
                // telegram-self-reply-fix). `out` — нативный флаг MTProto на самом
                // сообщении, не требует сверки senderId с собственным id аккаунта.
                if (m.out) {
                    return false;
                }
                // Публикации от владельца канала в обсуждении приходят с sender типа
                // Channel (не User) — автоматически пересланные посты. По умолчанию
                // игнорируются (v1); post-freshness-gate (monitor-v2) включает их
                // через includeChannelPosts — они тоже сообщения, участвующие в анализе.
                if (m.sender instanceof Api.Channel && !includeChannelPosts) {
                    this.log.info(
                        `[telegram-user-tool] get_messages — skipping channel post msgId=${m.id} from channel "${m.sender.title ?? m.senderId}"`,
                    );
                    return false;
                }
                return true;
            })
            .map((m: any) => {
                const entry: TgMessage = {
                    id: m.id,
                    fromId: m.senderId?.toString() ?? "",
                    fromName: (m.sender as any)?.firstName
                        ? `${(m.sender as any).firstName ?? ""} ${(m.sender as any).lastName ?? ""}`.trim()
                        : (m.sender as any)?.title ?? (m.senderId?.toString() ?? ""),
                    text: m.text ?? m.message ?? "",
                    date: m.date,
                };
                // userAccessHash только если sender — полноценный User (не min):
                // min=true означает неполный access_hash, непригодный для InputPeerUser.
                if (m.sender instanceof Api.User && m.sender.accessHash != null && !m.sender.min) {
                    entry.userAccessHash = m.sender.accessHash.toString();
                }
                if (m.replyTo?.replyToMsgId) {
                    entry.replyToMsgId = m.replyTo.replyToMsgId;
                }
                if (m.replyTo?.replyToTopId) {
                    entry.replyToTopId = m.replyTo.replyToTopId;
                }
                if (m.fwdFrom?.channelPost != null) {
                    entry.isChannelPost = true;
                }
                return entry;
            });

        const withReply = result.filter((m) => m.replyToMsgId !== undefined).length;
        this.log.info(
            `[telegram-user-tool] tool:telegram_get_messages — chatId=${chatId} returned ${result.length} messages, ${withReply} with replyToMsgId`,
        );
        return { chatId, messages: result };
    }

    /**
     * Дата публикации поста по id корневого сообщения ветки (post-freshness-gate,
     * случай A) — точечный запрос одного сообщения по id внутри чата обсуждения.
     * null, если сообщение не найдено/недоступно (обрабатывается вызывающим как
     * неудачу определения даты — R3 в требованиях, не бросает исключение).
     */
    async getMessageById(chatId: string, msgId: number): Promise<{ date: number } | null> {
        const client = await this.requireClient();
        const peer = BigInt(chatId);
        const messages = await this.invokeChecked(() => client.getMessages(peer, { ids: [msgId] }));
        const m = messages[0] as any;
        if (!m || typeof m.date !== "number") return null;
        return { date: m.date };
    }

    /**
     * Вся история чата с `sinceSec` по `untilSec` (channel-activity-percentiles) —
     * потоково, батчами по 5-10 сообщений (рандомно на каждый батч) с
     * рандомной паузой 10-20с между батчами — «человеческий» темп чтения
     * вместо одного крупного пакетного запроса. Ручная пагинация через
     * `getMessages` с `offsetId` (не `iterMessages`, которая сама решает
     * размер страницы и не даёт вставить паузу между сетевыми вызовами).
     * Без накопления полного списка в памяти — на канале с 42690 сообщениями
     * за 30 дней истории цельный `getMessages` без пагинации ронял процесс по
     * OOM (инцидент 2026-08-25); эта функция держит в памяти только текущий
     * батч (design.md channel-activity-percentiles, пересмотр Decision 3).
     * Остановка — по пустому батчу (история кончилась) либо когда последнее
     * сообщение батча вышло за `untilSec` (дальше — за пределами окна,
     * дочитывать нет смысла). Служебные сообщения и авто-пересланные посты
     * канала (sender — Api.Channel) исключаются — это не «человек написал».
     * FLOOD_WAIT → FloodWaitError. Требует, чтобы аккаунт уже состоял в чате —
     * сторонний аккаунт не может прочитать историю чата без членства
     * (design.md, Decision 1).
     */
    async *iterChatHistorySince(chatId: string, sinceSec: number, untilSec: number): AsyncGenerator<{ fromId: string; date: number }> {
        const client = await this.requireClient();
        const peer = BigInt(chatId);
        let offsetId = 0;
        let firstBatch = true;

        while (true) {
            const batchSize = 5 + Math.floor(Math.random() * 6); // 5..10 включительно
            let batch: any[];
            try {
                batch = await this.invokeChecked(() =>
                    client.getMessages(
                        peer,
                        firstBatch
                            ? { limit: batchSize, offsetDate: sinceSec, reverse: true }
                            : { limit: batchSize, offsetId, reverse: true },
                    ),
                );
            } catch (err: any) {
                const wait = parseFloodWait(err);
                if (wait !== null) throw new FloodWaitError(wait);
                throw err;
            }
            if (batch.length === 0) break;

            for (const m of batch) {
                if (!(m instanceof Api.Message) || m.sender instanceof Api.Channel || m.senderId == null) continue;
                yield { fromId: m.senderId.toString(), date: m.date as number };
            }

            const last = batch[batch.length - 1];
            offsetId = typeof last.id === "number" ? last.id : offsetId;
            firstBatch = false;
            if (typeof last.date === "number" && last.date >= untilSec) break; // дошли до конца окна
            if (batch.length < batchSize) break; // история чата кончилась раньше конца окна

            const delay = (10 + Math.random() * 10) * 1000; // 10-20с
            await sleep(delay);
        }
    }

    /**
     * Какие из перечисленных `msgId` ещё существуют в чате (channel-suspend-on-deletion) —
     * точечный запрос по явному списку id, удалённые сообщения приходят без
     * `date` (аналогично `getMessageById`) или отсутствуют в ответе. Чанкуется
     * по `GET_MESSAGES_BY_ID_CHUNK_SIZE` id за вызов (лимит Telegram на
     * `messages.getMessages`/`channels.getMessages`).
     */
    async getMessagesExistence(chatId: string, msgIds: number[]): Promise<Set<number>> {
        const client = await this.requireClient();
        const peer = BigInt(chatId);
        const existing = new Set<number>();

        for (let i = 0; i < msgIds.length; i += GET_MESSAGES_BY_ID_CHUNK_SIZE) {
            const chunk = msgIds.slice(i, i + GET_MESSAGES_BY_ID_CHUNK_SIZE);
            const messages = await this.invokeChecked(() => client.getMessages(peer, { ids: chunk }));
            for (const m of messages as any[]) {
                if (m && typeof m.date === "number" && typeof m.id === "number") existing.add(m.id);
            }
        }

        return existing;
    }

    // ── telegram_mark_as_read ─────────────────────────────────────────

    async markAsRead(chatId: string, maxId: number): Promise<{ ok: true }> {
        this.log.info(`[telegram-user-tool] tool:telegram_mark_as_read called — chatId=${chatId} maxId=${maxId}`);
        const client = await this.requireClient();

        // InputPeer из кэша, заполненного в get_dialogs. getEntity(BigInt) работает
        // только пока жив in-memory кэш GramJS — ломается при холодном старте.
        const peer = this.peerCache.get(chatId);
        if (!peer) {
            throw new Error(`No InputPeer cached for chatId=${chatId}. Call telegram_get_dialogs first.`);
        }

        // messages.ReadHistory — личные чаты и базовые группы;
        // channels.ReadHistory — каналы и супергруппы. Передача InputPeerChannel в
        // messages.ReadHistory → PEER_ID_INVALID даже при верном accessHash.
        // Ретрай FLOOD_WAIT/SLOWMODE_WAIT — общая политика (telegram-error-handling
        // №9), метод ReadHistory не исключение из общего rate-limit на метод.
        if (peer instanceof Api.InputPeerChannel) {
            await retryOnFloodWait(
                () =>
                    this.invokeChecked(() =>
                        client.invoke(
                            new Api.channels.ReadHistory({
                                channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }),
                                maxId,
                            }),
                        ),
                    ),
                this.log,
            );
        } else {
            await retryOnFloodWait(
                () => this.invokeChecked(() => client.invoke(new Api.messages.ReadHistory({ peer, maxId }))),
                this.log,
            );
        }

        this.log.info(`[telegram-user-tool] tool:telegram_mark_as_read — marked as read chatId=${chatId} up to maxId=${maxId}`);
        return { ok: true };
    }

    /**
     * Статус одного диалога (human-pacing monitor-v5): непрочитанные и граница
     * прочитанного по конкретному чату. Заменяет общий обход всех диалогов
     * (getDialogsForBatch) — запросы размазываются по времени вместе с паузами,
     * а не идут одним всплеском в начале прогона. InputPeer — из peerCache
     * (заполняется listGroupChannels в начале прогона, dialog-peer-cache-coverage —
     * см. cachePeerForDialog), как и mark_as_read. null — чата нет в кэше либо
     * Telegram не вернул диалог.
     */
    async getPeerDialog(chatId: string): Promise<{ unreadCount: number; readInboxMaxId: number } | null> {
        const client = await this.requireClient();
        const peer = this.peerCache.get(chatId);
        if (!peer) return null;
        const res: any = await retryOnFloodWait(
            () =>
                this.invokeChecked(() =>
                    client.invoke(new Api.messages.GetPeerDialogs({ peers: [new Api.InputDialogPeer({ peer })] })),
                ),
            this.log,
        );
        const dialog: any = (res?.dialogs ?? [])[0];
        if (!dialog) return null;
        return {
            unreadCount: typeof dialog.unreadCount === 'number' ? dialog.unreadCount : 0,
            readInboxMaxId: typeof dialog.readInboxMaxId === 'number' ? dialog.readInboxMaxId : 0,
        };
    }

    /**
     * Индикатор «печатает…» (human-pacing monitor-v5) — живой клиент показывает
     * его всё время набора текста. Косметика поведения: ошибки не эскалируются,
     * прогон из-за них не останавливается.
     */
    async setTyping(chatId: string, typing: boolean): Promise<void> {
        const client = await this.requireClient();
        const peer = this.peerCache.get(chatId);
        if (!peer) return;
        await this.invokeChecked(() =>
            client.invoke(
                new Api.messages.SetTyping({
                    peer,
                    action: typing ? new Api.SendMessageTypingAction() : new Api.SendMessageCancelAction(),
                }),
            ),
        );
    }

    // ── leave-banned-channels ─────────────────────────────────────────

    /**
     * Выходит из канала/супергруппы (MTProto `channels.LeaveChannel`).
     * InputChannel берётся из peerCache (заполняется get_dialogs), как и в
     * mark_as_read — без getEntity (ADR 0003).
     */
    async leaveChannel(chatId: string): Promise<{ ok: true }> {
        const client = await this.requireClient();
        const peer = this.peerCache.get(chatId);
        if (!(peer instanceof Api.InputPeerChannel)) {
            throw new Error(`No channel InputPeer cached for chatId=${chatId}. Call telegram_get_dialogs first.`);
        }
        await this.invokeChecked(() =>
            client.invoke(
                new Api.channels.LeaveChannel({
                    channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }),
                }),
            ),
        );
        this.log.info(`[telegram-user-tool] leaveChannel — left chatId=${chatId}`);
        return { ok: true };
    }

    /**
     * Выходит из канала/супергруппы по уже готовому `InputChannel` (leave-all-channels) —
     * в отличие от `leaveChannel`, не требует peerCache/get_dialogs: ручка приходит из
     * `listDialogChannels()`, который сам строит InputChannel из entity диалога.
     */
    async leaveChannelByHandle(channel: Api.InputChannel): Promise<{ ok: true }> {
        const client = await this.requireClient();
        await this.invokeChecked(() => client.invoke(new Api.channels.LeaveChannel({ channel })));
        this.log.info(`[telegram-user-tool] leaveChannelByHandle — left channelId=${channel.channelId}`);
        return { ok: true };
    }

    /**
     * Все базовые (не супер-) группы из диалогов агента (leave-all-channels) —
     * `listDialogChannels` их не видит: там только `Api.Channel` (broadcast/мегагруппы).
     * `chatId` — сырой `Api.Chat.id`, НЕ marked-вид (`-100…`), как везде в БД.
     */
    async listDialogBasicGroups(): Promise<{ chatId: string; title: string }[]> {
        const client = await this.requireClient();
        const dialogs = await this.invokeChecked(() => client.getDialogs({}));
        const out: { chatId: string; title: string }[] = [];
        for (const d of dialogs as any[]) {
            const entity = d.entity;
            if (!(entity instanceof Api.Chat)) continue;
            out.push({ chatId: entity.id.toString(), title: entity.title ?? "" });
        }
        return out;
    }

    /** Выходит из базовой группы (MTProto `messages.DeleteChatUser` на себя же — у basic-групп нет `LeaveChannel`). */
    async leaveBasicGroup(chatId: string): Promise<{ ok: true }> {
        const client = await this.requireClient();
        await this.invokeChecked(() =>
            client.invoke(new Api.messages.DeleteChatUser({ chatId: bigInt(chatId), userId: new Api.InputUserSelf() })),
        );
        this.log.info(`[telegram-user-tool] leaveBasicGroup — left chatId=${chatId}`);
        return { ok: true };
    }

    /**
     * Резолвит публичный username чата по chatId (best-effort) через
     * `channels.GetFullChannel` — username берётся из массива `chats` ответа.
     * Возвращает null, если InputPeer не в кэше, это не канал, или username нет
     * (приватная группа-обсуждение). Вызывать до leaveChannel — пока ещё участник.
     */
    async resolveChannelUsername(chatId: string): Promise<string | null> {
        const client = await this.requireClient();
        const peer = this.peerCache.get(chatId);
        if (!(peer instanceof Api.InputPeerChannel)) return null;
        try {
            const inputChannel = new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash });
            const full = await this.invokeChecked(() => client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel })));
            const chat = (full.chats as any[]).find(
                (c) => c instanceof Api.Channel && c.id?.toString() === peer.channelId.toString(),
            ) as Api.Channel | undefined;
            const username = (chat as any)?.username;
            return typeof username === "string" && username.length > 0 ? username : null;
        } catch (err: any) {
            // Аккаунтная ошибка (telegram-error-handling) — не проглатывать в null,
            // это не «username не резолвится», а «аккаунт мёртв»: пробросить дальше.
            if (err instanceof ClientNotConnectedError) throw err;
            this.log.warn(`[telegram-user-tool] resolveChannelUsername — failed for chatId=${chatId}: ${err.message ?? err}`);
            return null;
        }
    }

    // ── telegram_reply_to_message ─────────────────────────────────────

    async replyToMessage(chatId: string, replyToMessageId: number, text: string): Promise<{ ok: true; messageId: number }> {
        this.log.info(
            `[telegram-user-tool] tool:telegram_reply_to_message called — chatId=${chatId} replyToMessageId=${replyToMessageId} text="${text.slice(0, 50)}..."`,
        );
        const client = await this.requireClient();

        const peer = this.peerCache.get(chatId);
        if (!peer) {
            throw new Error(`No InputPeer cached for chatId=${chatId}. Call telegram_get_dialogs first.`);
        }

        const result = await this.invokeChecked(() => client.sendMessage(peer as any, { message: text, replyTo: replyToMessageId }));
        this.log.info(`[telegram-user-tool] tool:telegram_reply_to_message — sent reply messageId=${result.id} to chatId=${chatId}`);
        return { ok: true, messageId: result.id };
    }

    // ── Saved Messages (отчёт прогона, R-D1) ──────────────────────────

    /**
     * Отправляет сообщение в Saved Messages агента (чат «me»). Диспетчер шлёт
     * сюда статус-отчёт каждого прогона (R-D1) — отдельный канал от логов
     * (journald) и команд (чат с ботом). Пир «me» не нуждается в peerCache.
     */
    async sendSavedMessage(text: string, parseMode?: "md" | "html"): Promise<{ ok: true; messageId: number }> {
        const client = await this.requireClient();
        // Telegram режет сообщения на 4096 символов (MESSAGE_TOO_LONG). Длинный
        // отчёт бьём на части по границам строк. Код-блок таблицы лежит в начале
        // (первые ~1.5 КБ), поэтому в первый чанк попадает целиком и не рвётся.
        const LIMIT = 4000;
        const chunks: string[] = [];
        if (text.length <= LIMIT) {
            chunks.push(text);
        } else {
            let buf = "";
            for (const line of text.split("\n")) {
                if (buf.length + line.length + 1 > LIMIT && buf.length > 0) {
                    chunks.push(buf);
                    buf = "";
                }
                buf = buf ? `${buf}\n${line}` : line;
            }
            if (buf.length > 0) chunks.push(buf);
        }
        let lastId = 0;
        for (const chunk of chunks) {
            const result = await client.sendMessage("me", { message: chunk, parseMode });
            lastId = result.id;
        }
        this.log.info(
            `[telegram-user-tool] sendSavedMessage — sent report (${chunks.length} part(s)) lastMessageId=${lastId} to Saved Messages`,
        );
        return { ok: true, messageId: lastId };
    }

    /**
     * Отправляет файл-документ в Saved Messages агента (чат «me») с подписью.
     * Используется выгрузкой CSV-отчёта (channel-content-analysis): объём не влезает
     * в текстовое сообщение, поэтому таблица уходит файлом. Пир «me» не нуждается в
     * peerCache.
     */
    async sendSavedDocument(filePath: string, caption: string): Promise<{ ok: true; messageId: number }> {
        const client = await this.requireClient();
        const result = await client.sendFile("me", { file: filePath, caption, forceDocument: true });
        this.log.info(`[telegram-user-tool] sendSavedDocument — sent document messageId=${result.id} to Saved Messages`);
        return { ok: true, messageId: result.id };
    }

    // ── telegram_send_dm ──────────────────────────────────────────────

    async sendDm(params: {
        userId: string;
        chatId?: string;
        msgId?: number;
        accessHash?: string;
        text: string;
    }): Promise<SendDmResult> {
        const { userId, chatId, msgId, accessHash, text } = params;
        this.log.info(
            `[telegram-user-tool] tool:telegram_send_dm called — userId=${userId} text="${text.slice(0, 50)}..."`,
        );
        const client = await this.requireClient();

        let peer: Api.TypeInputPeer;
        if (chatId && msgId != null) {
            const groupPeer = this.peerCache.get(chatId);
            if (!groupPeer) {
                throw new Error(`No InputPeer cached for chatId=${chatId}. Call telegram_get_dialogs first.`);
            }
            peer = new Api.InputPeerUserFromMessage({ peer: groupPeer, msgId, userId: BigInt(userId) });
            this.log.info(`[telegram-user-tool] tool:telegram_send_dm — using InputPeerUserFromMessage chatId=${chatId} msgId=${msgId}`);
        } else if (accessHash) {
            peer = new Api.InputPeerUser({ userId: BigInt(userId), accessHash: BigInt(accessHash) });
            this.log.info(`[telegram-user-tool] tool:telegram_send_dm — using InputPeerUser (accessHash fallback)`);
        } else {
            throw new Error("Either (chatId + msgId) or accessHash must be provided.");
        }

        // invokeChecked: FROZEN_* (не матчится ни одной из явных проверок ниже)
        // проваливается в финальный throw err уже как AccountBannedError —
        // USER_DEACTIVATED/BAN по-прежнему матчатся explicit-проверками ниже
        // (их сырой текст остаётся в message классифицированной ошибки).
        const trySend = () => this.invokeChecked(() => client.sendMessage(peer as any, { message: text }));

        try {
            // Ретрай FLOOD_WAIT — общая политика (до 2 повторов, порог перепроверяется
            // на каждом шаге, telegram-error-handling №9). Не-flood ошибки пробрасываются
            // немедленно (retryOnFloodWait не трогает их), классифицируются ниже.
            const result = await retryOnFloodWait(trySend, this.log);
            this.log.info(`[telegram-user-tool] tool:telegram_send_dm — sent messageId=${result.id} to userId=${userId}`);
            return { ok: true, messageId: result.id };
        } catch (err: any) {
            const msg: string = err.message ?? String(err);

            if (msg.includes("USER_PRIVACY_RESTRICTED")) {
                this.log.warn(`[telegram-user-tool] tool:telegram_send_dm — userId=${userId} privacy_blocked`);
                return { error: "privacy_blocked" };
            }
            if (msg.includes("USER_DEACTIVATED") || msg.includes("USER_DEACTIVATED_BAN")) {
                this.log.warn(`[telegram-user-tool] tool:telegram_send_dm — userId=${userId} deactivated`);
                return { error: "deactivated" };
            }
            if (msg.includes("PEER_ID_INVALID")) {
                this.log.warn(`[telegram-user-tool] tool:telegram_send_dm — userId=${userId} peer_id_invalid`);
                return { error: "peer_id_invalid" };
            }
            // PEER_FLOOD — временный бан на рассылку. Не retry, сразу стоп.
            if (msg.includes("PEER_FLOOD")) {
                this.log.warn(`[telegram-user-tool] tool:telegram_send_dm — userId=${userId} peer_flood`);
                return { error: "peer_flood" };
            }

            if (parseFloodWait(err) !== null) {
                // Флуд пережил все повторы retryOnFloodWait (порог/исчерпание) —
                // кандидат пропускается в этом прогоне.
                this.log.warn(`[telegram-user-tool] tool:telegram_send_dm — FLOOD_WAIT persisted for userId=${userId}, не ждём дальше`);
                return { error: "flood_wait" };
            }

            throw err;
        }
    }

    // ── telegram_get_dm_dialogs ───────────────────────────────────────

    async getDmDialogs(): Promise<{ dms: DmDialog[] }> {
        this.log.info("[telegram-user-tool] tool:telegram_get_dm_dialogs called");
        const client = await this.requireClient();

        // ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (peerCache window): только первые 100 диалогов —
        // непрочитанные личные чаты за пределами топ-100 не попадают ни в выборку,
        // ни в peerCache, поэтому dm-replies их не обрабатывает за прогон. Полное
        // решение — пагинация iterDialogs. См. design.md task-scheduler → «Риски».
        const dialogs = await this.invokeChecked(() => client.getDialogs({ limit: 100 }));

        const dms = dialogs
            .filter((d: any) => d.isUser === true)
            .map((d: any) => {
                const entity = d.entity;

                if (!(entity instanceof Api.User)) return null;

                if (entity.bot) {
                    this.log.info(`[telegram-user-tool] get_dm_dialogs — skipping bot userId=${entity.id}`);
                    return null;
                }

                const userIdStr = entity.id?.toString() ?? "";
                if (userIdStr === "777000") {
                    this.log.info(`[telegram-user-tool] get_dm_dialogs — skipping service notifications (777000)`);
                    return null;
                }

                if (entity.min) {
                    this.log.warn(`[telegram-user-tool] get_dm_dialogs — skipping min entity for userId=${userIdStr}`);
                    return null;
                }

                const unreadCount = d.dialog?.unreadCount ?? 0;
                if (unreadCount === 0) return null;

                const accessHash = entity.accessHash;
                if (accessHash == null) {
                    this.log.warn(`[telegram-user-tool] get_dm_dialogs — skipping userId=${userIdStr}, no accessHash`);
                    return null;
                }

                const inputPeer = new Api.InputPeerUser({ userId: entity.id, accessHash });
                this.peerCache.set(userIdStr, inputPeer);

                return {
                    userId: userIdStr,
                    accessHash: accessHash.toString(),
                    userName: entity.username ?? null,
                    firstName: entity.firstName ?? null,
                    unreadCount,
                    readInboxMaxId: d.dialog?.readInboxMaxId ?? 0,
                };
            })
            .filter((item): item is DmDialog => item !== null);

        this.log.info(`[telegram-user-tool] tool:telegram_get_dm_dialogs — found ${dms.length} DM chats with unread messages`);
        return { dms };
    }

    // ── telegram_join_discussion_groups ───────────────────────────────

    async joinDiscussionGroups(links: string[]): Promise<JoinSummary> {
        this.log.info(`[telegram-user-tool] tool:telegram_join_discussion_groups called — ${links.length} links`);
        const client = await this.requireClient();

        // Рандомная пауза между итерациями: 15–60 секунд.
        const randomDelay = () => (15 + Math.random() * 45) * 1000;

        const results: JoinResult[] = [];
        const floodWaits: Array<{ link: string; waitSeconds: number }> = [];

        /**
         * Флуд-детекция для одного шага (ResolveUsername/GetFullChannel/JoinChannel):
         * ретрай — общая политика `retryOnFloodWait` (до 2 повторов, порог
         * перепроверяется на каждом шаге, telegram-error-handling №9). Каждое
         * обнаружение флуда (включая исчерпавшее повторы) пишется в `floodWaits` —
         * это единственный структурный сигнал, по которому `skills/join-queue.ts`
         * отличает флуд от постоянной причины отказа, без парсинга текста ошибки.
         * Общая логика для всех трёх шагов — раньше её делал только JoinChannel.
         */
        const callWithFloodHandling = async <T>(link: string, fn: () => Promise<T>): Promise<T> => {
            const tracked = async () => {
                try {
                    return await fn();
                } catch (err: any) {
                    const waitSec = parseFloodWait(err);
                    if (waitSec !== null) floodWaits.push({ link, waitSeconds: waitSec });
                    throw err;
                }
            };
            return retryOnFloodWait(tracked, this.log);
        };

        for (const link of links) {
            const username = link
                .replace(/^https?:\/\//, "")
                .replace(/^t\.me\//, "")
                .replace(/\/$/, "")
                .trim();

            if (!username || username.startsWith("+")) {
                results.push({ link, status: "skipped", reason: "private invite link not supported" });
                this.log.info(`[telegram-user-tool] join — skipped ${link}: private invite link`);
                continue;
            }

            try {
                const resolved = await callWithFloodHandling(link, () =>
                    this.invokeChecked(() => client.invoke(new Api.contacts.ResolveUsername({ username }))));
                const channel = resolved.chats?.find((c: any) => c instanceof Api.Channel) as Api.Channel | undefined;

                if (!channel || channel.min) {
                    results.push({ link, status: "skipped", reason: "channel not found or min entity" });
                    this.log.info(`[telegram-user-tool] join — skipped ${link}: channel not found`);
                    continue;
                }

                const inputChannel = new Api.InputChannel({ channelId: channel.id, accessHash: channel.accessHash! });
                const fullChannel = await callWithFloodHandling(link, () =>
                    this.invokeChecked(() => client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel }))));
                const linkedChatId = (fullChannel.fullChat as any)?.linkedChatId;

                if (!linkedChatId || linkedChatId.eq?.(0) || linkedChatId === 0) {
                    results.push({ link, status: "skipped", reason: "no linked discussion group" });
                    this.log.info(`[telegram-user-tool] join — skipped ${link}: no discussion group`);
                    continue;
                }

                // linkedChatId — channel_id супергруппы обсуждения; ищем её access_hash
                // в chats из того же ответа.
                const discussionChat = fullChannel.chats?.find(
                    (c: any) => c.id?.equals?.(linkedChatId) || c.id === linkedChatId,
                ) as Api.Channel | undefined;

                if (!discussionChat || !(discussionChat instanceof Api.Channel) || discussionChat.min) {
                    results.push({ link, status: "skipped", reason: "discussion group entity unavailable" });
                    this.log.info(`[telegram-user-tool] join — skipped ${link}: discussion group entity not in response`);
                    continue;
                }

                // Вступаем. При FLOOD_WAIT ниже порога — ждём и делаем одну повторную
                // попытку; на пороге/выше или при повторном FLOOD_WAIT — пробрасываем
                // (канал пропускается на этот прогон, см. callWithFloodHandling выше).
                const discussionInput = new Api.InputChannel({ channelId: discussionChat.id, accessHash: discussionChat.accessHash! });

                await callWithFloodHandling(link, () =>
                    this.invokeChecked(() => client.invoke(new Api.channels.JoinChannel({ channel: discussionInput }))));

                const discussionChatId = discussionChat.id.toString();
                const identity: JoinedChannelIdentity = {
                    chatId: utils.getPeerId(discussionChat),
                    title: discussionChat.title,
                    chatAccessHash: discussionChat.accessHash!.toString(),
                    chatUsername: discussionChat.username ?? null,
                    channelId: channel.id.toString(),
                    channelAccessHash: channel.accessHash!.toString(),
                    channelUsername: channel.username ?? username,
                };
                results.push({ link, status: "joined", discussionChatId, identity });
                this.log.info(`[telegram-user-tool] join — joined discussion group ${discussionChatId} for channel @${username}`);
            } catch (err: any) {
                // Аккаунтная ошибка (telegram-error-handling) — не ошибка конкретной
                // ссылки, а всего аккаунта: пробросить, не продолжать батч со
                // следующей ссылкой уже мёртвой сессией.
                if (err instanceof ClientNotConnectedError) throw err;

                const msg: string = err.message ?? String(err);

                // Классификация по единому каталогу (telegram-error-handling), не по
                // локальному списку — join-queue.ts маппит тег в статус (error/skipped).
                const tag = classifyTelegramErrorTag(err);
                if (tag) {
                    results.push({ link, status: "skipped", reason: tag });
                    this.log.info(`[telegram-user-tool] join — skipped ${link}: ${tag}`);
                } else {
                    results.push({ link, status: "skipped", reason: msg });
                    this.log.error(`[telegram-user-tool] join — unexpected error for ${link}: ${msg}`);
                }
            }

            // Базовая задержка между итерациями (не после последней).
            if (link !== links[links.length - 1]) {
                await sleep(randomDelay());
            }
        }

        const joined = results.filter((r) => r.status === "joined").length;
        const skipped = results.filter((r) => r.status === "skipped").length;
        this.log.info(`[telegram-user-tool] join — done: joined=${joined} skipped=${skipped} floodWaits=${floodWaits.length}`);

        return {
            joined,
            skipped,
            total: links.length,
            hadFloodWait: floodWaits.length > 0,
            floodWaits,
            results,
        };
    }

    // ── Funnel metrics (funnel-tracking) ──────────────────────────────

    /**
     * Публичный канал текущего аккаунта — канал, закреплённый в профиле
     * (personal channel). Берётся из `users.GetFullUser(self)`:
     * `personalChannelId` + `personalChannelMessage`, `access_hash` — из массива
     * `chats` того же ответа (peerCache-конвенция, без getEntity). Возвращает
     * null, если у аккаунта не задан personal channel.
     */
    async getOwnPersonalChannel(): Promise<{
        inputPeer: Api.InputPeerChannel;
        inputChannel: Api.InputChannel;
        postId: number | null;
        title: string;
    } | null> {
        const client = await this.requireClient();
        const full = await client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }));
        const fullUser: any = full.fullUser;
        const channelId = fullUser?.personalChannelId;
        if (channelId == null) {
            this.log.info("[telegram-user-tool] getOwnPersonalChannel — no personal channel set");
            return null;
        }
        const postId: number | null =
            typeof fullUser.personalChannelMessage === "number" ? fullUser.personalChannelMessage : null;

        const chat = (full.chats as any[]).find(
            (c) => c instanceof Api.Channel && c.id?.toString() === channelId.toString(),
        ) as Api.Channel | undefined;

        if (!chat || chat.accessHash == null) {
            this.log.warn(
                `[telegram-user-tool] getOwnPersonalChannel — channel ${channelId} not found in chats or no access_hash`,
            );
            return null;
        }

        return {
            inputPeer: new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash }),
            inputChannel: new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash }),
            postId,
            title: chat.title,
        };
    }

    /** DEBUG-temp: права участника (self) в канале + restrictionReason канала. */
    async debugCheckAdmin(channel: Api.InputChannel): Promise<string> {
        const client = await this.requireClient();
        const participant = await client.invoke(
            new Api.channels.GetParticipant({ channel, participant: new Api.InputPeerSelf() }),
        );
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
        const chat = (full.chats as any[]).find((c) => c instanceof Api.Channel) as any;
        return JSON.stringify({
            participant: participant.participant,
            chatRestricted: chat?.restricted,
            restrictionReason: chat?.restrictionReason,
            banned: chat?.banned,
        }, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2);
    }

    /** Есть ли у собственного аккаунта фото профиля (диагностика, agent-avatar-check). */
    async hasOwnProfilePhoto(): Promise<boolean> {
        const client = await this.requireClient();
        const me = await client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }));
        const profilePhoto = (me.fullUser as any)?.profilePhoto;
        return !!(profilePhoto && profilePhoto instanceof Api.Photo);
    }

    /** Меняет био (`about`) собственного аккаунта (`account.UpdateProfile`). Лимит Telegram — 70 символов. */
    async updateOwnBio(about: string): Promise<void> {
        const client = await this.requireClient();
        await this.invokeChecked(() => client.invoke(new Api.account.UpdateProfile({ about })));
        this.log.info(`[telegram-user-tool] updateOwnBio — updated (${about.length} chars)`);
    }

    /** Меняет имя/фамилию собственного аккаунта (`account.UpdateProfile`). */
    async updateOwnName(firstName: string, lastName: string): Promise<void> {
        const client = await this.requireClient();
        await this.invokeChecked(() => client.invoke(new Api.account.UpdateProfile({ firstName, lastName })));
        this.log.info(`[telegram-user-tool] updateOwnName — updated to "${firstName} ${lastName}"`);
    }

    /** Меняет username собственного аккаунта (`account.UpdateUsername`). */
    async updateOwnUsername(username: string): Promise<void> {
        const client = await this.requireClient();
        await this.invokeChecked(() => client.invoke(new Api.account.UpdateUsername({ username })));
        this.log.info(`[telegram-user-tool] updateOwnUsername — updated to @${username}`);
    }

    /** Загружает фото профиля собственного аккаунта (`photos.UploadProfilePhoto`). */
    async uploadOwnProfilePhoto(filePath: string): Promise<void> {
        const client = await this.requireClient();
        const file = await client.uploadFile({
            file: new CustomFile(path.basename(filePath), fs.statSync(filePath).size, filePath),
            workers: 1,
        });
        await this.invokeChecked(() => client.invoke(new Api.photos.UploadProfilePhoto({ file })));
        this.log.info(`[telegram-user-tool] uploadOwnProfilePhoto — uploaded ${path.basename(filePath)}`);
    }

    /**
     * Публикует новый пост (фото + подпись) в канал — используется, чтобы пост
     * персоны был последним действием в канале (agent-post-refresh): в отличие
     * от редактирования существующего сообщения, новое сообщение сдвигает канал
     * в конец истории, а профильная превью-карточка (personalChannelMessage)
     * автоматически берёт самый свежий пост.
     */
    async postToChannel(inputChannel: Api.InputChannel, filePath: string, caption: string): Promise<{ messageId: number }> {
        const client = await this.requireClient();
        const result = await this.invokeChecked(() => client.sendFile(inputChannel, { file: filePath, caption }));
        this.log.info(`[telegram-user-tool] postToChannel — posted messageId=${(result as any)?.id}`);
        return { messageId: (result as any)?.id };
    }

    /** Просмотры поста канала (`messages.GetMessagesViews`, increment=false). */
    async getPostViews(peer: Api.TypeInputPeer, postId: number): Promise<number | null> {
        const client = await this.requireClient();
        const res = await client.invoke(
            new Api.messages.GetMessagesViews({ peer, id: [postId], increment: false }),
        );
        const views = (res.views?.[0] as any)?.views;
        return typeof views === "number" ? views : null;
    }

    /** Число подписчиков канала (`channels.GetFullChannel` → participantsCount). */
    async getChannelSubsCount(channel: Api.InputChannel): Promise<number | null> {
        const client = await this.requireClient();
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
        const count = (full.fullChat as any)?.participantsCount;
        return typeof count === "number" ? count : null;
    }

    // ── channel-discovery-similar (рекомендации похожих каналов) ───────────

    /**
     * Все каналы/мегагруппы из диалогов агента как ручки для обхода рекомендаций.
     * Один вызов getDialogs (известное окно top-200, см. getDialogs). access_hash
     * берётся из entity ответа (peerCache-конвенция, без getEntity). min-entity и
     * объекты без access_hash пропускаются — для рекомендаций непригодны.
     */
    async listDialogChannels(): Promise<DialogChannel[]> {
        const client = await this.requireClient();
        const dialogs = await this.invokeChecked(() => client.getDialogs({}));
        const out: DialogChannel[] = [];
        for (const d of dialogs as any[]) {
            const entity = d.entity;
            if (!(entity instanceof Api.Channel) || entity.accessHash == null || entity.min) continue;
            out.push({
                inputChannel: new Api.InputChannel({ channelId: entity.id, accessHash: entity.accessHash }),
                username: entity.username ?? null,
                title: entity.title ?? "",
                isBroadcast: entity.broadcast === true,
                chatId: d.id?.toString() ?? "",
            });
        }
        return out;
    }

    /**
     * Идентичность привязанного broadcast-канала по диалогу-каналу
     * (channel-content-analysis): broadcast-чат — это сам канал; мегагруппа-обсуждение —
     * через привязанный канал (resolveLinkedBroadcast). Возвращает null, если
     * привязанного канала нет (обычная мегагруппа). FLOOD_WAIT → FloodWaitError.
     */
    async resolveChannelIdentityForDialog(dc: DialogChannel): Promise<ChannelIdentity | null> {
        const handle: ChannelHandle | null = dc.isBroadcast
            ? dc
            : await this.resolveLinkedBroadcast(dc.inputChannel);
        if (!handle) return null;
        return {
            channelId: handle.inputChannel.channelId.toString(),
            accessHash: handle.inputChannel.accessHash?.toString() ?? "0",
            username: handle.username,
            title: handle.title,
        };
    }

    /** Собирает InputChannel-ручку из сохранённой идентичности (без сетевых вызовов). */
    buildChannelHandle(id: ChannelIdentity, title = ""): ChannelHandle {
        return {
            inputChannel: new Api.InputChannel({
                channelId: bigInt(id.channelId),
                accessHash: bigInt(id.accessHash),
            }),
            username: id.username,
            title,
        };
    }

    /**
     * Резолв публичного канала по username (fallback channel-content-analysis при
     * устаревшем accessHash в кэше → CHANNEL_INVALID). FLOOD_WAIT → FloodWaitError;
     * прочие ошибки → null.
     */
    async resolveChannelByUsername(username: string): Promise<ChannelHandle | null> {
        const client = await this.requireClient();
        try {
            const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username }));
            const channel = (resolved.chats as any[]).find((c) => c instanceof Api.Channel) as
                | Api.Channel
                | undefined;
            if (!channel || channel.accessHash == null) return null;
            return {
                inputChannel: new Api.InputChannel({ channelId: channel.id, accessHash: channel.accessHash }),
                username: channel.username ?? null,
                title: channel.title ?? "",
                isBroadcast: channel.broadcast === true,
            };
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            return null;
        }
    }

    /**
     * Привязанный broadcast-канал для мегагруппы-обсуждения: getFullChannel →
     * linkedChatId → объект канала из chats того же ответа. null, если связи нет
     * или объект недоступен. Зеркало хопа joinDiscussionGroups. FLOOD_WAIT →
     * FloodWaitError.
     */
    async resolveLinkedBroadcast(channel: Api.InputChannel): Promise<ChannelHandle | null> {
        const client = await this.requireClient();
        let full: any;
        try {
            full = await this.invokeChecked(() => client.invoke(new Api.channels.GetFullChannel({ channel })));
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            throw err;
        }
        const linkedId = full.fullChat?.linkedChatId;
        if (linkedId == null) return null;
        const linked = (full.chats as any[]).find(
            (c) => c instanceof Api.Channel && (c.id?.equals?.(linkedId) || c.id?.toString() === linkedId.toString()),
        ) as Api.Channel | undefined;
        if (!linked || linked.accessHash == null || linked.min) return null;
        return {
            inputChannel: new Api.InputChannel({ channelId: linked.id, accessHash: linked.accessHash }),
            username: linked.username ?? null,
            title: linked.title ?? "",
        };
    }

    /**
     * Похожие каналы (`channels.GetChannelRecommendations`). Возвращает только
     * пригодные публичные каналы. `truncated` — выдача усечена (нет Premium):
     * ответ ChatsSlice и `count` больше числа отданных. FLOOD_WAIT → FloodWaitError.
     */
    async getChannelRecommendations(channel: Api.InputChannel): Promise<{
        similar: ChannelHandle[];
        totalCount: number;
        truncated: boolean;
    }> {
        const client = await this.requireClient();
        let res: any;
        try {
            res = await client.invoke(new Api.channels.GetChannelRecommendations({ channel }));
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            throw err;
        }
        const chats = (res.chats as any[]) ?? [];
        const similar: ChannelHandle[] = [];
        for (const c of chats) {
            if (!(c instanceof Api.Channel) || c.accessHash == null || c.min) continue;
            similar.push({
                inputChannel: new Api.InputChannel({ channelId: c.id, accessHash: c.accessHash }),
                username: c.username ?? null,
                title: c.title ?? "",
            });
        }
        const isSlice = res instanceof Api.messages.ChatsSlice;
        const totalCount = isSlice ? Number(res.count ?? chats.length) : chats.length;
        return { similar, totalCount, truncated: isSlice && totalCount > chats.length };
    }

    /** Число подписчиков канала с типизацией FLOOD_WAIT (для гейта обхода). */
    async getChannelSubscribers(channel: Api.InputChannel): Promise<number | null> {
        try {
            return await this.getChannelSubsCount(channel);
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            throw err;
        }
    }

    /**
     * Сигналы для candidate-гейта обхода (channel-discovery-similar) из ОДНОГО
     * `channels.GetFullChannel`: число подписчиков, id привязанной группы обсуждения
     * (null — группы нет), описание канала и id закреплённого сообщения (channel-context,
     * `pinnedMsgId` — из того же ответа, без дополнительного вызова; текст закрепа
     * получить отдельно через `getChannelMessageText`). Объединяет проверку подписчиков,
     * наличия группы и сбор текста темы без лишних вызовов. FLOOD_WAIT → FloodWaitError.
     */
    async getChannelGateInfo(channel: Api.InputChannel): Promise<{
        subscribers: number | null;
        linkedChatId: string | null;
        about: string | null;
        pinnedMsgId: number | null;
    }> {
        const client = await this.requireClient();
        let full: any;
        try {
            full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            throw err;
        }
        const fullChat = full.fullChat as any;
        const count = fullChat?.participantsCount;
        const linkedId = fullChat?.linkedChatId;
        const about = fullChat?.about;
        const pinnedMsgId = fullChat?.pinnedMsgId;
        return {
            subscribers: typeof count === "number" ? count : null,
            linkedChatId: linkedId == null ? null : linkedId.toString(),
            about: typeof about === "string" && about.length > 0 ? about : null,
            pinnedMsgId: typeof pinnedMsgId === "number" ? pinnedMsgId : null,
        };
    }

    /**
     * Текст сообщения канала по id, в собственной нумерации канала (не чата
     * обсуждения) — тот же примитив, что `getRecentPosts` использует для постов
     * (channel-context: текст закреплённого сообщения по `pinnedMsgId` из
     * `getChannelGateInfo`). `null` — сообщение недоступно/удалено. FLOOD_WAIT →
     * FloodWaitError.
     */
    async getChannelMessageText(channel: Api.InputChannel, msgId: number): Promise<string | null> {
        const client = await this.requireClient();
        const peer = new Api.InputPeerChannel({ channelId: channel.channelId, accessHash: channel.accessHash });
        let messages: any[];
        try {
            messages = await this.invokeChecked(() => client.getMessages(peer, { ids: [msgId] }));
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            throw err;
        }
        const m = messages[0] as any;
        if (!m || typeof m.id !== "number") return null;
        return typeof m.message === "string" ? m.message : "";
    }

    /**
     * Последние `n` постов broadcast-канала с метриками вовлечённости
     * (channel-content-analysis). Одной выборкой истории достаём по каждому посту
     * `id`, `text`, `date`, `views`, `reactions` (сумма счётчиков), `forwards`,
     * `comments` (число комментариев привязанного обсуждения). Отсутствующие
     * метрики — 0. FLOOD_WAIT → FloodWaitError.
     */
    async getRecentPosts(channel: Api.InputChannel, n: number): Promise<ChannelPost[]> {
        const client = await this.requireClient();
        const peer = new Api.InputPeerChannel({
            channelId: channel.channelId,
            accessHash: channel.accessHash,
        });
        let messages: any[];
        try {
            messages = await this.invokeChecked(() => client.getMessages(peer, { limit: n }));
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            throw err;
        }
        const posts: ChannelPost[] = [];
        for (const m of messages as any[]) {
            const post = mapMessageToPost(m);
            if (post) posts.push(post);
        }
        return posts;
    }

    /**
     * Те же `n` последних постов, что и `getRecentPosts`, но по одному
     * сообщению за сетевой вызов, с рандомной паузой 10-30с между постами —
     * «человеческий» темп чтения (channel-activity-percentiles) вместо
     * одного пакетного запроса на 11 сообщений сразу. Отдельный метод, а не
     * режим `getRecentPosts`: последний используется и другими вызывающими
     * (channel-metrics, channel-discovery, channel-content-analysis), которым
     * такой темп не нужен и только замедлил бы их без причины. Ходит назад
     * по истории через `offsetId` (id последнего полученного поста), как
     * обычная пагинация `messages.GetHistory` без `reverse`. Останавливается
     * раньше `n`, если постов в канале меньше. FLOOD_WAIT → FloodWaitError.
     */
    async getPostsOneByOne(channel: Api.InputChannel, n: number): Promise<ChannelPost[]> {
        const client = await this.requireClient();
        const peer = new Api.InputPeerChannel({
            channelId: channel.channelId,
            accessHash: channel.accessHash,
        });

        const posts: ChannelPost[] = [];
        let offsetId = 0;
        for (let i = 0; i < n; i++) {
            let messages: any[];
            try {
                messages = await this.invokeChecked(() => client.getMessages(peer, { limit: 1, offsetId }));
            } catch (err: any) {
                const wait = parseFloodWait(err);
                if (wait !== null) throw new FloodWaitError(wait);
                throw err;
            }
            const post = mapMessageToPost(messages[0]);
            if (!post) break; // постов в канале меньше n
            posts.push(post);
            offsetId = post.id;

            if (i < n - 1) {
                const delay = (10 + Math.random() * 20) * 1000; // 10-30с
                await sleep(delay);
            }
        }
        return posts;
    }

    /**
     * Корневое сообщение ветки обсуждения канала по id поста в его собственной
     * нумерации (channel-post-watch) — резолвит служебную копию поста в чате
     * обсуждения через `messages.getDiscussionMessage`, БЕЗ вступления в сам
     * канал. Корневым считается последнее сообщение в ответе (grouped-альбомы
     * отдают несколько сообщений одного поста, отвечать нужно на последнее —
     * общепринятая практика клиентских библиотек, официально не
     * специфицировано). `unreadCount` — по этой конкретной ветке, для дешёвой
     * проверки «есть ли новые комментарии» без полного `getMessages`. null —
     * ветки/поста нет или ответ пуст. FLOOD_WAIT → FloodWaitError.
     */
    async getDiscussionMessage(
        channel: Api.InputChannel,
        msgId: number,
    ): Promise<{ chatId: string; rootMsgId: number; unreadCount: number } | null> {
        const client = await this.requireClient();
        const peer = new Api.InputPeerChannel({ channelId: channel.channelId, accessHash: channel.accessHash });
        let res: any;
        try {
            res = await this.invokeChecked(() =>
                client.invoke(new Api.messages.GetDiscussionMessage({ peer, msgId })),
            );
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            throw err;
        }
        const messages = res.messages as any[];
        if (!Array.isArray(messages) || messages.length === 0) return null;
        const root = messages[messages.length - 1];
        if (typeof root.id !== "number" || !root.peerId) return null;
        return {
            chatId: utils.getPeerId(root.peerId),
            rootMsgId: root.id,
            unreadCount: typeof res.unreadCount === "number" ? res.unreadCount : 0,
        };
    }

    /**
     * Все комментарии поста канала (monitor-v4-comment-signal) — обёртка над
     * `messages.GetReplies` (GramJS-параметр `replyTo`, "known as comments in
     * posts of broadcast channels"). `limit` не передаётся: GramJS сам
     * пагинирует запросы (несколько `GetReplies` под капотом, тот же приём,
     * что уже применяется в `getMessages` для истории >100 сообщений), пока не
     * заберёт все — верхнего предела на число комментариев нет (design.md,
     * Decision 2). `total` — общее число комментариев из ответа Telegram
     * (`TotalList.total`), не зависит от того, сколько из них реально
     * загружено — используется как дешёвый гейт до вызова LLM. FLOOD_WAIT →
     * FloodWaitError.
     */
    async getPostComments(channel: Api.InputChannel, msgId: number): Promise<{ total: number; comments: TgMessage[] }> {
        const client = await this.requireClient();
        const peer = new Api.InputPeerChannel({ channelId: channel.channelId, accessHash: channel.accessHash });
        let messages: any[] & { total?: number };
        try {
            messages = await this.invokeChecked(() => client.getMessages(peer, { replyTo: msgId }));
        } catch (err: any) {
            const wait = parseFloodWait(err);
            if (wait !== null) throw new FloodWaitError(wait);
            throw err;
        }

        // Тот же маппинг fromName/fromId, что getMessages (§ telegram_get_messages) —
        // GramJS уже резолвит m.sender из users/chats ответа.
        const comments: TgMessage[] = messages.map((m: any) => ({
            id: m.id,
            fromId: m.senderId?.toString() ?? "",
            fromName: (m.sender as any)?.firstName
                ? `${(m.sender as any).firstName ?? ""} ${(m.sender as any).lastName ?? ""}`.trim()
                : (m.sender as any)?.title ?? (m.senderId?.toString() ?? ""),
            text: m.text ?? m.message ?? "",
            date: m.date,
        }));

        return { total: typeof messages.total === "number" ? messages.total : comments.length, comments };
    }

    /**
     * Средний охват публикации канала по username (MTProto fallback для channel-discovery).
     * Резолвит username → InputChannel, берёт последние `limit` постов, возвращает среднее
     * значение `views`. Если канал не найден или постов нет — возвращает 0.
     * FLOOD_WAIT → FloodWaitError (вызывающая сторона обрабатывает как fail-closed).
     */
    async getChannelAvgPostReach(username: string, limit: number, log: Logger): Promise<number> {
        log.info(`[telegram-user-tool] getChannelAvgPostReach — @${username} limit=${limit}`);
        const handle = await this.resolveChannelByUsername(username);
        if (!handle) {
            log.warn(`[telegram-user-tool] getChannelAvgPostReach — channel not found: @${username}`);
            return 0;
        }
        const posts = await this.getRecentPosts(handle.inputChannel, limit);
        if (posts.length === 0) return 0;
        const totalViews = posts.reduce((sum, p) => sum + p.views, 0);
        return Math.round(totalViews / posts.length);
    }

    /**
     * Число неодобренных заявок на вступление в канал
     * (`messages.GetChatInviteImporters(requested=true)` → поле `count`).
     * `opts.link` — фильтр по конкретной пригласительной ссылке (funnel-tracking v3,
     * US-3): без него считает по всем ссылкам разом, как раньше.
     * InputPeer резолвится из peerCache (заполняется `getDialogs`). При нехватке
     * прав возвращает типизированный `{ error: "admin_required" }`, не бросает.
     */
    async getPendingJoinRequests(
        channelId: string,
        opts?: { link?: string },
    ): Promise<{ count: number } | { error: "admin_required" }> {
        const client = await this.requireClient();

        let peer = this.findChannelPeer(channelId);
        if (!peer) {
            // Заполнить peerCache диалогами и попробовать ещё раз.
            await this.getDialogs();
            peer = this.findChannelPeer(channelId);
        }
        if (!peer) {
            throw new Error(`Private channel ${channelId} not found in dialogs. Is the current account a member?`);
        }

        try {
            const res = await client.invoke(
                new Api.messages.GetChatInviteImporters({
                    peer,
                    requested: true,
                    link: opts?.link,
                    offsetDate: 0,
                    offsetUser: new Api.InputUserEmpty(),
                    limit: 1,
                }),
            );
            return { count: res.count };
        } catch (err: any) {
            const msg: string = err.message ?? String(err);
            if (msg.includes("CHAT_ADMIN_REQUIRED")) {
                this.log.warn(`[telegram-user-tool] getPendingJoinRequests — CHAT_ADMIN_REQUIRED for ${channelId}`);
                return { error: "admin_required" };
            }
            throw err;
        }
    }

    // ── private-invite-links ────────────────────────────────────────────

    /**
     * Инвайт-ссылка в приватный канал с обязательным подтверждением заявки
     * (`requestNeeded: true`), без лимита использований, без срока действия,
     * без платной подписки (subscriptionPricing не передаётся). `title` —
     * название ссылки в списке инвайт-ссылок канала (обычно agentId целевого
     * агента, для атрибуции заявок по источнику). Peer резолвится тем же
     * приёмом, что и getPendingJoinRequests.
     */
    async exportChatInvite(channelId: string, opts: { title: string }): Promise<{ link: string }> {
        const client = await this.requireClient();

        let peer = this.findChannelPeer(channelId);
        if (!peer) {
            await this.getDialogs();
            peer = this.findChannelPeer(channelId);
        }
        if (!peer) {
            throw new Error(`Private channel ${channelId} not found in dialogs.`);
        }

        const res = await client.invoke(
            new Api.messages.ExportChatInvite({ peer, requestNeeded: true, title: opts.title }),
        );
        const link = (res as any)?.link;
        if (typeof link !== "string") {
            throw new Error(`exportChatInvite — unexpected response shape for ${channelId}`);
        }
        this.log.info(`[telegram-user-tool] exportChatInvite — created request-needed link "${opts.title}" for ${channelId}`);
        return { link };
    }

    /**
     * Разрешает personalChannelMessage в настоящий текстовый пост:
     * personalChannelMessage — id ПОСЛЕДНЕГО события в канале, не обязательно
     * текстового поста, может указывать на MessageService (смена фото/названия
     * канала и т.п.), который нельзя ни прочитать/отредактировать как обычный
     * пост, ни снять с него просмотры (GetMessagesViews не возвращает views для
     * служебных сообщений). В этом случае берём ближайший предыдущий настоящий
     * текстовый пост из истории. null — в канале нет ни одного текстового поста
     * среди последних 20 сообщений.
     */
    private async resolvePersonalPostMessage(
        inputPeer: Api.TypeInputPeer,
        postId: number,
    ): Promise<Api.Message | null> {
        const client = await this.requireClient();
        const messages = await client.getMessages(inputPeer, { ids: [postId] });
        let msg = messages[0] as any;
        if (!(msg instanceof Api.Message)) {
            const recent = await client.getMessages(inputPeer, { limit: 20 });
            msg = recent.find((m: any) => m instanceof Api.Message);
            if (!msg) return null;
        }
        return msg as Api.Message;
    }

    /**
     * Id настоящего текстового поста для снятия просмотров (funnel-tracking,
     * этап 5): см. resolvePersonalPostMessage — personalChannelMessage может
     * указывать на служебное сообщение о смене названия/фото канала, вышедшее
     * позже поста. null — в канале нет текстового поста среди последних 20
     * сообщений (просмотры не собираются, это не ошибка).
     */
    async resolvePersonalPostId(inputPeer: Api.TypeInputPeer, postId: number): Promise<number | null> {
        const msg = await this.resolvePersonalPostMessage(inputPeer, postId);
        return msg?.id ?? null;
    }

    /**
     * Диагностика: сырой класс/содержание одного сообщения канала по id
     * (retrofit-check — "пост не последнее действие" в канале). Не
     * фильтрует служебные сообщения, в отличие от resolvePersonalPostMessage.
     */
    async debugChannelMessage(inputPeer: Api.TypeInputPeer, msgId: number): Promise<{ className: string; summary: string } | null> {
        const client = await this.requireClient();
        const messages = await client.getMessages(inputPeer, { ids: [msgId] });
        const msg = messages[0] as any;
        if (!msg) return null;
        const className = msg.className ?? msg.constructor?.name ?? "unknown";
        const summary =
            msg instanceof Api.Message
                ? (msg.message ?? "").slice(0, 80)
                : JSON.stringify(msg.action ?? msg, null, 0).slice(0, 200);
        return { className, summary };
    }

    /**
     * Правит закреплённый в профиле пост (personalChannelMessage) текущего
     * аккаунта: убирает строки, целиком являющиеся ссылкой, и дописывает новую
     * ссылку тремя строками в хвост текста. Остальной текст поста не трогается.
     * Возвращает { ok: false }, если у аккаунта нет personal channel/поста —
     * вызывающая сторона пропускает такого агента, не валит весь прогон.
     */
    private async readPersonalChannelPost(): Promise<
        | { ok: true; text: string; inputPeer: Api.TypeInputPeer; postId: number }
        | { ok: false; reason: string }
    > {
        const personal = await this.getOwnPersonalChannel();
        if (!personal || personal.postId == null) {
            return { ok: false, reason: "no personal channel or post" };
        }
        const msg = await this.resolvePersonalPostMessage(personal.inputPeer, personal.postId);
        if (!msg) {
            return { ok: false, reason: "no text post found in channel history" };
        }

        const text: string = typeof msg.message === "string" ? msg.message : "";
        return { ok: true, text, inputPeer: personal.inputPeer, postId: msg.id };
    }

    /**
     * Читает строки-ссылки, реально присутствующие в закреплённом посте, не редактируя его —
     * для проверки соответствия ссылке в реестре private-invites (tg_private_invite_links,
     * verifyOnly).
     */
    async getPersonalChannelPostLinks(): Promise<{ ok: true; links: string[] } | { ok: false; reason: string }> {
        const post = await this.readPersonalChannelPost();
        if (!post.ok) return post;
        const LINK_LINE = /^https?:\/\/\S+$/;
        const links = post.text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => LINK_LINE.test(l));
        return { ok: true, links };
    }

    async updatePersonalChannelPostLink(link: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        const post = await this.readPersonalChannelPost();
        if (!post.ok) return post;

        const LINK_LINE = /^https?:\/\/\S+$/;
        const kept = post.text.split("\n").filter((line) => !LINK_LINE.test(line.trim()));
        const base = kept.join("\n").replace(/\s+$/u, "");
        const newText = `${base}\n${link}\n${link}\n${link}`;

        const client = await this.requireClient();
        try {
            await client.invoke(
                new Api.messages.EditMessage({ peer: post.inputPeer, id: post.postId, message: newText }),
            );
        } catch (err: any) {
            // MESSAGE_NOT_MODIFIED — Telegram отказывается «редактировать» сообщение тем же
            // текстом, каким оно уже является. Желаемое состояние (ссылка верна в посте) уже
            // достигнуто — это успех, а не ошибка (иначе retryPendingOnly/verifyOnly никогда
            // не подтвердят агентов, у которых пост и так правильный).
            if (err.errorMessage !== "MESSAGE_NOT_MODIFIED") throw err;
            this.log.info(`[telegram-user-tool] updatePersonalChannelPostLink — post ${post.postId} already up to date`);
            return { ok: true };
        }
        this.log.info(`[telegram-user-tool] updatePersonalChannelPostLink — updated post ${post.postId}`);
        return { ok: true };
    }

    /**
     * Правит название канала и следом публикует НОВЫЙ пост (не редактирует
     * старый) — retrofit-channel-repair: EditMessage правит текст на месте,
     * не меняя id/позицию сообщения, поэтому если после старого поста уже
     * есть более позднее служебное событие (например EditTitle), сам пост
     * так и останется не последним действием в канале даже после правки
     * текста. EditTitle здесь и подавно добавляет новое событие после
     * текущего поста. Поэтому: сначала EditTitle, затем — свежий пост
     * (фото + текст персоны с реальной ссылкой агента из реестра) поверх,
     * чтобы именно пост оказался последним действием в канале. Старый пост
     * не удаляется и не редактируется, просто перестаёт быть последним
     * сообщением.
     */
    async fixChannelTitleAndRepost(
        correctTitle: string,
        personName: string,
        inviteLink: string,
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
        const personal = await this.getOwnPersonalChannel();
        if (!personal) return { ok: false, reason: "no personal channel" };

        const client = await this.requireClient();
        try {
            if (personal.title !== correctTitle) {
                await client.invoke(new Api.channels.EditTitle({ channel: personal.inputChannel, title: correctTitle }));
            }

            const template = loadPersonaTemplate(personName);
            const LINK_LINE = /^https?:\/\/\S+$/;
            const kept = template.postText.split("\n").filter((line) => !LINK_LINE.test(line.trim()));
            const base = kept.join("\n").replace(/\s+$/u, "");
            const newText = `${base}\n${inviteLink}\n${inviteLink}\n${inviteLink}`;

            await client.sendFile(personal.inputChannel, { file: template.channelPostPhotoPath, caption: newText });
            this.log.info(`[telegram-user-tool] fixChannelTitleAndRepost — title fixed + new post published`);
            return { ok: true };
        } catch (err: any) {
            return { ok: false, reason: err?.errorMessage ?? err?.message ?? String(err) };
        }
    }

    /**
     * Создаёт и закрепляет канал персоны уже работающему агенту, у которого
     * он не был создан при регистрации (retrofit-persona-channel, разовый
     * скрипт) — тонкая обёртка над `createPersonaChannel` (core/tdata/account-setup.ts),
     * без остального конвейера `prepareAccount` (без очистки фото/каналов,
     * смены 2FA, сброса сессий, смены профиля/username — тот аккаунт уже
     * настроен и работает). Username аккаунта берётся текущим (не меняется),
     * только читается для суффикса `_ch` канала.
     */
    async setupPersonaChannel(personName: string): Promise<{ ok: true; channelUsername: string } | { ok: false; reason: string }> {
        const client = await this.requireClient();
        let template;
        try {
            template = loadPersonaTemplate(personName);
        } catch (err: any) {
            return { ok: false, reason: err?.message ?? String(err) };
        }
        const me = await client.getMe();
        const accountUsername = (me as any)?.username as string | undefined;
        if (!accountUsername) {
            return { ok: false, reason: "account has no username set" };
        }
        try {
            await createPersonaChannel(client, template, accountUsername, this.log);
            return { ok: true, channelUsername: `${accountUsername}_ch` };
        } catch (err: any) {
            return { ok: false, reason: err?.message ?? String(err) };
        }
    }

    /**
     * Текущий @username аккаунта прямо с Telegram (не из tg-account.json) — источник истины
     * для бэкфилла `AccountConfig.username` (backfill-agent-usernames). `undefined`, если у
     * аккаунта username не установлен вовсе (не все аккаунты его имеют).
     */
    async getSelfUsername(): Promise<string | undefined> {
        const client = await this.requireClient();
        const me = await client.getMe();
        return (me as any)?.username as string | undefined;
    }

    /** Поиск InputPeer канала в peerCache по id, терпимый к префиксу -100. */
    private findChannelPeer(channelId: string): Api.TypeInputPeer | undefined {
        const direct = this.peerCache.get(channelId);
        if (direct) return direct;
        const stripped = channelId.replace(/^-100/, "");
        for (const [key, peer] of this.peerCache) {
            if (key.replace(/^-100/, "") === stripped) return peer;
            if (peer instanceof Api.InputPeerChannel && peer.channelId.toString() === stripped) return peer;
        }
        return undefined;
    }

    // ── Proxy probe (tg-agent-create-proxy-provisioning) ───────────────

    /**
     * Проверяет, что прокси-кандидат пропускает MTProto-хендшейк, БЕЗ отправки кода
     * авторизации — в отличие от `authSendCode`, который сразу следом за `connect()` шлёт
     * `Api.auth.SendCode` (реальный код в Telegram/SMS). Нужно для подбора рабочего прокси
     * ДО входа в аккаунт (сессии ещё нет): гонять `authSendCode` по нескольким кандидатам
     * означало бы слать реальный код на каждую неудачную попытку и упереться в флуд-лимит
     * Telegram на codeRequest ещё до авторизации. Кидает те же подклассы ошибок подключения,
     * что `ensureClient` (см. `ConnectTimeoutError`/`SessionRevokedError`), не пишет и не
     * читает `AccountConfig` — вызывающий сам управляет циклом create/probe/delete кандидатов.
     */
    async probeProxy(params: { apiId: number; apiHash: string; proxy: ProxyConfig }): Promise<void> {
        const { apiId, apiHash, proxy } = params;
        const MAX_ATTEMPTS = 3;
        const CONNECT_TIMEOUT_MS = 20_000;
        this.log.info(
            `[telegram-user-tool] probeProxy — checking proxy ${proxy.host}:${proxy.port} (${MAX_ATTEMPTS} attempts, ${CONNECT_TIMEOUT_MS / 1000}s timeout each)`,
        );

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
                connectionRetries: 1,
                autoReconnect: false,
                baseLogger: new GramJsBridgeLogger(this.log),
                connection: ConnectionTCPObfuscated,
                useWSS: false,
                ...buildProxyOptions(proxy),
            });

            try {
                const connectTimeout = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS),
                );
                await Promise.race([client.connect(), connectTimeout]);
                await client.disconnect().catch(() => {});
                this.log.info(`[telegram-user-tool] probeProxy — OK on attempt ${attempt}/${MAX_ATTEMPTS}`);
                return;
            } catch (err: any) {
                await client.disconnect().catch(() => {});
                this.log.warn(
                    `[telegram-user-tool] probeProxy — attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message ?? err}`,
                );
                if (attempt === MAX_ATTEMPTS) {
                    if (typeof err.code === "number" && err.code === 401) {
                        throw new SessionRevokedError(err.code, err.errorMessage ?? err.message);
                    }
                    throw new ConnectTimeoutError(CONNECT_TIMEOUT_MS, attempt, MAX_ATTEMPTS, proxy, err);
                }
            }
        }
    }

    // ── Auth ──────────────────────────────────────────────────────────

    async authSendCode(params: {
        apiId: number;
        apiHash: string;
        phoneNumber: string;
        proxy?: ProxyConfig;
    }): Promise<AuthSendCodeResult> {
        const { apiId, apiHash, phoneNumber, proxy } = params;
        const MAX_RETRIES = 3;
        const TIMEOUT_MS = 60_000;
        this.log.info(
            `[telegram-user-tool] tg_auth_send_code — phoneNumber=${phoneNumber}, ${MAX_RETRIES} attempts, ${TIMEOUT_MS / 1000}s timeout each (up to ${(MAX_RETRIES * TIMEOUT_MS) / 1000}s total)`,
        );

        let lastError: any;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const existing = this.authSessions.get(phoneNumber);
            if (existing) {
                await existing.disconnect().catch(() => {});
                this.authSessions.delete(phoneNumber);
            }

            const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
                connectionRetries: 1,
                baseLogger: new GramJsBridgeLogger(this.log),
                connection: ConnectionTCPObfuscated,
                useWSS: !proxy,
                ...buildProxyOptions(proxy),
            });

            try {
                this.log.info(`[telegram-user-tool] tg_auth_send_code — attempt ${attempt}/${MAX_RETRIES}`);
                await Promise.race([
                    client.connect(),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(`connect timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
                    ),
                ]);
                const result = (await Promise.race([
                    client.invoke(new Api.auth.SendCode({ phoneNumber, apiId, apiHash, settings: new Api.CodeSettings({}) })),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(`sendCode timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
                    ),
                ])) as any;

                this.authSessions.set(phoneNumber, client);
                this.log.info(`[telegram-user-tool] tg_auth_send_code — success on attempt ${attempt}/${MAX_RETRIES}, type=${result.type?.className}`);
                return { phoneCodeHash: result.phoneCodeHash, codeType: result.type?.className ?? "unknown" };
            } catch (err: any) {
                await client.disconnect().catch(() => {});
                lastError = err;
                this.log.warn(`[telegram-user-tool] tg_auth_send_code — attempt ${attempt}/${MAX_RETRIES} failed: ${err.message ?? err}`);
                if (attempt < MAX_RETRIES) await sleep(2_000);
            }
        }

        this.log.error(`[telegram-user-tool] tg_auth_send_code — all ${MAX_RETRIES} attempts failed`);
        throw lastError;
    }

    async authSignIn(params: {
        phoneNumber: string;
        phoneCodeHash: string;
        phoneCode: string;
        password?: string;
    }): Promise<{ sessionString: string } | { error: string; needsPassword: true }> {
        const { phoneNumber, phoneCodeHash, phoneCode, password } = params;
        const MAX_RETRIES = 3;
        const TIMEOUT_MS = 60_000;
        this.log.info(`[telegram-user-tool] tg_auth_sign_in — phoneNumber=${phoneNumber}, ${MAX_RETRIES} attempts, ${TIMEOUT_MS / 1000}s timeout each`);

        const client = this.authSessions.get(phoneNumber);
        if (!client) {
            throw new Error("No auth session found for this phone number. Call tg_auth_send_code first.");
        }

        const cleanup = async () => {
            this.authSessions.delete(phoneNumber);
            await client.disconnect().catch(() => {});
        };

        const invokeWithTimeout = <T>(p: Promise<T>) =>
            Promise.race([
                p,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`invoke timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
                ),
            ]);

        // Phase 1: sign in, retry only on timeout
        let needs2FA = false;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                this.log.info(`[telegram-user-tool] tg_auth_sign_in — attempt ${attempt}/${MAX_RETRIES}`);
                await invokeWithTimeout(client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode })));
                break;
            } catch (err: any) {
                if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
                    needs2FA = true;
                    break;
                }
                this.log.warn(`[telegram-user-tool] tg_auth_sign_in — attempt ${attempt}/${MAX_RETRIES} failed: ${err.message ?? err}`);
                if (attempt === MAX_RETRIES || !err.message?.includes("timed out")) {
                    await cleanup();
                    throw err;
                }
            }
        }

        // Phase 2: 2FA if needed
        if (needs2FA) {
            if (!password) {
                // Сессия НЕ закрывается: ожидается повторный вызов с паролем.
                return { error: "2FA password is required. Call tg_auth_sign_in again with the password parameter.", needsPassword: true };
            }
            try {
                const pwdInfo = (await invokeWithTimeout(client.invoke(new Api.account.GetPassword()))) as any;
                const pwdCheck = await computeCheck(pwdInfo, password);
                await invokeWithTimeout(client.invoke(new Api.auth.CheckPassword({ password: pwdCheck })));
            } catch (pwdErr: any) {
                await cleanup();
                this.log.error(`[telegram-user-tool] tg_auth_sign_in — 2FA error: ${pwdErr.message ?? pwdErr}`);
                throw pwdErr;
            }
        }

        const sessionString = (client.session as StringSession).save();
        await cleanup();
        this.log.info(`[telegram-user-tool] tg_auth_sign_in — success, sessionString length=${sessionString.length}`);
        return { sessionString };
    }

    /**
     * Закрывает и убирает из `authSessions` клиент, оставленный `authSendCode`,
     * если `authSignIn` для него так и не был вызван (tg-agent-autoregistration:
     * needs_manual_code — код не пришёл, второй шаг не состоится). Без этого
     * клиент остаётся подключённым и его внутренний `_updateLoop`
     * (`telegram/client/updates.js`) бесконечно ретраит, засоряя лог
     * "Not connected"/"TIMEOUT". Идемпотентно — вызов без активной сессии на
     * этот номер ничего не делает (`authSignIn` сам чистит её при успехе).
     */
    async abortAuthSession(phoneNumber: string): Promise<void> {
        const client = this.authSessions.get(phoneNumber);
        if (!client) return;
        this.authSessions.delete(phoneNumber);
        await client.disconnect().catch(() => {});
    }
}
