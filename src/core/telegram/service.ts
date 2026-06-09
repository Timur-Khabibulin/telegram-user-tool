// core/telegram/service.ts — MTProto-операции поверх GramJS.
//
// Чистое ядро Telegram: управление клиентом (ленивый singleton по аккаунту),
// peerCache и сами операции (dialogs, messages, mark_as_read, reply, send_dm,
// dm_dialogs, join). Не зависит от OpenClaw — логирование инжектируется через
// Logger, результаты возвращаются обычными объектами. Логика перенесена
// один-в-один из прежнего плагина (R-B2): лимиты, паузы, ретраи, обработка
// ошибок Telegram сохранены.

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { ConnectionTCPObfuscated } from "telegram/network/connection/TCPObfuscated";
import { computeCheck } from "telegram/Password";
import type { Logger } from "../logger";
import type { AccountConfig, ProxyConfig } from "../config";
import { loadAccountConfig } from "../config";
import { GramJsBridgeLogger } from "./gramjs-logger";

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
}

export interface DmDialog {
    userId: string;
    accessHash: string;
    userName: string | null;
    firstName: string | null;
    unreadCount: number;
    readInboxMaxId: number;
}

export interface JoinResult {
    link: string;
    status: "joined" | "skipped";
    reason?: string;
    discussionChatId?: string;
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

// ─── Helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Извлекает X из "FLOOD_WAIT_X". */
function parseFloodWait(msg: string): number | null {
    const m = msg.match(/FLOOD_WAIT[_ ](\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

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

    constructor(private readonly log: Logger) {}

    // ── Account ───────────────────────────────────────────────────────

    /** Загружает и фиксирует конфиг аккаунта агента. */
    loadAccount(agentId: string): { ok: true; accountId: string } {
        const configPath = `~/.openclaw/workspace-${agentId}/tg-account.json`;
        this.log.info(`[telegram-user-tool] tg_load_account — loading from ${configPath}`);
        const cfg = loadAccountConfig(agentId);
        this.accountConfig = cfg;
        this.log.info(`[telegram-user-tool] tg_load_account — loaded accountId=${cfg.accountId}`);
        return { ok: true, accountId: cfg.accountId };
    }

    private resolveAccountConfig(): AccountConfig {
        if (!this.accountConfig) {
            throw new Error("Account config not loaded. Call tg_load_account first.");
        }
        return this.accountConfig;
    }

    private clientKey(accountId: string): string {
        return `tg-user:${accountId}`;
    }

    // ── Lazy client init ──────────────────────────────────────────────

    private async ensureClient(): Promise<TelegramClient | null> {
        const account = this.resolveAccountConfig();
        const key = this.clientKey(account.accountId);

        const existing = this.clients.get(key);
        if (existing) {
            if (existing.connected) return existing;
            await existing.disconnect().catch(() => {});
            this.clients.delete(key);
        }

        if (!account.apiId || !account.apiHash) {
            this.log.error("[telegram-user-tool] ensureClient — missing apiId or apiHash");
            return null;
        }
        if (!account.sessionString) {
            this.log.error("[telegram-user-tool] ensureClient — missing sessionString");
            return null;
        }

        const MAX_ATTEMPTS = 3;
        const CONNECT_TIMEOUT_MS = 15_000;
        const proxyInfo = account.proxy ? ` via proxy ${account.proxy.host}:${account.proxy.port}` : "";

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
                langCode:       account.device?.langCode       ?? "en",
                systemLangCode: account.device?.systemLangCode ?? "en",
                connection: ConnectionTCPObfuscated,
                useWSS: !account.proxy,
                ...buildProxyOptions(account.proxy),
            });

            try {
                const connectTimeout = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS),
                );
                await Promise.race([client.connect(), connectTimeout]);

                this.clients.set(key, client);
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
                    return null;
                }
            }
        }

        return null;
    }

    /** Возвращает подключённый клиент или бросает «Client not connected». */
    private async requireClient(): Promise<TelegramClient> {
        const client = await this.ensureClient();
        if (!client) throw new Error("Client not connected");
        return client;
    }

    /**
     * Закрывает все подключённые клиенты. Диспетчер вызывает в конце прогона
     * (раздел 4, шаг 6), чтобы процесс мог штатно завершиться. Идемпотентно.
     */
    async disconnect(): Promise<void> {
        for (const [key, client] of this.clients) {
            await client.disconnect().catch(() => {});
            this.clients.delete(key);
        }
    }

    // ── telegram_get_dialogs ──────────────────────────────────────────

    async getDialogs(): Promise<{ groups: GroupDialog[] }> {
        this.log.info("[telegram-user-tool] tool:telegram_get_dialogs called");
        const client = await this.requireClient();

        // todo: ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (peerCache window): берём только первые 100 диалогов. Группы/каналы за пределами топ-100 не попадают в peerCache → действия по
        // ним (mark_as_read/reply, а в dm-send — отправка по sourceChatId кандидата
        // из БД) промахиваются мимо кэша. Сейчас это не краш (скиллы пропускают
        // такие чаты / dm-send ловит "No InputPeer cached" и делает skip), но «хвост»
        // диалогов не обрабатывается. Полное решение — пагинация iterDialogs (забрать
        // ВСЕ диалоги). См. design.md task-scheduler → «Риски и открытые вопросы».
        const dialogs = await client.getDialogs({ limit: 100 });

        const groups = dialogs
            .filter((d: any) => d.isGroup || d.isChannel)
            .map((d: any) => {
                const chatId: string = d.id?.toString();

                // Конструируем InputPeer явно из d.entity.
                // d.entity — Channel/Chat/User из ответа getDialogs, у него всегда
                // есть accessHash пока мы внутри этого вызова. peerCache заполняется
                // для ВСЕХ групп/каналов, а не только с непрочитанными — иначе
                // mark_as_read не сможет пометить чаты без unread (BUG-002).
                const entity = d.entity;
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

                return {
                    chatId,
                    title: d.title ?? "",
                    unreadCount: d.dialog?.unreadCount ?? 0,
                    readInboxMaxId: d.dialog?.readInboxMaxId ?? 0,
                };
            })
            .filter((g) => g.unreadCount > 0);

        this.log.info(
            `[telegram-user-tool] tool:telegram_get_dialogs — found ${groups.length} groups with unread messages`,
        );
        return { groups };
    }

    /**
     * Карта chatId → title для всех групп/каналов диалогов.
     * Используется синхронизацией БД каналов (отделяет Telegram от слоя БД).
     */
    async listGroupChannels(): Promise<Map<string, string>> {
        const client = await this.requireClient();
        const dialogs = await client.getDialogs({});
        return new Map(
            dialogs
                .filter((d: any) => d.isGroup || d.isChannel)
                .map((d: any) => [d.id?.toString() ?? "", d.title ?? ""] as [string, string])
                .filter(([chatId]) => chatId !== ""),
        );
    }

    // ── telegram_get_messages ─────────────────────────────────────────

    async getMessages(chatId: string, minId: number, limit: number): Promise<{ chatId: string; messages: TgMessage[] }> {
        this.log.info(
            `[telegram-user-tool] tool:telegram_get_messages called — chatId=${chatId} minId=${minId} limit=${limit}`,
        );
        const client = await this.requireClient();
        const safeLimit = Math.min(limit, 100);

        const peer = BigInt(chatId);
        const messages = await client.getMessages(peer, { minId, limit: safeLimit });

        const result = messages
            .filter((m: any) => {
                // Публикации от владельца канала в обсуждении приходят с sender типа
                // Channel (не User) — автоматически пересланные посты. Игнорируем.
                if (m.sender instanceof Api.Channel) {
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
                return entry;
            });

        const withReply = result.filter((m) => m.replyToMsgId !== undefined).length;
        this.log.info(
            `[telegram-user-tool] tool:telegram_get_messages — chatId=${chatId} returned ${result.length} messages, ${withReply} with replyToMsgId`,
        );
        return { chatId, messages: result };
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
        if (peer instanceof Api.InputPeerChannel) {
            await client.invoke(
                new Api.channels.ReadHistory({
                    channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }),
                    maxId,
                }),
            );
        } else {
            await client.invoke(new Api.messages.ReadHistory({ peer, maxId }));
        }

        this.log.info(`[telegram-user-tool] tool:telegram_mark_as_read — marked as read chatId=${chatId} up to maxId=${maxId}`);
        return { ok: true };
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

        const result = await client.sendMessage(peer as any, { message: text, replyTo: replyToMessageId });
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
        const result = await client.sendMessage("me", { message: text, parseMode });
        this.log.info(`[telegram-user-tool] sendSavedMessage — sent report messageId=${result.id} to Saved Messages`);
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

        const trySend = () => client.sendMessage(peer as any, { message: text });

        try {
            const result = await trySend();
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

            const waitSec = parseFloodWait(msg);
            if (waitSec !== null) {
                this.log.warn(`[telegram-user-tool] tool:telegram_send_dm — FLOOD_WAIT ${waitSec}s for userId=${userId}, waiting...`);
                await sleep(waitSec * 1000);
                // Одна повторная попытка
                try {
                    const result = await trySend();
                    this.log.info(`[telegram-user-tool] tool:telegram_send_dm — retry sent messageId=${result.id} to userId=${userId}`);
                    return { ok: true, messageId: result.id };
                } catch (retryErr: any) {
                    const retryMsg: string = retryErr.message ?? String(retryErr);
                    if (parseFloodWait(retryMsg) !== null) {
                        this.log.warn(`[telegram-user-tool] tool:telegram_send_dm — repeated FLOOD_WAIT for userId=${userId}`);
                        return { error: "flood_wait" };
                    }
                    throw retryErr;
                }
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
        const dialogs = await client.getDialogs({ limit: 100 });

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
                const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username }));
                const channel = resolved.chats?.find((c: any) => c instanceof Api.Channel) as Api.Channel | undefined;

                if (!channel || channel.min) {
                    results.push({ link, status: "skipped", reason: "channel not found or min entity" });
                    this.log.info(`[telegram-user-tool] join — skipped ${link}: channel not found`);
                    continue;
                }

                const inputChannel = new Api.InputChannel({ channelId: channel.id, accessHash: channel.accessHash! });
                const fullChannel = await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel }));
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

                // Вступаем. При FLOOD_WAIT: ждём и делаем одну повторную попытку;
                // если снова FLOOD_WAIT — пробрасываем (канал пропускается).
                const discussionInput = new Api.InputChannel({ channelId: discussionChat.id, accessHash: discussionChat.accessHash! });

                const joinWithRetry = async () => {
                    try {
                        await client.invoke(new Api.channels.JoinChannel({ channel: discussionInput }));
                    } catch (err: any) {
                        const waitSec = parseFloodWait(err.message ?? "");
                        if (waitSec !== null) {
                            floodWaits.push({ link, waitSeconds: waitSec });
                            this.log.warn(`[telegram-user-tool] join — FLOOD_WAIT ${waitSec}s for ${link}, waiting...`);
                            await sleep(waitSec * 1000);
                            await client.invoke(new Api.channels.JoinChannel({ channel: discussionInput }));
                        } else {
                            throw err;
                        }
                    }
                };

                await joinWithRetry();

                const discussionChatId = discussionChat.id.toString();
                results.push({ link, status: "joined", discussionChatId });
                this.log.info(`[telegram-user-tool] join — joined discussion group ${discussionChatId} for channel @${username}`);
            } catch (err: any) {
                const msg: string = err.message ?? String(err);

                const skipCodes = [
                    "USERNAME_NOT_OCCUPIED",
                    "USERNAME_INVALID",
                    "CHANNEL_PRIVATE",
                    "USER_ALREADY_PARTICIPANT",
                    "INVITE_REQUEST_SENT", // запрос на вступление отправлен (закрытая группа)
                ];

                const skipCode = skipCodes.find((c) => msg.includes(c));
                if (skipCode) {
                    results.push({ link, status: "skipped", reason: skipCode });
                    this.log.info(`[telegram-user-tool] join — skipped ${link}: ${skipCode}`);
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
        };
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

    /**
     * Число неодобренных заявок на вступление в канал
     * (`messages.GetChatInviteImporters(requested=true)` → поле `count`).
     * InputPeer резолвится из peerCache (заполняется `getDialogs`). При нехватке
     * прав возвращает типизированный `{ error: "admin_required" }`, не бросает.
     */
    async getPendingJoinRequests(
        channelId: string,
    ): Promise<{ count: number } | { error: "admin_required" }> {
        const client = await this.requireClient();

        let peer = this.findChannelPeer(channelId);
        if (!peer) {
            // Заполнить peerCache диалогами и попробовать ещё раз.
            await this.getDialogs();
            peer = this.findChannelPeer(channelId);
        }
        if (!peer) {
            throw new Error(`Private channel ${channelId} not found in dialogs. Is agent1 a member?`);
        }

        try {
            const res = await client.invoke(
                new Api.messages.GetChatInviteImporters({
                    peer,
                    requested: true,
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
}
