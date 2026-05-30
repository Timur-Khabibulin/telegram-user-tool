// index.ts — Telegram User Tool
// Обновлено для openclaw 2026.3.24
//
// Ключевые изменения по сравнению со старым API:
//   1. definePluginEntry из openclaw/plugin-sdk/plugin-entry вместо экспорта plain-объекта
//   2. Параметры через TypeBox Type.Object вместо raw JSON Schema
//   3. execute(_id, params) вместо handler: async (params, ctx)
//   4. api.logger вместо ctx?.log (захватывается в замыкании при register)
//   5. Возврат { content: [{ type: "text", text: JSON.stringify(…) }] } из execute
//   6. Опция { optional: true } вместо { names: [...] }
//   7. Монолитный импорт "openclaw/plugin-sdk" убран, используются субпути
//   8. configSchema убран из definePluginEntry (переносится в openclaw.plugin.json)
//   9. apiHash исправлен — был без кавычек (синтаксическая ошибка)
//  10. id плагина исправлен с "ч" на корректный ASCII-идентификатор

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { ConnectionTCPObfuscated } from "telegram/network/connection/TCPObfuscated";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { computeCheck } from "telegram/Password";
import type { PluginLogger } from "openclaw/plugin-sdk/core";

// ─── GramJS → PluginLogger bridge ────────────────────────────────────

class PluginBridgeLogger extends Logger {
    constructor(private readonly pluginLog: PluginLogger) {
        super(LogLevel.DEBUG);
    }

    log(level: LogLevel, message: string, _color: string) {
        switch (level) {
            case LogLevel.ERROR: this.pluginLog.error(`[gramjs] ${message}`); break;
            case LogLevel.WARN:  this.pluginLog.warn(`[gramjs] ${message}`);  break;
            case LogLevel.INFO:  this.pluginLog.info(`[gramjs] ${message}`);  break;
            case LogLevel.DEBUG: this.pluginLog.info(`[gramjs] ${message}`);  break;
        }
    }
}
import { registerChannelDbTools } from "./channels-db";
import { registerDmThreadsTools } from "./dm-threads-db";
import { saveReply } from "./replies-db";
import { registerJoinQueueTools } from "./join-queue-db";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── State ───────────────────────────────────────────────────────────

const clients = new Map<string, TelegramClient>();

interface ProxyConfig {
    type: "socks5" | "socks4";
    host: string;
    port: number;
    username?: string;
    password?: string;
}

interface DeviceConfig {
    deviceModel?: string;
    systemVersion?: string;
    appVersion?: string;
    langCode?: string;
    systemLangCode?: string;
}

interface AccountConfig {
    accountId: string;
    apiId: number;
    apiHash: string;
    sessionString: string;
    device?: DeviceConfig;
    proxy?: ProxyConfig;
}

let accountConfig: AccountConfig | null = null;

// InputPeer кэш: chatId (строка) → InputPeer с access_hash.
// Заполняется в telegram_get_dialogs, где GramJS уже имеет полный
// InputPeer с access_hash. Используется в mark_as_read и reply,
// чтобы не зависеть от in-memory кэша GramJS, который не переживает
// пересоздание клиента и приводит к PEER_ID_INVALID.
const peerCache = new Map<string, Api.TypeInputPeer>();
const authSessions = new Map<string, TelegramClient>();

// ─── Helpers ─────────────────────────────────────────────────────────

function clientKey(accountId: string): string {
    return `tg-user:${accountId}`;
}

function resolveConfigPath(agentId: string): string {
    return path.join(os.homedir(), ".openclaw", `workspace-${agentId}`, "tg-account.json");
}

function resolveAccountConfig(): AccountConfig {
    if (!accountConfig) {
        throw new Error("Account config not loaded. Call tg_load_account first.");
    }
    return accountConfig;
}

// ─── Lazy Client Init ─────────────────────────────────────────────────
// api.logger захватывается снаружи и передаётся сюда явно,
// поскольку execute() больше не получает ctx с log/cfg.

async function ensureClient(log: PluginLogger): Promise<TelegramClient | null> {
    const account = resolveAccountConfig();
    const key = clientKey(account.accountId);

    const existing = clients.get(key);
    if (existing) {
        if (existing.connected) return existing;
        await existing.disconnect().catch(() => {});
        clients.delete(key);
    }

    if (!account.apiId || !account.apiHash) {
        log.error("[telegram-user-tool] ensureClient — missing apiId or apiHash");
        return null;
    }
    if (!account.sessionString) {
        log.error("[telegram-user-tool] ensureClient — missing sessionString");
        return null;
    }

    const MAX_ATTEMPTS = 3;
    const CONNECT_TIMEOUT_MS = 15_000;
    const proxyInfo = account.proxy ? ` via proxy ${account.proxy.host}:${account.proxy.port}` : "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        log.info(
            `[telegram-user-tool] ensureClient — attempt ${attempt}/${MAX_ATTEMPTS}, connecting...${proxyInfo}`
        );

        const client = new TelegramClient(new StringSession(account.sessionString), account.apiId, account.apiHash, {
            connectionRetries: 1,
            autoReconnect: false,
            retryDelay: 1000,
            baseLogger: new PluginBridgeLogger(log),
            deviceModel:    account.device?.deviceModel,
            systemVersion:  account.device?.systemVersion,
            appVersion:     account.device?.appVersion,
            langCode:       account.device?.langCode       ?? "en",
            systemLangCode: account.device?.systemLangCode ?? "en",
            connection: ConnectionTCPObfuscated,
            useWSS: !account.proxy,
            ...(account.proxy && {
                proxy: {
                    socksType: account.proxy.type === "socks5" ? 5 : 4,
                    ip: account.proxy.host,
                    port: account.proxy.port,
                    username: account.proxy.username,
                    password: account.proxy.password,
                    timeout: 10,
                },
            }),
        });

        try {
            const connectTimeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS)
            );
            await Promise.race([client.connect(), connectTimeout]);

            clients.set(key, client);
            const me = await client.getMe();
            log.info(
                `[telegram-user-tool] ensureClient — connected as ${(me as any).firstName ?? ""} ${(me as any).lastName ?? ""} (ID: ${me.id})`
            );
            return client;
        } catch (err: any) {
            await client.disconnect().catch(() => {});
            log.warn(
                `[telegram-user-tool] ensureClient — attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message ?? err}`
            );
            if (attempt === MAX_ATTEMPTS) {
                log.error(`[telegram-user-tool] ensureClient — all ${MAX_ATTEMPTS} attempts failed`);
                return null;
            }
        }
    }

    return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function ok(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

// ─── Plugin ───────────────────────────────────────────────────────────

export default definePluginEntry({
    id: "telegram-user-tool",   // исправлено с "ч"
    name: "Telegram User Tool",
    description:
        "MTProto tool for scheduled agents: read group dialogs, fetch messages, mark as read, reply.",

    register(api) {
        // api.logger захватывается один раз и передаётся в ensureClient —
        // execute() больше не получает ctx с доступом к log/cfg.
        const log = api.logger;

        // ── tg_load_account ───────────────────────────────────────────

        api.registerTool(
            {
                name: "tg_load_account",
                description:
                    "Load Telegram account credentials from " +
                    "~/.openclaw/workspace-<agentId>/tg-account.json. " +
                    "Must be called once at the start of each run before any other telegram_* tools. " +
                    "The file must contain: accountId, apiId, apiHash, sessionString.",
                parameters: Type.Object({
                    agentId: Type.String({
                        description: "Your agentId from the Runtime section of the system prompt",
                    }),
                }),

                async execute(_id, params) {
                    const configPath = resolveConfigPath(params.agentId);
                    log.info(`[telegram-user-tool] tg_load_account — loading from ${configPath}`);

                    try {
                        const raw = fs.readFileSync(configPath, "utf-8");
                        const cfg = JSON.parse(raw);

                        if (!cfg.apiId || !cfg.apiHash || !cfg.sessionString) {
                            return fail("tg-account.json is missing required fields: apiId, apiHash, sessionString");
                        }

                        let proxy: ProxyConfig | undefined;
                        if (cfg.proxy) {
                            const { type, host, port, username, password } = cfg.proxy;
                            if (!host || !port) {
                                return fail("tg-account.json proxy is missing required fields: host, port");
                            }
                            proxy = {
                                type: type === "socks4" ? "socks4" : "socks5",
                                host: String(host),
                                port: Number(port),
                                username: username ? String(username) : undefined,
                                password: password ? String(password) : undefined,
                            };
                        }

                        let device: DeviceConfig | undefined;
                        if (cfg.device && typeof cfg.device === "object") {
                            const d = cfg.device;
                            device = {
                                deviceModel:    d.deviceModel    ? String(d.deviceModel)    : undefined,
                                systemVersion:  d.systemVersion  ? String(d.systemVersion)  : undefined,
                                appVersion:     d.appVersion     ? String(d.appVersion)     : undefined,
                                langCode:       d.langCode       ? String(d.langCode)       : undefined,
                                systemLangCode: d.systemLangCode ? String(d.systemLangCode) : undefined,
                            };
                        }

                        const newConfig: AccountConfig = {
                            accountId: cfg.accountId ?? "default",
                            apiId: Number(cfg.apiId),
                            apiHash: String(cfg.apiHash),
                            sessionString: String(cfg.sessionString),
                            device,
                            proxy,
                        };

                        accountConfig = newConfig;
                        log.info(`[telegram-user-tool] tg_load_account — loaded accountId=${accountConfig.accountId}`);
                        return ok({ ok: true, accountId: accountConfig.accountId });
                    } catch (err: any) {
                        log.error(`[telegram-user-tool] tg_load_account — error: ${err.message ?? err}`);
                        return fail(err);
                    }
                },
            },
            { optional: true },
        );

        // ── tg_auth_send_code ─────────────────────────────────────────

        api.registerTool(
            {
                name: "tg_auth_send_code",
                description:
                    "Step 1 of Telegram auth: connects with empty session and sends a login code " +
                    "to the given phone number. Returns phoneCodeHash needed for tg_auth_sign_in. " +
                    "Use apiId and apiHash from my.telegram.org.",
                parameters: Type.Object({
                    apiId: Type.Number({ description: "Telegram API ID from my.telegram.org" }),
                    apiHash: Type.String({ description: "Telegram API Hash from my.telegram.org" }),
                    phoneNumber: Type.String({ description: "Phone number in international format, e.g. +79001234567" }),
                    proxy: Type.Optional(Type.Object({
                        type: Type.Union([Type.Literal("socks5"), Type.Literal("socks4")]),
                        host: Type.String(),
                        port: Type.Number(),
                        username: Type.Optional(Type.String()),
                        password: Type.Optional(Type.String()),
                    }, { description: "Proxy to use for auth — must match the proxy the session will be used with" })),
                }),

                async execute(_id, params) {
                    const { apiId, apiHash, phoneNumber, proxy } = params;
                    const MAX_RETRIES = 3;
                    const TIMEOUT_MS = 60_000;
                    log.info(`[telegram-user-tool] tg_auth_send_code — phoneNumber=${phoneNumber}, ${MAX_RETRIES} attempts, ${TIMEOUT_MS / 1000}s timeout each (up to ${MAX_RETRIES * TIMEOUT_MS / 1000}s total)`);

                    let lastError: any;
                    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                        const existing = authSessions.get(phoneNumber);
                        if (existing) {
                            await existing.disconnect().catch(() => {});
                            authSessions.delete(phoneNumber);
                        }

                        const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
                            connectionRetries: 1,
                            baseLogger: new PluginBridgeLogger(log),
                            connection: ConnectionTCPObfuscated,
                            useWSS: !proxy,
                            ...(proxy && {
                                proxy: {
                                    socksType: proxy.type === "socks5" ? 5 : 4,
                                    ip: proxy.host,
                                    port: proxy.port,
                                    username: proxy.username,
                                    password: proxy.password,
                                    timeout: 10,
                                },
                            }),
                        });

                        try {
                            log.info(`[telegram-user-tool] tg_auth_send_code — attempt ${attempt}/${MAX_RETRIES}`);
                            await Promise.race([
                                client.connect(),
                                new Promise<never>((_, reject) =>
                                    setTimeout(() => reject(new Error(`connect timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
                                ),
                            ]);
                            const result = await Promise.race([
                                client.invoke(new Api.auth.SendCode({ phoneNumber, apiId, apiHash, settings: new Api.CodeSettings({}) })),
                                new Promise<never>((_, reject) =>
                                    setTimeout(() => reject(new Error(`sendCode timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
                                ),
                            ]) as any;

                            authSessions.set(phoneNumber, client);
                            log.info(`[telegram-user-tool] tg_auth_send_code — success on attempt ${attempt}/${MAX_RETRIES}, type=${result.type?.className}`);
                            return ok({ phoneCodeHash: result.phoneCodeHash, codeType: result.type?.className ?? "unknown" });
                        } catch (err: any) {
                            await client.disconnect().catch(() => {});
                            lastError = err;
                            log.warn(`[telegram-user-tool] tg_auth_send_code — attempt ${attempt}/${MAX_RETRIES} failed: ${err.message ?? err}`);
                            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 2_000));
                        }
                    }

                    log.error(`[telegram-user-tool] tg_auth_send_code — all ${MAX_RETRIES} attempts failed`);
                    return fail(lastError);
                },
            },
            { optional: true },
        );

        // ── tg_auth_sign_in ───────────────────────────────────────────

        api.registerTool(
            {
                name: "tg_auth_sign_in",
                description:
                    "Step 2 of Telegram auth: signs in with the code received on the phone. " +
                    "Returns sessionString on success. " +
                    "If the account has 2FA enabled, provide the password parameter.",
                parameters: Type.Object({
                    phoneNumber: Type.String({ description: "Same phone number used in tg_auth_send_code" }),
                    phoneCodeHash: Type.String({ description: "phoneCodeHash returned by tg_auth_send_code" }),
                    phoneCode: Type.String({ description: "The login code received in Telegram" }),
                    password: Type.Optional(Type.String({ description: "2FA cloud password, if enabled on the account" })),
                }),

                async execute(_id, params) {
                    const { phoneNumber, phoneCodeHash, phoneCode, password } = params;
                    const MAX_RETRIES = 3;
                    const TIMEOUT_MS = 60_000;
                    log.info(`[telegram-user-tool] tg_auth_sign_in — phoneNumber=${phoneNumber}, ${MAX_RETRIES} attempts, ${TIMEOUT_MS / 1000}s timeout each`);

                    const client = authSessions.get(phoneNumber);
                    if (!client) {
                        return fail("No auth session found for this phone number. Call tg_auth_send_code first.");
                    }

                    const cleanup = async () => {
                        authSessions.delete(phoneNumber);
                        await client.disconnect().catch(() => {});
                    };

                    const invokeWithTimeout = <T>(p: Promise<T>) =>
                        Promise.race([p, new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error(`invoke timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
                        )]);

                    // Phase 1: sign in, retry only on timeout
                    let needs2FA = false;
                    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                        try {
                            log.info(`[telegram-user-tool] tg_auth_sign_in — attempt ${attempt}/${MAX_RETRIES}`);
                            await invokeWithTimeout(
                                client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode }))
                            );
                            break;
                        } catch (err: any) {
                            if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
                                needs2FA = true;
                                break;
                            }
                            log.warn(`[telegram-user-tool] tg_auth_sign_in — attempt ${attempt}/${MAX_RETRIES} failed: ${err.message ?? err}`);
                            if (attempt === MAX_RETRIES || !err.message?.includes("timed out")) {
                                await cleanup();
                                return fail(err);
                            }
                        }
                    }

                    // Phase 2: 2FA if needed
                    if (needs2FA) {
                        if (!password) {
                            return fail("2FA password is required. Call tg_auth_sign_in again with the password parameter.");
                        }
                        try {
                            const pwdInfo = await invokeWithTimeout(client.invoke(new Api.account.GetPassword())) as any;
                            const pwdCheck = await computeCheck(pwdInfo, password);
                            await invokeWithTimeout(client.invoke(new Api.auth.CheckPassword({ password: pwdCheck })));
                        } catch (pwdErr: any) {
                            await cleanup();
                            log.error(`[telegram-user-tool] tg_auth_sign_in — 2FA error: ${pwdErr.message ?? pwdErr}`);
                            return fail(pwdErr);
                        }
                    }

                    const sessionString = (client.session as StringSession).save();
                    await cleanup();
                    log.info(`[telegram-user-tool] tg_auth_sign_in — success, sessionString length=${sessionString.length}`);
                    return ok({ sessionString });
                },
            },
            { optional: true },
        );

        // ── telegram_get_dialogs ──────────────────────────────────────

        api.registerTool(
            {
                name: "telegram_get_dialogs",
                description:
                    "Get list of all Telegram group chats that have unread messages, " +
                    "including readInboxMaxId and unreadCount for each group. " +
                    "Call this once at the start of each run.",
                parameters: Type.Object({}),

                async execute(_id, _params) {
                    log.info("[telegram-user-tool] tool:telegram_get_dialogs called");

                    const client = await ensureClient(log);
                    if (!client) return fail("Client not connected");

                    try {
                        const dialogs = await client.getDialogs({ limit: 100 });

                        const groups = dialogs
                            .filter((d: any) => d.isGroup || d.isChannel)
                            .map((d: any) => {
                                const chatId: string = d.id?.toString();

                                // Конструируем InputPeer явно из d.entity.
                                // d.entity — это Channel/Chat/User из ответа getDialogs,
                                // у него всегда есть accessHash пока мы внутри этого вызова.
                                // d.inputEntity на Dialog в GramJS не существует как стабильное
                                // свойство, поэтому не полагаемся на него.
                                // peerCache заполняется для ВСЕХ групп/каналов, а не только
                                // тех, у кого есть непрочитанные — иначе tg_channels_get_batch
                                // не сможет пометить как прочитанные чаты без unread (BUG-002).
                                const entity = d.entity;
                                let inputPeer: Api.TypeInputPeer | undefined;
                                if (entity instanceof Api.Channel && entity.accessHash != null) {
                                    if (entity.min) {
                                        // min-конструктор: accessHash неполный, пригоден только
                                        // для загрузки аватаров. Для ReadHistory/sendMessage
                                        // нельзя использовать — сервер вернёт CHANNEL_INVALID.
                                        // Пропускаем: агент не сможет пометить как прочитанное,
                                        // но лучше пропустить чем падать.
                                        log.warn(
                                            `[telegram-user-tool] get_dialogs — skipping min entity for chatId=${chatId} (${entity.title ?? ""}), full access_hash not available`
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
                                    peerCache.set(chatId, inputPeer);
                                } else if (chatId) {
                                    log.warn(
                                        `[telegram-user-tool] get_dialogs — could not build InputPeer for chatId=${chatId} entity type=${entity?.className ?? "unknown"}`
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

                        log.info(
                            `[telegram-user-tool] tool:telegram_get_dialogs — found ${groups.length} groups with unread messages`
                        );

                        return ok({ groups });
                    } catch (err: any) {
                        log.error(`[telegram-user-tool] tool:telegram_get_dialogs — error: ${err.message ?? err}`);
                        return fail(err);
                    }
                },
            },
            { optional: true }, // было { names: ["telegram_get_dialogs"] } — такой опции больше нет
        );

        // ── telegram_get_messages ─────────────────────────────────────

        api.registerTool(
            {
                name: "telegram_get_messages",
                description:
                    "Get unread messages from a specific Telegram group chat starting after minId " +
                    "(readInboxMaxId). Returns at most `limit` messages (max 100).",
                parameters: Type.Object({
                    chatId: Type.String({
                        description: "Numeric ID of the group chat, obtained from telegram_get_dialogs",
                    }),
                    minId: Type.Number({
                        description:
                            "ID of the last read message (readInboxMaxId from telegram_get_dialogs). " +
                            "Only messages with ID greater than this value are returned.",
                    }),
                    limit: Type.Number({
                        description: "Maximum number of messages to return. Must not exceed 100.",
                    }),
                }),

                async execute(_id, params) {
                    const { chatId, minId, limit } = params;
                    log.info(
                        `[telegram-user-tool] tool:telegram_get_messages called — chatId=${chatId} minId=${minId} limit=${limit}`
                    );

                    const client = await ensureClient(log);
                    if (!client) return fail("Client not connected");

                    const safeLimit = Math.min(limit, 100);

                    try {
                        const peer = BigInt(chatId);

                        const messages = await client.getMessages(peer, {
                            minId,
                            limit: safeLimit,
                        });

                        const result = messages
                            .filter((m: any) => {
                                // Публикации от владельца канала в обсуждении приходят
                                // с sender типа Channel (не User) — это автоматически
                                // пересланные посты канала. Агент их игнорирует.
                                if (m.sender instanceof Api.Channel) {
                                    log.info(
                                        `[telegram-user-tool] get_messages — skipping channel post msgId=${m.id} from channel "${m.sender.title ?? m.senderId}"`
                                    );
                                    return false;
                                }
                                return true;
                            })
                            .map((m: any) => {
                                const entry: Record<string, unknown> = {
                                    id: m.id,
                                    fromId: m.senderId?.toString() ?? "",
                                    fromName: (m.sender as any)?.firstName
                                        ? `${(m.sender as any).firstName ?? ""} ${(m.sender as any).lastName ?? ""}`.trim()
                                        : (m.sender as any)?.title ?? (m.senderId?.toString() ?? ""),
                                    text: m.text ?? m.message ?? "",
                                    date: m.date,
                                };
                                // Добавляем userAccessHash только если sender — полноценный User
                                // (не min-объект): min=true означает неполный access_hash,
                                // непригодный для InputPeerUser.
                                if (
                                    m.sender instanceof Api.User &&
                                    m.sender.accessHash != null &&
                                    !m.sender.min
                                ) {
                                    entry.userAccessHash = m.sender.accessHash.toString();
                                }
                                // Если сообщение является ответом на другое — добавляем replyToMsgId.
                                if (m.replyTo?.replyToMsgId) {
                                    entry.replyToMsgId = m.replyTo.replyToMsgId;
                                }
                                return entry;
                            });

                        const withReply = result.filter((m) => m.replyToMsgId !== undefined).length;
                        log.info(
                            `[telegram-user-tool] tool:telegram_get_messages — chatId=${chatId} returned ${result.length} messages, ${withReply} with replyToMsgId`
                        );

                        return ok({ chatId, messages: result });
                    } catch (err: any) {
                        log.error(`[telegram-user-tool] tool:telegram_get_messages — error: ${err.message ?? err}`);
                        return fail(err);
                    }
                },
            },
            { optional: true },
        );

        // ── telegram_mark_as_read ─────────────────────────────────────

        api.registerTool(
            {
                name: "telegram_mark_as_read",
                description:
                    "Mark messages in a Telegram group chat as read up to and including maxId. " +
                    "Always call this after fetching messages from a chat, regardless of whether you replied or not. " +
                    "This prevents the same messages from appearing as unread on the next run.",
                parameters: Type.Object({
                    chatId: Type.String({
                        description: "Numeric ID of the group chat, obtained from telegram_get_dialogs",
                    }),
                    maxId: Type.Number({
                        description:
                            "ID of the last message to mark as read. " +
                            "Use the highest message ID from the list returned by telegram_get_messages.",
                    }),
                }),

                async execute(_id, params) {
                    const { chatId, maxId } = params;
                    log.info(
                        `[telegram-user-tool] tool:telegram_mark_as_read called — chatId=${chatId} maxId=${maxId}`
                    );

                    const client = await ensureClient(log);
                    if (!client) return fail("Client not connected");

                    try {
                        // Берём InputPeer из кэша, заполненного в get_dialogs.
                        // getEntity(BigInt) работает только пока жив in-memory кэш
                        // GramJS — т.е. ломается при холодном старте процесса.
                        const peer = peerCache.get(chatId);
                        if (!peer) {
                            return fail(
                                `No InputPeer cached for chatId=${chatId}. ` +
                                `Call telegram_get_dialogs first.`
                            );
                        }

                        // messages.ReadHistory — для личных чатов и базовых групп.
                        // channels.ReadHistory — для каналов и супергрупп.
                        // Передача InputPeerChannel в messages.ReadHistory → PEER_ID_INVALID
                        // даже при правильном accessHash.
                        if (peer instanceof Api.InputPeerChannel) {
                            await client.invoke(
                                new Api.channels.ReadHistory({
                                    channel: new Api.InputChannel({
                                        channelId: peer.channelId,
                                        accessHash: peer.accessHash,
                                    }),
                                    maxId,
                                })
                            );
                        } else {
                            await client.invoke(
                                new Api.messages.ReadHistory({ peer, maxId })
                            );
                        }

                        log.info(
                            `[telegram-user-tool] tool:telegram_mark_as_read — marked as read chatId=${chatId} up to maxId=${maxId}`
                        );

                        return ok({ ok: true });
                    } catch (err: any) {
                        log.error(`[telegram-user-tool] tool:telegram_mark_as_read — error: ${err.message ?? err}`);
                        return fail(err);
                    }
                },
            },
            { optional: true },
        );

        // ── telegram_reply_to_message ─────────────────────────────────

        api.registerTool(
            {
                name: "telegram_reply_to_message",
                description:
                    "Send a reply to a specific message in a Telegram group chat. " +
                    "The reply is visually linked to the original message in Telegram.",
                parameters: Type.Object({
                    chatId: Type.String({
                        description: "Numeric ID of the group chat",
                    }),
                    replyToMessageId: Type.Number({
                        description: "ID of the message to reply to",
                    }),
                    text: Type.String({
                        description: "Text of the reply message",
                    }),
                    originalText: Type.Optional(Type.String({
                        description: "Text of the original message being replied to. Used for logging purposes.",
                    })),
                    agentId: Type.Optional(Type.String({
                        description:
                            "agentId from the Runtime section. When provided, the reply is recorded " +
                            "to the per-agent replies DB at ~/.openclaw/workspace-<agentId>/.",
                    })),
                }),

                async execute(_id, params) {
                    const { chatId, replyToMessageId, text, agentId } = params;
                    log.info(
                        `[telegram-user-tool] tool:telegram_reply_to_message called — chatId=${chatId} replyToMessageId=${replyToMessageId} text="${text.slice(0, 50)}..."`
                    );

                    const client = await ensureClient(log);
                    if (!client) return fail("Client not connected");

                    try {
                        const peer = peerCache.get(chatId);
                        if (!peer) {
                            return fail(
                                `No InputPeer cached for chatId=${chatId}. ` +
                                `Call telegram_get_dialogs first.`
                            );
                        }

                        const result = await client.sendMessage(peer as any, {
                            message: text,
                            replyTo: replyToMessageId,
                        });

                        log.info(
                            `[telegram-user-tool] tool:telegram_reply_to_message — sent reply messageId=${result.id} to chatId=${chatId}`
                        );

                        if (agentId) {
                            try {
                                saveReply(agentId, {
                                    chatId,
                                    msgId:      replyToMessageId,
                                    msgText:    params.originalText,
                                    replyMsgId: result.id,
                                    replyText:  text,
                                });
                            } catch (saveErr: any) {
                                log.warn(`[telegram-user-tool] tool:telegram_reply_to_message — saveReply failed: ${saveErr.message ?? saveErr}`);
                            }
                        }

                        return ok({ ok: true, messageId: result.id });
                    } catch (err: any) {
                        log.error(
                            `[telegram-user-tool] tool:telegram_reply_to_message — error: ${err.message ?? err}`
                        );
                        return fail(err);
                    }
                },
            },
            { optional: true },
        );

        // ── telegram_join_discussion_groups ───────────────────────────

        api.registerTool(
            {
                name: "telegram_join_discussion_groups",
                description:
                    "For each t.me/username link: resolves the channel, finds its linked " +
                    "discussion group, and joins it. Skips channels that are private, " +
                    "invalid, have no discussion group, or already joined. " +
                    "Returns a summary with joined/skipped counts and per-channel details.",
                parameters: Type.Object({
                    links: Type.Array(
                        Type.String({ description: "Telegram channel link in t.me/username format" }),
                        { description: "List of channel links to process" }
                    ),
                }),

                async execute(_id, params) {
                    const { links } = params;
                    log.info(
                        `[telegram-user-tool] tool:telegram_join_discussion_groups called — ${links.length} links`
                    );

                    const client = await ensureClient(log);
                    if (!client) return fail("Client not connected");

                    // Рандомная пауза между итерациями: 15–60 секунд.
                    const randomDelay = () => (15 + Math.random() * 45) * 1000;

                    // Вспомогательная функция: ждать указанное количество мс
                    const sleep = (ms: number) =>
                        new Promise<void>(resolve => setTimeout(resolve, ms));

                    // Вспомогательная функция: извлечь X из "FLOOD_WAIT_X"
                    const parseFloodWait = (msg: string): number | null => {
                        const m = msg.match(/FLOOD_WAIT[_ ](\d+)/i);
                        return m ? parseInt(m[1], 10) : null;
                    };

                    const results: Array<{
                        link: string;
                        status: "joined" | "skipped";
                        reason?: string;
                        discussionChatId?: string;
                    }> = [];

                    // Статистика по FLOOD_WAIT за весь запуск
                    const floodWaits: Array<{ link: string; waitSeconds: number }> = [];

                    for (const link of links) {
                        // Извлекаем username из ссылки вида t.me/username или просто username
                        const username = link
                            .replace(/^https?:\/\//, "")
                            .replace(/^t\.me\//, "")
                            .replace(/\/$/, "")
                            .trim();

                        if (!username || username.startsWith("+")) {
                            // Приватные invite-ссылки (t.me/+hash) не поддерживаются
                            results.push({ link, status: "skipped", reason: "private invite link not supported" });
                            log.info(`[telegram-user-tool] join — skipped ${link}: private invite link`);
                            continue;
                        }

                        try {
                            // Шаг 1: резолвим username → получаем Channel с access_hash
                            const resolved = await client.invoke(
                                new Api.contacts.ResolveUsername({ username })
                            );

                            const channel = resolved.chats?.find(
                                (c: any) => c instanceof Api.Channel
                            ) as Api.Channel | undefined;

                            if (!channel || channel.min) {
                                results.push({ link, status: "skipped", reason: "channel not found or min entity" });
                                log.info(`[telegram-user-tool] join — skipped ${link}: channel not found`);
                                continue;
                            }

                            const inputChannel = new Api.InputChannel({
                                channelId: channel.id,
                                accessHash: channel.accessHash!,
                            });

                            // Шаг 2: получаем полную информацию о канале → linkedChatId
                            const fullChannel = await client.invoke(
                                new Api.channels.GetFullChannel({ channel: inputChannel })
                            );

                            const linkedChatId = (fullChannel.fullChat as any)?.linkedChatId;

                            if (!linkedChatId || linkedChatId.eq?.(0) || linkedChatId === 0) {
                                results.push({ link, status: "skipped", reason: "no linked discussion group" });
                                log.info(`[telegram-user-tool] join — skipped ${link}: no discussion group`);
                                continue;
                            }

                            // linkedChatId — это channel_id супергруппы обсуждения.
                            // Ищем её access_hash в chats из того же ответа.
                            const discussionChat = fullChannel.chats?.find(
                                (c: any) => c.id?.equals?.(linkedChatId) || c.id === linkedChatId
                            ) as Api.Channel | undefined;

                            if (!discussionChat || !(discussionChat instanceof Api.Channel) || discussionChat.min) {
                                results.push({ link, status: "skipped", reason: "discussion group entity unavailable" });
                                log.info(`[telegram-user-tool] join — skipped ${link}: discussion group entity not in response`);
                                continue;
                            }

                            // Шаг 3: вступаем в discussion group.
                            // При FLOOD_WAIT: ждём указанное время и делаем одну повторную попытку.
                            // Если и после ожидания снова FLOOD_WAIT — пропускаем канал.
                            const discussionInput = new Api.InputChannel({
                                channelId: discussionChat.id,
                                accessHash: discussionChat.accessHash!,
                            });

                            const joinWithRetry = async () => {
                                try {
                                    await client.invoke(
                                        new Api.channels.JoinChannel({ channel: discussionInput })
                                    );
                                } catch (err: any) {
                                    const waitSec = parseFloodWait(err.message ?? "");
                                    if (waitSec !== null) {
                                        floodWaits.push({ link, waitSeconds: waitSec });
                                        log.warn(
                                            `[telegram-user-tool] join — FLOOD_WAIT ${waitSec}s for ${link}, waiting...`
                                        );
                                        await sleep(waitSec * 1000);
                                        // Одна повторная попытка после ожидания
                                        await client.invoke(
                                            new Api.channels.JoinChannel({ channel: discussionInput })
                                        );
                                    } else {
                                        throw err;
                                    }
                                }
                            };

                            await joinWithRetry();

                            const discussionChatId = discussionChat.id.toString();
                            results.push({ link, status: "joined", discussionChatId });
                            log.info(
                                `[telegram-user-tool] join — joined discussion group ${discussionChatId} for channel @${username}`
                            );

                        } catch (err: any) {
                            const msg: string = err.message ?? String(err);

                            // Стандартные коды которые означают "пропустить"
                            const skipCodes = [
                                "USERNAME_NOT_OCCUPIED",
                                "USERNAME_INVALID",
                                "CHANNEL_PRIVATE",
                                "USER_ALREADY_PARTICIPANT",
                                "INVITE_REQUEST_SENT", // запрос на вступление отправлен (закрытая группа)
                            ];

                            const skipCode = skipCodes.find(c => msg.includes(c));
                            if (skipCode) {
                                results.push({ link, status: "skipped", reason: skipCode });
                                log.info(`[telegram-user-tool] join — skipped ${link}: ${skipCode}`);
                            } else {
                                // Неожиданная ошибка — логируем, но всё равно пропускаем
                                results.push({ link, status: "skipped", reason: msg });
                                log.error(`[telegram-user-tool] join — unexpected error for ${link}: ${msg}`);
                            }
                        }

                        // Базовая задержка между итерациями.
                        // Не ставим после последнего элемента — незачем.
                        if (link !== links[links.length - 1]) {
                            await sleep(randomDelay());
                        }
                    }

                    const joined = results.filter(r => r.status === "joined").length;
                    const skipped = results.filter(r => r.status === "skipped").length;

                    log.info(
                        `[telegram-user-tool] join — done: joined=${joined} skipped=${skipped} floodWaits=${floodWaits.length}`
                    );

                    return ok({
                        joined,
                        skipped,
                        total: links.length,
                        // Встречался ли FLOOD_WAIT хотя бы раз
                        hadFloodWait: floodWaits.length > 0,
                        // Детали по каждому FLOOD_WAIT: какой канал и сколько секунд ждали
                        floodWaits,
                        results,
                    });
                },
            },
            { optional: true },
        );

        // ── telegram_send_dm ──────────────────────────────────────────

        api.registerTool(
            {
                name: "telegram_send_dm",
                description:
                    "Send a direct message to a Telegram user. " +
                    "PREFERRED: provide chatId + msgId (the group and message where you saw the user) — " +
                    "uses InputPeerUserFromMessage which works even for min-entities and avoids PEER_ID_INVALID. " +
                    "FALLBACK: provide accessHash only if the user is NOT a min-entity (userAccessHash field present in telegram_get_messages). " +
                    "Handles FLOOD_WAIT with one retry, USER_PRIVACY_RESTRICTED, USER_DEACTIVATED, PEER_ID_INVALID. " +
                    "When historyRecord is provided and the send succeeds, atomically writes the record to " +
                    "dm_history and returns { ok: true, messageId, historySaved: true }. " +
                    "On any error, dm_history is never written — no separate dm_history_insert call needed.",
                parameters: Type.Object({
                    userId: Type.String({
                        description: "Numeric Telegram user ID (string)",
                    }),
                    chatId: Type.Optional(Type.String({
                        description:
                            "PREFERRED. Numeric ID of the group chat where the user sent a message. " +
                            "Used together with msgId to construct InputPeerUserFromMessage — " +
                            "the correct way to address min-entity users from groups.",
                    })),
                    msgId: Type.Optional(Type.Number({
                        description:
                            "PREFERRED. ID of the specific message the user sent in the group (from telegram_get_messages). " +
                            "Used together with chatId for InputPeerUserFromMessage.",
                    })),
                    accessHash: Type.Optional(Type.String({
                        description:
                            "FALLBACK only. User access hash from telegram_get_messages userAccessHash field. " +
                            "Only works when userAccessHash is present (non-min entity). " +
                            "Prefer chatId+msgId instead.",
                    })),
                    text: Type.String({
                        description: "Text of the DM to send",
                    }),
                    agentId: Type.Optional(Type.String({
                        description:
                            "agentId from the Runtime section. Required when historyRecord is provided.",
                    })),
                    historyRecord: Type.Optional(Type.Object({
                        userAccessHash: Type.String(),
                        username: Type.Optional(Type.String()),
                        triggerText: Type.String({ description: "The group message that triggered this DM" }),
                        dmText: Type.String({ description: "The text of the DM that was sent" }),
                        sentAt: Type.Number({ description: "Unix timestamp when the DM was sent" }),
                        lastAgentMsgAt: Type.Number({ description: "Unix timestamp of the last agent message" }),
                        replyCount: Type.Optional(Type.Number()),
                        status: Type.Optional(Type.String()),
                    }, {
                        description:
                            "When present, the tool writes this record to dm_history on success. " +
                            "Eliminates the separate dm_history_insert call and the race condition where " +
                            "the LLM could insert history before the send result is confirmed.",
                    })),
                }),

                async execute(_id, params) {
                    const { userId, chatId, msgId, accessHash, text, agentId, historyRecord } = params;
                    log.info(
                        `[telegram-user-tool] tool:telegram_send_dm called — userId=${userId} text="${text.slice(0, 50)}..."`
                    );

                    const client = await ensureClient(log);
                    if (!client) return fail("Client not connected");

                    let peer: Api.TypeInputPeer;
                    if (chatId && msgId != null) {
                        const groupPeer = peerCache.get(chatId);
                        if (!groupPeer) {
                            return fail(
                                `No InputPeer cached for chatId=${chatId}. Call telegram_get_dialogs first.`
                            );
                        }
                        peer = new Api.InputPeerUserFromMessage({
                            peer: groupPeer,
                            msgId,
                            userId: BigInt(userId),
                        });
                        log.info(`[telegram-user-tool] tool:telegram_send_dm — using InputPeerUserFromMessage chatId=${chatId} msgId=${msgId}`);
                    } else if (accessHash) {
                        peer = new Api.InputPeerUser({
                            userId: BigInt(userId),
                            accessHash: BigInt(accessHash),
                        });
                        log.info(`[telegram-user-tool] tool:telegram_send_dm — using InputPeerUser (accessHash fallback)`);
                    } else {
                        return fail("Either (chatId + msgId) or accessHash must be provided.");
                    }

                    // Вспомогательная: извлечь кол-во секунд из "FLOOD_WAIT_X"
                    const parseFloodWait = (msg: string): number | null => {
                        const m = msg.match(/FLOOD_WAIT[_ ](\d+)/i);
                        return m ? parseInt(m[1], 10) : null;
                    };

                    const sleep = (ms: number) =>
                        new Promise<void>(resolve => setTimeout(resolve, ms));

                    const trySend = async () => {
                        const result = await client.sendMessage(peer as any, { message: text });
                        return result;
                    };

                    // Записывает historyRecord в dm_history, только если запись была передана.
                    // Вызывается строго ПОСЛЕ получения подтверждения от Telegram.
                    // Ошибка записи не откатывает отправку — DM уже ушёл, поэтому логируем
                    // предупреждение, но не возвращаем ошибку вызывающей стороне.
                    const saveHistoryIfRequested = (messageId: number): boolean => {
                        if (!historyRecord || !agentId) return false;
                        try {
                            const Database = require("better-sqlite3");
                            const path = require("path");
                            const os = require("os");
                            const dbPath = path.join(os.homedir(), ".openclaw", `workspace-${agentId}`, "tg-channels.db");
                            const db = new Database(dbPath);
                            try {
                                db.exec(`
                                    CREATE TABLE IF NOT EXISTS dm_history (
                                        id              INTEGER PRIMARY KEY AUTOINCREMENT,
                                        userId          TEXT NOT NULL,
                                        userAccessHash  TEXT NOT NULL,
                                        username        TEXT,
                                        triggerText     TEXT NOT NULL,
                                        dmText          TEXT NOT NULL,
                                        sentAt          INTEGER NOT NULL,
                                        lastAgentMsgAt  INTEGER NOT NULL,
                                        replyCount      INTEGER DEFAULT 0,
                                        status          TEXT DEFAULT 'sent'
                                    );
                                    CREATE INDEX IF NOT EXISTS idx_dm_history_user_sent
                                        ON dm_history (userId, sentAt DESC);
                                `);
                                db.prepare(`
                                    INSERT INTO dm_history
                                        (userId, userAccessHash, username, triggerText, dmText, sentAt, lastAgentMsgAt, replyCount, status)
                                    VALUES
                                        (@userId, @userAccessHash, @username, @triggerText, @dmText, @sentAt, @lastAgentMsgAt, @replyCount, @status)
                                `).run({
                                    userId,
                                    userAccessHash: historyRecord.userAccessHash,
                                    username: historyRecord.username ?? null,
                                    triggerText: historyRecord.triggerText,
                                    dmText: historyRecord.dmText,
                                    sentAt: historyRecord.sentAt,
                                    lastAgentMsgAt: historyRecord.lastAgentMsgAt,
                                    replyCount: historyRecord.replyCount ?? 0,
                                    status: historyRecord.status ?? "sent",
                                });
                                log.info(
                                    `[telegram-user-tool] tool:telegram_send_dm — dm_history saved atomically for userId=${userId} messageId=${messageId}`
                                );
                                return true;
                            } finally {
                                db.close();
                            }
                        } catch (dbErr: any) {
                            log.warn(
                                `[telegram-user-tool] tool:telegram_send_dm — dm_history save failed (DM was sent): ${dbErr.message ?? dbErr}`
                            );
                            return false;
                        }
                    };

                    try {
                        try {
                            const result = await trySend();
                            log.info(`[telegram-user-tool] tool:telegram_send_dm — sent messageId=${result.id} to userId=${userId}`);
                            const historySaved = saveHistoryIfRequested(result.id);
                            return ok({ ok: true, messageId: result.id, ...(historyRecord ? { historySaved } : {}) });
                        } catch (err: any) {
                            const msg: string = err.message ?? String(err);

                            if (msg.includes("USER_PRIVACY_RESTRICTED")) {
                                log.warn(`[telegram-user-tool] tool:telegram_send_dm — userId=${userId} privacy_blocked`);
                                return ok({ error: "privacy_blocked" });
                            }
                            if (msg.includes("USER_DEACTIVATED") || msg.includes("USER_DEACTIVATED_BAN")) {
                                log.warn(`[telegram-user-tool] tool:telegram_send_dm — userId=${userId} deactivated`);
                                return ok({ error: "deactivated" });
                            }
                            if (msg.includes("PEER_ID_INVALID")) {
                                log.warn(`[telegram-user-tool] tool:telegram_send_dm — userId=${userId} peer_id_invalid`);
                                return ok({ error: "peer_id_invalid" });
                            }
                            // PEER_FLOOD — временный бан на рассылку. Не retry, сразу стоп.
                            // parseFloodWait не совпадает с этим кодом (нет числа), поэтому
                            // без явной проверки он проваливался в throw → fail(), и скилл
                            // не распознавал ошибку, записывая кандидата как sent.
                            if (msg.includes("PEER_FLOOD")) {
                                log.warn(`[telegram-user-tool] tool:telegram_send_dm — userId=${userId} peer_flood`);
                                return ok({ error: "peer_flood" });
                            }

                            const waitSec = parseFloodWait(msg);
                            if (waitSec !== null) {
                                log.warn(
                                    `[telegram-user-tool] tool:telegram_send_dm — FLOOD_WAIT ${waitSec}s for userId=${userId}, waiting...`
                                );
                                await sleep(waitSec * 1000);
                                // Одна повторная попытка
                                try {
                                    const result = await trySend();
                                    log.info(`[telegram-user-tool] tool:telegram_send_dm — retry sent messageId=${result.id} to userId=${userId}`);
                                    const historySaved = saveHistoryIfRequested(result.id);
                                    return ok({ ok: true, messageId: result.id, ...(historyRecord ? { historySaved } : {}) });
                                } catch (retryErr: any) {
                                    const retryMsg: string = retryErr.message ?? String(retryErr);
                                    if (parseFloodWait(retryMsg) !== null) {
                                        log.warn(`[telegram-user-tool] tool:telegram_send_dm — repeated FLOOD_WAIT for userId=${userId}`);
                                        return ok({ error: "flood_wait" });
                                    }
                                    throw retryErr;
                                }
                            }

                            throw err;
                        }
                    } catch (err: any) {
                        log.error(`[telegram-user-tool] tool:telegram_send_dm — error: ${err.message ?? err}`);
                        return fail(err);
                    }
                },
            },
            { optional: true },
        );

        // ── telegram_get_dm_dialogs ──────────────────────────────────

        api.registerTool(
            {
                name: "telegram_get_dm_dialogs",
                description:
                    "Get list of personal (1-on-1) Telegram chats that have unread messages. " +
                    "Filters out bots and service notifications (userId 777000). " +
                    "Populates peerCache with InputPeerUser for each returned user. " +
                    "Call this once at the start of each dm-replies run.",
                parameters: Type.Object({}),

                async execute(_id, _params) {
                    log.info("[telegram-user-tool] tool:telegram_get_dm_dialogs called");

                    const client = await ensureClient(log);
                    if (!client) return fail("Client not connected");

                    try {
                        const dialogs = await client.getDialogs({ limit: 100 });

                        const dms = dialogs
                            .filter((d: any) => d.isUser === true)
                            .map((d: any) => {
                                const entity = d.entity;

                                // Skip non-User entities (safety check)
                                if (!(entity instanceof Api.User)) return null;

                                // Skip bots
                                if (entity.bot) {
                                    log.info(
                                        `[telegram-user-tool] get_dm_dialogs — skipping bot userId=${entity.id}`
                                    );
                                    return null;
                                }

                                // Skip service notifications (userId 777000)
                                const userIdStr = entity.id?.toString() ?? "";
                                if (userIdStr === "777000") {
                                    log.info(
                                        `[telegram-user-tool] get_dm_dialogs — skipping service notifications (777000)`
                                    );
                                    return null;
                                }

                                // Skip min entities — accessHash is incomplete
                                if (entity.min) {
                                    log.warn(
                                        `[telegram-user-tool] get_dm_dialogs — skipping min entity for userId=${userIdStr}`
                                    );
                                    return null;
                                }

                                const unreadCount = d.dialog?.unreadCount ?? 0;
                                if (unreadCount === 0) return null;

                                const accessHash = entity.accessHash;
                                if (accessHash == null) {
                                    log.warn(
                                        `[telegram-user-tool] get_dm_dialogs — skipping userId=${userIdStr}, no accessHash`
                                    );
                                    return null;
                                }

                                // Populate peerCache with InputPeerUser
                                const inputPeer = new Api.InputPeerUser({
                                    userId: entity.id,
                                    accessHash,
                                });
                                peerCache.set(userIdStr, inputPeer);

                                return {
                                    userId: userIdStr,
                                    accessHash: accessHash.toString(),
                                    userName: entity.username ?? null,
                                    firstName: entity.firstName ?? null,
                                    unreadCount,
                                    readInboxMaxId: d.dialog?.readInboxMaxId ?? 0,
                                };
                            })
                            .filter((item): item is NonNullable<typeof item> => item !== null);

                        log.info(
                            `[telegram-user-tool] tool:telegram_get_dm_dialogs — found ${dms.length} DM chats with unread messages`
                        );

                        return ok({ dms });
                    } catch (err: any) {
                        log.error(`[telegram-user-tool] tool:telegram_get_dm_dialogs — error: ${err.message ?? err}`);
                        return fail(err);
                    }
                },
            },
            { optional: true },
        );

        registerChannelDbTools(api, ensureClient);
        registerDmThreadsTools(api);
        registerJoinQueueTools(api);
    },
});