// index.ts — OpenClaw-плагин Telegram User Tool.
//
// Тонкая обёртка над src/core/: регистрирует инструменты, описывает их параметры
// через TypeBox и оборачивает результат в формат OpenClaw { content: [...] }.
// Вся логика живёт в src/core/ (telegram + db) — здесь её копии нет (R-B2).
// Тот же src/core/ нсclaапрямую использует диспетчер standalone-задач.
// Файл лежит в корне (не в src/): OpenClaw грузит плагин по extensions/<name>/index.ts.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

import type { Logger } from "./src/core/logger";
import { TelegramService } from "./src/core/telegram/service";
import type { ProxyConfig } from "./src/core/config";
import { FUNNEL_ADMIN_AGENT_ID, FUNNEL_PRIVATE_CHANNEL_ID, REPORT_AGENT_ID, listAgentIds, reportsDir } from "./src/core/config";
import { runDiscovery, renderReport } from "./src/core/discovery/run";
import { runSimilarDiscovery, renderSimilarReport } from "./src/core/discovery/similar";
import { runChannelAnalysis, renderStats } from "./src/core/channel-analysis/run";
import { runChannelContextForAgent, renderChannelContextStats } from "./src/core/channel-context/run";
import { withLlmLogging } from "./src/core/db/llm-log";
import { runChannelMetrics } from "./src/core/channel-metrics/run";
import { cacheChannelIdentities } from "./src/core/channel-sync";
import { createLlmClient } from "./src/llm/client";
import { saveReply } from "./src/core/db/replies";
import { upsertPrivateInviteLink, markPostUpdated, listPendingPostUpdates, listPrivateInviteLinks } from "./src/core/db/private-invites";
import { saveDmHistory, type DmHistoryRecord } from "./src/core/db/dm-history";
import {
    initChannels,
    syncChannels,
    getChannelsBatch,
    markChannelProcessed,
    insertDmCandidate,
    getPendingDmCandidates,
    updateDmCandidateStatus,
    expireOldDmCandidates,
    classifyMessages,
    createGroupThread,
    updateGroupThread,
    expireGroupThreads,
    type ClassifyInputMessage,
} from "./src/core/db/channels";
import {
    createDmThread,
    getDmThreadsByUsers,
    updateDmThreadMsgs,
    countDmThreadsToday,
    dmThreadExists,
    deleteDmThread,
    type DmThreadMessage,
} from "./src/core/db/dm-threads";
import {
    addJoinQueue,
    getJoinQueueBatch,
    updateJoinQueue,
    joinQueueStats,
} from "./src/core/db/join-queue";
import {
    createOrUpdateTask,
    triggerTaskNow,
    removeTask,
    getSchedule,
    triggerActivityUpdate,
} from "./src/core/scheduler-control";
import type { TaskType } from "./src/core/db/tasks";
import { buildDailySummary, currentDayWindow } from "./src/core/runs-summary";
import { collectFunnel } from "./src/core/funnel-collect";
import { renderFunnel, buildFunnelCsv, funnelCsvPath } from "./src/core/funnel-report";
import { getAllChannelsWithAvgViews } from "./src/core/db/channels";
import { runChannelCleanup, type ChannelCleanupParams } from "./src/skills/channel-cleanup";
import { runAutoregistration, retryManualCode, renderReport as renderAutoregistrationReport } from "./src/core/tg-agent-autoregistration/run";
import { reauthFromTdata } from "./src/core/tg-agent-reauth-from-tdata/run";

// ─── OpenClaw result helpers ──────────────────────────────────────────

function ok(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

// ─── Shared agentId parameter schema ──────────────────────────────────

const agentIdParam = Type.String({
    description: "Your agentId from the Runtime section of the system prompt",
});

// ─── Plugin ───────────────────────────────────────────────────────────

export default definePluginEntry({
    id: "telegram-user-tool",
    name: "Telegram User Tool",
    description:
        "MTProto tool for scheduled agents: read group dialogs, fetch messages, mark as read, reply.",

    register(api) {
        // api.logger удовлетворяет интерфейсу Logger ядра; оборачиваем явно,
        // чтобы ядро не зависело от типов OpenClaw.
        const log: Logger = {
            info: (m) => api.logger.info(m),
            warn: (m) => api.logger.warn(m),
            error: (m) => api.logger.error(m),
        };

        // Один TelegramService на весь процесс плагина — держит clients,
        // peerCache и accountConfig (прежние module-level singletons).
        const tg = new TelegramService(log);

        // Токен TGStat для channel-discovery скоупится на плагин: берём из его
        // конфига (plugins.entries.telegram-user-tool.config.tgstatToken), а не из
        // глобального env. Fallback на TGSTAT_TOKEN env — для совместимости.
        const tgstatToken: string =
            (api.pluginConfig as any)?.tgstatToken ?? process.env.TGSTAT_TOKEN ?? "";

        const reg = (tool: any) => api.registerTool(tool, { optional: true });

        /** Унифицированная обёртка: вызов ядра → ok(data); исключение → fail. */
        const run = async (name: string, fn: () => Promise<unknown> | unknown) => {
            try {
                return ok(await fn());
            } catch (err: any) {
                log.error(`[telegram-user-tool] ${name} — error: ${err.message ?? err}`);
                return fail(err);
            }
        };

        // ── tg_load_account ───────────────────────────────────────────

        reg({
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
            execute: (_id: string, params: { agentId: string }) =>
                run("tg_load_account", () => tg.loadAccount(params.agentId)),
        });

        // ── tg_auth_send_code ─────────────────────────────────────────

        reg({
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
            execute: (
                _id: string,
                params: { apiId: number; apiHash: string; phoneNumber: string; proxy?: ProxyConfig },
            ) => run("tg_auth_send_code", () => tg.authSendCode(params)),
        });

        // ── tg_auth_sign_in ───────────────────────────────────────────

        reg({
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
            async execute(
                _id: string,
                params: { phoneNumber: string; phoneCodeHash: string; phoneCode: string; password?: string },
            ) {
                try {
                    const res = await tg.authSignIn(params);
                    // Ветка «нужен 2FA-пароль» возвращается как { error } — тем же
                    // форматом, что и прочие ошибки (исходное поведение).
                    if ("needsPassword" in res) return ok({ error: res.error });
                    return ok(res);
                } catch (err: any) {
                    log.error(`[telegram-user-tool] tg_auth_sign_in — error: ${err.message ?? err}`);
                    return fail(err);
                }
            },
        });

        // ── telegram_get_dialogs ──────────────────────────────────────

        reg({
            name: "telegram_get_dialogs",
            description:
                "Get list of all Telegram group chats that have unread messages, " +
                "including readInboxMaxId and unreadCount for each group. " +
                "Call this once at the start of each run.",
            parameters: Type.Object({}),
            execute: () => run("telegram_get_dialogs", () => tg.getDialogs()),
        });

        // ── telegram_get_messages ─────────────────────────────────────

        reg({
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
            execute: (_id: string, params: { chatId: string; minId: number; limit: number }) =>
                run("telegram_get_messages", () => tg.getMessages(params.chatId, params.minId, params.limit)),
        });

        // ── telegram_mark_as_read ─────────────────────────────────────

        reg({
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
            execute: (_id: string, params: { chatId: string; maxId: number }) =>
                run("telegram_mark_as_read", () => tg.markAsRead(params.chatId, params.maxId)),
        });

        // ── telegram_reply_to_message ─────────────────────────────────

        reg({
            name: "telegram_reply_to_message",
            description:
                "Send a reply to a specific message in a Telegram group chat. " +
                "The reply is visually linked to the original message in Telegram.",
            parameters: Type.Object({
                chatId: Type.String({ description: "Numeric ID of the group chat" }),
                replyToMessageId: Type.Number({ description: "ID of the message to reply to" }),
                text: Type.String({ description: "Text of the reply message" }),
                originalText: Type.Optional(Type.String({
                    description: "Text of the original message being replied to. Used for logging purposes.",
                })),
                agentId: Type.Optional(Type.String({
                    description:
                        "agentId from the Runtime section. When provided, the reply is recorded " +
                        "to the per-agent replies DB at ~/.openclaw/workspace-<agentId>/.",
                })),
            }),
            async execute(
                _id: string,
                params: { chatId: string; replyToMessageId: number; text: string; originalText?: string; agentId?: string },
            ) {
                const { chatId, replyToMessageId, text, originalText, agentId } = params;
                try {
                    const res = await tg.replyToMessage(chatId, replyToMessageId, text);
                    if (agentId) {
                        try {
                            saveReply(agentId, {
                                chatId,
                                msgId: replyToMessageId,
                                msgText: originalText,
                                replyMsgId: res.messageId,
                                replyText: text,
                            });
                        } catch (saveErr: any) {
                            log.warn(`[telegram-user-tool] tool:telegram_reply_to_message — saveReply failed: ${saveErr.message ?? saveErr}`);
                        }
                    }
                    return ok({ ok: true, messageId: res.messageId });
                } catch (err: any) {
                    log.error(`[telegram-user-tool] tool:telegram_reply_to_message — error: ${err.message ?? err}`);
                    return fail(err);
                }
            },
        });

        // ── telegram_join_discussion_groups ───────────────────────────

        reg({
            name: "telegram_join_discussion_groups",
            description:
                "For each t.me/username link: resolves the channel, finds its linked " +
                "discussion group, and joins it. Skips channels that are private, " +
                "invalid, have no discussion group, or already joined. " +
                "Returns a summary with joined/skipped counts and per-channel details.",
            parameters: Type.Object({
                links: Type.Array(
                    Type.String({ description: "Telegram channel link in t.me/username format" }),
                    { description: "List of channel links to process" },
                ),
            }),
            execute: (_id: string, params: { links: string[] }) =>
                run("telegram_join_discussion_groups", () => tg.joinDiscussionGroups(params.links)),
        });

        // ── telegram_send_dm ──────────────────────────────────────────

        reg({
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
                userId: Type.String({ description: "Numeric Telegram user ID (string)" }),
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
                text: Type.String({ description: "Text of the DM to send" }),
                agentId: Type.Optional(Type.String({
                    description: "agentId from the Runtime section. Required when historyRecord is provided.",
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
            async execute(
                _id: string,
                params: {
                    userId: string;
                    chatId?: string;
                    msgId?: number;
                    accessHash?: string;
                    text: string;
                    agentId?: string;
                    historyRecord?: DmHistoryRecord;
                },
            ) {
                const { userId, chatId, msgId, accessHash, text, agentId, historyRecord } = params;
                try {
                    const res = await tg.sendDm({ userId, chatId, msgId, accessHash, text });
                    if ("messageId" in res) {
                        if (historyRecord) {
                            const historySaved = agentId
                                ? saveDmHistory(agentId, userId, historyRecord, res.messageId, log)
                                : false;
                            return ok({ ok: true, messageId: res.messageId, historySaved });
                        }
                        return ok({ ok: true, messageId: res.messageId });
                    }
                    // Штатная ошибка Telegram (privacy_blocked / deactivated / …):
                    // dm_history не пишется.
                    return ok(res);
                } catch (err: any) {
                    log.error(`[telegram-user-tool] tool:telegram_send_dm — error: ${err.message ?? err}`);
                    return fail(err);
                }
            },
        });

        // ── telegram_get_dm_dialogs ───────────────────────────────────

        reg({
            name: "telegram_get_dm_dialogs",
            description:
                "Get list of personal (1-on-1) Telegram chats that have unread messages. " +
                "Filters out bots and service notifications (userId 777000). " +
                "Populates peerCache with InputPeerUser for each returned user. " +
                "Call this once at the start of each dm-replies run.",
            parameters: Type.Object({}),
            execute: () => run("telegram_get_dm_dialogs", () => tg.getDmDialogs()),
        });

        // ─── Channels DB ──────────────────────────────────────────────

        reg({
            name: "tg_channels_init",
            description:
                "Create the channels SQLite table and index for this agent if they do not exist. " +
                "No Telegram connection required. Safe to call on every run — does nothing if table already exists. " +
                "Always call this first, then call tg_channels_sync to populate or update the data.",
            parameters: Type.Object({ agentId: agentIdParam }),
            execute: (_id: string, params: { agentId: string }) =>
                run("tg_channels_init", () => initChannels(params.agentId, log)),
        });

        reg({
            name: "tg_channels_sync",
            description:
                "Sync the channels database with the current Telegram dialogs. " +
                "On first run (empty table) populates all channels. " +
                "On subsequent runs: adds new channels, removes channels the agent has left, updates renamed titles. " +
                "Does NOT touch lastProcessedAt for existing channels. " +
                "Call on every run after tg_channels_init.",
            parameters: Type.Object({ agentId: agentIdParam }),
            execute: (_id: string, params: { agentId: string }) =>
                run("tg_channels_sync", async () => {
                    const channels = await tg.listGroupChannels();
                    const result = syncChannels(params.agentId, channels, log);
                    // Кэшировать идентичность привязанного канала для новых/непрорезолвленных
                    // чатов (channel-content-analysis) — та же логика, что на тике монитора.
                    const cache = await cacheChannelIdentities(params.agentId, tg, log);
                    return { ...result, identitiesCached: cache.resolved };
                }),
        });

        reg({
            name: "tg_channels_get_batch",
            description:
                "Get the next batch of channels due for processing. " +
                "Returns channels where lastProcessedAt is 0 (never processed) or older than periodSeconds ago, sorted oldest-first. " +
                "If the result is empty, all channels are up to date — stop the run.",
            parameters: Type.Object({
                agentId: agentIdParam,
                limit: Type.Optional(Type.Number({
                    description: "Maximum number of channels to return per batch. Default: 20.",
                })),
                periodSeconds: Type.Optional(Type.Number({
                    description: "Minimum seconds since last processing. Default: 259200 (72 hours).",
                })),
            }),
            execute: (_id: string, params: { agentId: string; limit?: number; periodSeconds?: number }) =>
                run("tg_channels_get_batch", () => getChannelsBatch(params.agentId, log, params.limit, params.periodSeconds)),
        });

        reg({
            name: "tg_channels_mark_processed",
            description:
                "Update lastProcessedAt timestamp for a channel after it has been processed. " +
                "Call immediately after finishing each channel — not at the end of the batch — " +
                "so progress is saved even if the run times out.",
            parameters: Type.Object({
                agentId: agentIdParam,
                chatId: Type.String({ description: "The chatId of the processed channel." }),
            }),
            execute: (_id: string, params: { agentId: string; chatId: string }) =>
                run("tg_channels_mark_processed", () => markChannelProcessed(params.agentId, params.chatId, log)),
        });

        reg({
            name: "dm_candidates_insert",
            description:
                "Insert a DM candidate into the dm_candidates table. " +
                "Uses INSERT OR IGNORE — duplicate (sourceChatId, msgId) pairs are silently skipped. " +
                "Creates the table if it does not exist.",
            parameters: Type.Object({
                agentId: agentIdParam,
                record: Type.Object({
                    userId: Type.String({ description: "Telegram user ID of the message author" }),
                    userAccessHash: Type.Optional(Type.String({ description: "Access hash for the user" })),
                    sourceChatId: Type.String({ description: "Chat ID where the message was found" }),
                    msgId: Type.Number({ description: "Message ID within the source chat" }),
                    msgText: Type.String({ description: "Text content of the message" }),
                    score: Type.Number({ description: "Relevance score 0.0–1.0" }),
                    scoreReason: Type.Optional(Type.String({ description: "Human-readable reason for the score" })),
                }),
            }),
            execute: (_id: string, params: { agentId: string; record: any }) =>
                run("dm_candidates_insert", () => insertDmCandidate(params.agentId, params.record, log)),
        });

        reg({
            name: "dm_candidates_get_pending",
            description:
                "Return pending DM candidates sorted by score descending, up to limit records. " +
                "Only returns rows with status='pending'.",
            parameters: Type.Object({
                agentId: agentIdParam,
                limit: Type.Number({ description: "Maximum number of candidates to return" }),
            }),
            execute: (_id: string, params: { agentId: string; limit: number }) =>
                run("dm_candidates_get_pending", () => getPendingDmCandidates(params.agentId, params.limit, log)),
        });

        reg({
            name: "dm_candidates_update_status",
            description:
                "Update the status of a single dm_candidates record by id. " +
                "Valid statuses: pending, sent, skipped, expired.",
            parameters: Type.Object({
                agentId: agentIdParam,
                id: Type.Number({ description: "Row id of the dm_candidates record" }),
                status: Type.String({ description: "New status value" }),
            }),
            execute: (_id: string, params: { agentId: string; id: number; status: string }) =>
                run("dm_candidates_update_status", () => updateDmCandidateStatus(params.agentId, params.id, params.status, log)),
        });

        reg({
            name: "dm_candidates_expire_old",
            description:
                "Expire pending dm_candidates records older than olderThanDays days. " +
                "Only records with status='pending' and createdAt < now - olderThanDays*86400 are affected.",
            parameters: Type.Object({
                agentId: agentIdParam,
                olderThanDays: Type.Number({ description: "Records older than this many days are expired" }),
            }),
            execute: (_id: string, params: { agentId: string; olderThanDays: number }) =>
                run("dm_candidates_expire_old", () => expireOldDmCandidates(params.agentId, params.olderThanDays, log)),
        });

        reg({
            name: "tg_classify_messages",
            description:
                "Classify raw messages from telegram_get_messages into three categories: " +
                "generalMessages (no reply to the agent), newThreadMessages (first user replies to the agent's T2, grouped by replyToMsgId), " +
                "threadReplies (continuations of existing threads, grouped by threadId, including expired threads). " +
                "All DB lookups happen inside this tool — call it once per channel right after telegram_mark_as_read. " +
                "Always returns all three categories (empty arrays when nothing matches).",
            parameters: Type.Object({
                agentId: agentIdParam,
                chatId: Type.String({ description: "Telegram chat ID where the messages came from" }),
                messages: Type.Array(
                    Type.Object({
                        id: Type.Number(),
                        fromId: Type.String(),
                        fromName: Type.String(),
                        text: Type.String(),
                        date: Type.Number(),
                        userAccessHash: Type.Optional(Type.String()),
                        replyToMsgId: Type.Optional(Type.Number()),
                    }),
                    { description: "Array of raw messages produced by telegram_get_messages" },
                ),
            }),
            execute: (_id: string, params: { agentId: string; chatId: string; messages: ClassifyInputMessage[] }) =>
                run("tg_classify_messages", () => classifyMessages(params.agentId, params.chatId, params.messages, log)),
        });

        reg({
            name: "tg_group_thread_create",
            description:
                "Create a new group thread from the first user reply to an agent message. " +
                "Initialises the thread with two messages: the original user message (T1) and the agent's reply (T2). " +
                "Registers agentMsgId in group_thread_agent_msgs. Returns the new threadId.",
            parameters: Type.Object({
                agentId: agentIdParam,
                chatId: Type.String({ description: "Telegram chat ID" }),
                startMsgId: Type.Number({ description: "Message ID of the original user message (T1)" }),
                startMsgText: Type.String({ description: "Text of the original user message (T1)" }),
                agentMsgId: Type.Number({ description: "Message ID of the agent's reply (T2)" }),
                agentMsgText: Type.String({ description: "Text of the agent's reply (T2)" }),
            }),
            execute: (
                _id: string,
                params: { agentId: string; chatId: string; startMsgId: number; startMsgText: string; agentMsgId: number; agentMsgText: string },
            ) => run("tg_group_thread_create", () => createGroupThread(params.agentId, params, log)),
        });

        reg({
            name: "tg_group_thread_update",
            description:
                "Append new messages to an existing group thread and register the new agent message ID. " +
                "newMessages is a JSON array of message objects to append to the existing chain. " +
                "newAgentMsgId is the message ID of the agent's reply just sent — it will be registered in group_thread_agent_msgs.",
            parameters: Type.Object({
                agentId: agentIdParam,
                threadId: Type.Number({ description: "ID of the group_threads record to update" }),
                newMessages: Type.String({
                    description:
                        "JSON array of new message objects to append. Each object: " +
                        '{ role: "user"|"agent", msgId: number, fromName?: string, fromId?: string, text: string }',
                }),
                newAgentMsgId: Type.Number({ description: "Message ID of the agent's reply just sent" }),
            }),
            execute: (
                _id: string,
                params: { agentId: string; threadId: number; newMessages: string; newAgentMsgId: number },
            ) => run("tg_group_thread_update", () => updateGroupThread(params.agentId, params.threadId, params.newMessages, params.newAgentMsgId, log)),
        });

        reg({
            name: "tg_group_thread_expire",
            description:
                "Mark group threads as 'expired' if their lastActivityAt is older than olderThanSeconds seconds ago. " +
                "Call once per run before processing thread-replies. Default: 345600 seconds (4 days).",
            parameters: Type.Object({
                agentId: agentIdParam,
                olderThanSeconds: Type.Optional(Type.Number({
                    description: "Threads inactive for more than this many seconds are expired. Default: 345600 (4 days).",
                })),
            }),
            execute: (_id: string, params: { agentId: string; olderThanSeconds?: number }) =>
                run("tg_group_thread_expire", () => expireGroupThreads(params.agentId, log, params.olderThanSeconds)),
        });

        // ─── DM threads DB ────────────────────────────────────────────

        reg({
            name: "dm_threads_create",
            description:
                "Create a new DM thread when the first DM is sent to a user. " +
                "Stores the first agent message in the messages JSON array. " +
                "Returns { ok: true, threadId } on success, or { error: 'thread_exists' } if a thread for this userId already exists.",
            parameters: Type.Object({
                agentId: agentIdParam,
                userId: Type.String({ description: "Telegram user ID (string)" }),
                userAccessHash: Type.String({ description: "Access hash for InputPeerUser" }),
                userName: Type.Optional(Type.String({ description: "Username (@handle), nullable" })),
                fromChatId: Type.String({ description: "ID of the group where the user was found" }),
                triggerMessage: Type.String({ description: "The user's message from the group that triggered this DM" }),
                firstMessage: Type.Object({
                    role: Type.Literal("agent"),
                    msgId: Type.Number({ description: "Telegram message ID of the sent DM" }),
                    text: Type.String({ description: "Text of the sent DM" }),
                    sentAt: Type.Number({ description: "Unix timestamp when the DM was sent" }),
                }),
            }),
            execute: (
                _id: string,
                params: {
                    agentId: string;
                    userId: string;
                    userAccessHash: string;
                    userName?: string;
                    fromChatId: string;
                    triggerMessage: string;
                    firstMessage: { role: "agent"; msgId: number; text: string; sentAt: number };
                },
            ) => run("dm_threads_create", () => createDmThread(params.agentId, params, log)),
        });

        reg({
            name: "dm_threads_get_by_users",
            description:
                "Find DM threads by a list of userIds and update their accessHash/userName from fresh peer data. " +
                "The update and select happen in a single transaction. " +
                "Returns { threads: [...], notFound: [userId, ...] }.",
            parameters: Type.Object({
                agentId: agentIdParam,
                users: Type.Array(
                    Type.Object({
                        userId: Type.String({ description: "Telegram user ID" }),
                        accessHash: Type.String({ description: "Fresh access hash from telegram_get_dm_dialogs" }),
                        userName: Type.Optional(Type.String({ description: "Fresh username from peer data" })),
                    }),
                    { description: "List of users with fresh peer data to look up" },
                ),
            }),
            execute: (
                _id: string,
                params: { agentId: string; users: Array<{ userId: string; accessHash: string; userName?: string }> },
            ) => run("dm_threads_get_by_users", () => getDmThreadsByUsers(params.agentId, params.users, log)),
        });

        reg({
            name: "dm_threads_update_msgs",
            description:
                "Append new messages to a DM thread's messages JSON array and update lastActivityAt. " +
                "If the total exceeds 50 messages, the oldest are trimmed (sliding window). " +
                "Returns { ok: true, totalMessages } on success.",
            parameters: Type.Object({
                agentId: agentIdParam,
                userId: Type.String({ description: "Telegram user ID identifying the thread" }),
                newMessages: Type.Array(
                    Type.Object({
                        role: Type.Union([Type.Literal("agent"), Type.Literal("user")]),
                        msgId: Type.Number({ description: "Telegram message ID" }),
                        text: Type.String({ description: "Message text" }),
                        sentAt: Type.Number({ description: "Unix timestamp of the message" }),
                    }),
                    { description: "New messages to append to the thread" },
                ),
            }),
            execute: (
                _id: string,
                params: { agentId: string; userId: string; newMessages: DmThreadMessage[] },
            ) => run("dm_threads_update_msgs", () => updateDmThreadMsgs(params.agentId, params.userId, params.newMessages, log)),
        });

        reg({
            name: "dm_threads_count_today",
            description:
                "Return the count of DM threads created today (since midnight UTC). " +
                "Used to enforce the daily sending limit.",
            parameters: Type.Object({ agentId: agentIdParam }),
            execute: (_id: string, params: { agentId: string }) =>
                run("dm_threads_count_today", () => countDmThreadsToday(params.agentId, log)),
        });

        reg({
            name: "dm_threads_exists",
            description:
                "Check if a DM thread exists for the given userId, with cooldown calculation. " +
                "Returns { exists: false } if no thread, or { exists: true, cooldownActive: bool, days: number } " +
                "where cooldownActive is true if lastActivityAt is within 14 days.",
            parameters: Type.Object({
                agentId: agentIdParam,
                userId: Type.String({ description: "Telegram user ID to check" }),
            }),
            execute: (_id: string, params: { agentId: string; userId: string }) =>
                run("dm_threads_exists", () => dmThreadExists(params.agentId, params.userId, log)),
        });

        reg({
            name: "dm_threads_delete",
            description:
                "Delete a DM thread by userId. Idempotent — returns { deleted: true } if a row was removed, " +
                "{ deleted: false } if no thread existed for this userId.",
            parameters: Type.Object({
                agentId: agentIdParam,
                userId: Type.String({ description: "Telegram user ID whose thread to delete" }),
            }),
            execute: (_id: string, params: { agentId: string; userId: string }) =>
                run("dm_threads_delete", () => deleteDmThread(params.agentId, params.userId, log)),
        });

        // ─── Join queue DB ────────────────────────────────────────────

        reg({
            name: "tg_join_queue_add",
            description:
                "Add Telegram channel links to the join queue. " +
                "Duplicate links are silently ignored (INSERT OR IGNORE). " +
                "Returns counts of added and skipped (duplicate) links.",
            parameters: Type.Object({
                agentId: agentIdParam,
                links: Type.Array(
                    Type.String({ description: "Telegram channel link in t.me/username format" }),
                    { description: "List of links to enqueue" },
                ),
            }),
            execute: (_id: string, params: { agentId: string; links: string[] }) =>
                run("tg_join_queue_add", () => addJoinQueue(params.agentId, params.links, log)),
        });

        // ── tg_discovery_run ──────────────────────────────────────────
        // Запуск прогона channel-discovery. Операторский диалог (предложить
        // ключевые слова, собрать пороги) ведёт агент в чате; этот тул — только
        // детерминированный прогон. Вступление не запускает.
        reg({
            name: "tg_discovery_run",
            description:
                "Run channel discovery: search TGStat by keywords, filter by min subscribers, " +
                "dedupe against the registry, assign new channels round-robin across agents, and push them into " +
                "each agent's join queue. Returns a per-agent report and whether target N was reached. " +
                "Before calling: agree keywords with the operator. Joining itself is NOT triggered " +
                "here — the per-agent join-queue timer does it.",
            parameters: Type.Object({
                keywords: Type.Array(Type.String(), { description: "Agreed search keywords" }),
                n: Type.Number({ description: "Target number of new channels for the whole run" }),
                minSubscribers: Type.Number({ description: "Minimum subscribers threshold" }),
                minAvgPostReach: Type.Optional(Type.Number({ description: "Minimum average post reach from TGStat (avg_post_reach). If not set, the gate is not applied." })),
                avgReachAgentId: Type.Optional(Type.String({ description: "Agent ID to use for manual reach calculation via Telegram when TGStat data is unavailable." })),
                agents: Type.Optional(Type.Array(Type.String(), { description: "Agents to distribute to. Default: all agents." })),
                adminAgentId: Type.Optional(Type.String({ description: "Registry owner (discovery.db). Default: admin agent." })),
            }),
            execute: (
                _id: string,
                params: { keywords: string[]; n: number; minSubscribers: number; minAvgPostReach?: number; avgReachAgentId?: string; agents?: string[]; adminAgentId?: string },
            ) =>
                run("tg_discovery_run", async () => {
                    const agents = params.agents && params.agents.length > 0 ? params.agents : listAgentIds();
                    if (agents.length === 0) throw new Error("no agents to distribute to");
                    if (!tgstatToken) {
                        throw new Error(
                            "tgstatToken not configured: set plugins.entries.telegram-user-tool.config.tgstatToken (or TGSTAT_TOKEN env)",
                        );
                    }
                    // Если задан avgReachAgentId — загружаем аккаунт и передаём сервис как MTProto fallback (D5).
                    if (params.avgReachAgentId) {
                        tg.loadAccount(params.avgReachAgentId);
                    }
                    const result = await runDiscovery(
                        {
                            keywords: params.keywords,
                            target: params.n,
                            minSubscribers: params.minSubscribers,
                            minAvgPostReach: params.minAvgPostReach,
                            avgReachAgentId: params.avgReachAgentId,
                            telegramService: params.avgReachAgentId ? tg : undefined,
                            adminAgentId: params.adminAgentId ?? FUNNEL_ADMIN_AGENT_ID,
                            agents,
                            tgstatToken,
                        },
                        log,
                    );
                    return { report: renderReport(result), ...result };
                }),
        });

        // ── tg_discovery_similar_run ──────────────────────────────────
        // Обход похожих каналов через рекомендации Telegram (MTProto), отдельно
        // от TGStat. Последовательно по агентам на их сессиях. Вступление не
        // запускает. Операторский диалог (собрать min_subscribers, опц. агентов)
        // ведёт агент в чате; этот тул — только детерминированный обход.
        reg({
            name: "tg_discovery_similar_run",
            description:
                "Run similar-channel discovery via Telegram's native recommendations (MTProto), complementing TGStat. " +
                "Two phases. COLLECT: seed channels of all searcher agents are pooled and ranked globally by audience " +
                "engagement (median post views / subscribers over a recent-posts window), then the recommendation graph " +
                "is crawled strictly by levels (batched per searcher within a level; each seed's branch runs on its " +
                "searcher's session), gating candidates by min subscribers, a linked discussion group, engagement " +
                "(avg views per post and ER over a window) and topic relevance, deduping against the registry, until " +
                "target × N channels are collected (N = number of platform agents). A searcher's crawl stops after " +
                "2 consecutive FLOOD_WAITs. DISTRIBUTE: the pool is spread round-robin across all platform agents (up " +
                "to `target` each), assigning each channel to one agent (registry) and pushing it into that agent's " +
                "join queue. " +
                "Candidates are gated, in order: min subscribers; presence of a linked discussion group; engagement " +
                "(avg views per post and ER, computed over the channel's recent posts minus the 2 freshest, kept when " +
                "both are strictly above their thresholds — fail-closed if too few posts to measure); topic relevance " +
                "(LLM scores the channel against the run `theme` 0..1; kept when score > minTopicScore, fail-closed). " +
                "Seed engagement affects crawl order only, not selection. No keywords. " +
                "Joining itself is NOT triggered here — the per-agent join-queue timer does it. " +
                "Returns how many channels were collected against the goal, the per-agent distribution and skip counts.",
            parameters: Type.Object({
                minSubscribers: Type.Number({ description: "Minimum subscribers threshold" }),
                target: Type.Number({ description: "Target number of new channels per platform agent; total goal = target × N" }),
                agents: Type.Array(Type.String(), { description: "Searcher agents whose sessions and seed channels drive the crawl (required)" }),
                theme: Type.String({ description: "Run topic (single for all agents); candidates are scored for relevance to it (required)" }),
                minAvgViews: Type.Number({ description: "Minimum average views per post (strict >), over the channel's recent posts minus the 2 freshest. No default — set per niche/language (required)." }),
                adminAgentId: Type.Optional(Type.String({ description: "Registry owner (discovery.db). Default: admin agent." })),
                minTopicScore: Type.Optional(Type.Number({ description: "Topic relevance threshold (strict >), measured as the share of channel content matching the theme. Default: 0.5." })),
                postsCount: Type.Optional(Type.Number({ description: "Number of latest channel posts fetched per channel — shared window for engagement scoring and topic scoring (> 2). Default: 20." })),
                minEngagementRate: Type.Optional(Type.Number({ description: "Minimum engagement rate (strict >), avg views per post / subscribers. Default: 0.1." })),
            }),
            execute: (
                _id: string,
                params: { minSubscribers: number; target: number; agents: string[]; theme: string; minAvgViews: number; adminAgentId?: string; minTopicScore?: number; postsCount?: number; minEngagementRate?: number },
            ) =>
                run("tg_discovery_similar_run", async () => {
                    const searchers = params.agents ?? [];
                    if (searchers.length === 0) throw new Error("no searcher agents specified");
                    const theme = params.theme?.trim() ?? "";
                    if (theme.length === 0) throw new Error("no theme specified");
                    const allAgents = listAgentIds();
                    if (allAgents.length === 0) throw new Error("no platform agents to distribute to");
                    const postsCount = params.postsCount ?? 20;
                    if (!Number.isFinite(postsCount) || postsCount <= 2) throw new Error("postsCount must be > 2");
                    if (!Number.isFinite(params.minAvgViews)) throw new Error("minAvgViews is required");
                    const result = await runSimilarDiscovery(
                        {
                            minSubscribers: params.minSubscribers,
                            target: params.target,
                            adminAgentId: params.adminAgentId ?? FUNNEL_ADMIN_AGENT_ID,
                            searchers,
                            allAgents,
                            theme,
                            minTopicScore: params.minTopicScore ?? 0.5,
                            postsCount,
                            minEngagementRate: params.minEngagementRate ?? 0.1,
                            minAvgViews: params.minAvgViews,
                            llm: createLlmClient(),
                        },
                        log,
                    );
                    return { report: renderSimilarReport(result), ...result };
                }),
        });

        // ── tg_channel_content_analysis ──────────────────────────────
        // По запросу оператора: для каждого агента берём его broadcast-каналы (из
        // его сессии, без внешних сервисов), отбираем верхние m% по числу
        // подписчиков, собираем последние n постов, считаем ERR по охвату и тег
        // темы (LLM). Выгружаем единый CSV (строка = пост) на сервер и в Saved
        // Messages админ-агента. Возвращает статистику прогона и путь к CSV.
        reg({
            name: "tg_channel_content_analysis",
            description:
                "Analyze content of agents' top channels to inform the main agent's content. " +
                "For each agent (sequentially, on its own session): take its broadcast channels " +
                "(from its dialogs — no external services), rank by subscriber count descending, keep " +
                "the top `m` percent, collect the last `n` posts each. Per post computes engagement " +
                "ERR = (reactions + comments + forwards) / views × 100% (all from MTProto), tags the " +
                "post topic via LLM, and builds a post link. Writes a single CSV (one row per post; " +
                "columns: agent, channel, channel_size, topic, ERR, views, reactions, comments, forwards, " +
                "age, link) to the admin agent's reports/ folder and sends it as a document to the admin " +
                "agent's Saved Messages with a short stats message. Failures on a channel or agent are " +
                "skipped and reported, the run does not abort.",
            parameters: Type.Object({
                agents: Type.Array(Type.String(), { description: "Agent ids whose channels to analyze (required, non-empty)" }),
                n: Type.Number({ description: "Number of latest posts to collect per channel (> 0)" }),
                m: Type.Number({ description: "Percent of largest channels per agent to analyze, (0, 100]" }),
                adminAgentId: Type.Optional(Type.String({ description: "Owner of reports/ and Saved Messages recipient. Default: admin agent." })),
            }),
            execute: (_id: string, params: { agents: string[]; n: number; m: number; adminAgentId?: string }) =>
                run("tg_channel_content_analysis", async () => {
                    const agents = params.agents ?? [];
                    if (agents.length === 0) throw new Error("no agents specified");
                    if (!Number.isFinite(params.n) || params.n <= 0) throw new Error("n must be > 0");
                    if (!Number.isFinite(params.m) || params.m <= 0 || params.m > 100) throw new Error("m must be in (0, 100]");
                    const result = await runChannelAnalysis(
                        {
                            agents,
                            n: params.n,
                            m: params.m,
                            adminAgentId: params.adminAgentId ?? FUNNEL_ADMIN_AGENT_ID,
                            llm: createLlmClient(),
                        },
                        log,
                    );
                    return { report: renderStats(result), ...result };
                }),
        });

        // ── tg_channel_context_run ──────────────────────────────────────
        // Ручной запуск фонового анализа контекста каналов (channel-context) —
        // та же логика отбора (channelResolved=1, TTL 90 дней по
        // channel_context_updated_at, без фильтра по status), что и у периодической
        // задачи диспетчера, просто параметризованная числом каналов на агента.
        // Последовательно по агентам: своя MTProto-сессия на агента, отключение
        // между ними — по образцу tg_channel_content_analysis.
        reg({
            name: "tg_channel_context_run",
            description:
                "Manually run background channel-context analysis for a list of agents. For each agent " +
                "(sequentially, on its own session), selects up to `count` channels whose channel_context " +
                "was never built or is older than 90 days (channelResolved=1 AND channelId NOT NULL; channel " +
                "status such as banned/suspend does NOT exclude it) — the same selection the periodic " +
                "channel-context dispatcher task uses. For each selected channel: fetches title, about, " +
                "pinned post text, posts from the last 90 days (capped at 100), and comments on each post; " +
                "recomputes subscriber count and average views (written to the shared channels.avg_views/ " +
                "subs_count cache); makes one LLM call over all collected data to produce a free-text 10-50 " +
                "line channel description, saved to channels.channel_context. Failures on a channel or agent " +
                "are skipped and reported, the run does not abort.",
            parameters: Type.Object({
                agents: Type.Array(Type.String(), { description: "Agent ids to analyze channels for (required, non-empty)" }),
                count: Type.Number({ description: "Number of channels to analyze per agent (> 0)" }),
            }),
            execute: (_id: string, params: { agents: string[]; count: number }) =>
                run("tg_channel_context_run", async () => {
                    const agents = params.agents ?? [];
                    if (agents.length === 0) throw new Error("no agents specified");
                    if (!Number.isFinite(params.count) || params.count <= 0) throw new Error("count must be > 0");

                    const llm = createLlmClient();
                    const results = [];
                    for (const agentId of agents) {
                        const tg = new TelegramService(log);
                        try {
                            tg.loadAccount(agentId);
                            const agentLlm = withLlmLogging(llm, agentId, "channel-context", log);
                            results.push(await runChannelContextForAgent({ agentId, limit: params.count, tg, llm: agentLlm }, log));
                        } catch (err: any) {
                            results.push({ channelsSelected: 0, channelsAnalyzed: 0, skipped: [{ agent: agentId, reason: err?.message ?? String(err) }] });
                        } finally {
                            await tg.disconnect().catch(() => {});
                        }
                    }
                    return { report: renderChannelContextStats(results), results };
                }),
        });

        // ── tg_channel_metrics ────────────────────────────────────────
        // Метрики произвольного списка каналов (не обязательно своих агента):
        // подписчики, средний охват последних постов, открыты ли комментарии,
        // broadcast ли канал. С withNiche — плюс ниша/тематика одним LLM-вызовом
        // на канал (переиспользует уже полученные title/about/посты). Та же
        // логика, что у CLI tsx src/scripts/channel-metrics.ts.
        reg({
            name: "tg_channel_metrics",
            description:
                "Measure an arbitrary list of Telegram channels (not necessarily the agent's own): " +
                "subscriber count, average views of recent posts, whether a discussion group is linked " +
                "(comments open), and whether the channel is a broadcast channel (vs megagroup). " +
                "With withNiche=true, additionally classifies each channel's niche/topic via one LLM call " +
                "per channel, reusing the already-fetched title/about/posts (no extra Telegram round trip). " +
                "Writes a CSV (one row per link) to the agent's reports/ folder and sends it to the agent's " +
                "Saved Messages. Pass the same runId to resume an interrupted run (e.g. stopped by FLOOD_WAIT) " +
                "— links already present in that run's CSV are skipped; omit runId to start a new run.",
            parameters: Type.Object({
                agentId: agentIdParam,
                links: Type.Array(
                    Type.String({ description: "Telegram channel link, e.g. t.me/username" }),
                    { description: "Channel links to measure" },
                ),
                withNiche: Type.Optional(Type.Boolean({ description: "Also classify niche/topic via LLM. Default: false." })),
                runId: Type.Optional(Type.String({ description: "Reuse to resume an interrupted run. Omit to start a new run." })),
            }),
            execute: (_id: string, params: { agentId: string; links: string[]; withNiche?: boolean; runId?: string }) =>
                run("tg_channel_metrics", async () => {
                    const links = params.links ?? [];
                    if (links.length === 0) throw new Error("no links specified");
                    const withNiche = params.withNiche === true;

                    const dir = reportsDir(params.agentId);
                    fs.mkdirSync(dir, { recursive: true });
                    const runId = params.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
                    const outputPath = path.join(dir, `channel-metrics-${runId}.csv`);

                    const result = await runChannelMetrics(
                        {
                            links,
                            agentId: params.agentId,
                            outputPath,
                            withNiche,
                            llm: withNiche ? createLlmClient() : undefined,
                        },
                        log,
                    );

                    tg.loadAccount(params.agentId);
                    await tg.sendSavedDocument(
                        outputPath,
                        `Метрики каналов: обработано ${result.done}, пропущено ${result.skipped}` +
                            `${result.stoppedByFlood ? " (остановлено по FLOOD_WAIT — повторите с тем же runId)" : ""}`,
                    );

                    return { ...result, runId };
                }),
        });

        reg({
            name: "tg_join_queue_get_batch",
            description:
                "Atomically claim the next batch of links for processing. " +
                "First resets stale 'processing' entries (older than 1 hour) back to 'pending' " +
                "so crashed runs don't block the queue. " +
                "Returns empty array when queue is exhausted (all joined/skipped or max attempts reached).",
            parameters: Type.Object({
                agentId: agentIdParam,
                limit: Type.Optional(Type.Number({ description: "Maximum number of links to claim. Default: 15." })),
            }),
            execute: (_id: string, params: { agentId: string; limit?: number }) =>
                run("tg_join_queue_get_batch", () => getJoinQueueBatch(params.agentId, log, params.limit)),
        });

        reg({
            name: "tg_join_queue_update",
            description:
                "Update the status of a link after a join attempt. " +
                "Use 'joined' on success, 'skipped' for permanent skips (private, invalid, etc.), " +
                "'error' for transient errors (will be retried up to 3 times total).",
            parameters: Type.Object({
                agentId: agentIdParam,
                link: Type.String({ description: "The link being updated" }),
                status: Type.Union(
                    [Type.Literal("joined"), Type.Literal("skipped"), Type.Literal("error")],
                    { description: "Result of the join attempt" },
                ),
                error: Type.Optional(Type.String({ description: "Error message, required when status is 'error'" })),
            }),
            execute: (
                _id: string,
                params: { agentId: string; link: string; status: "joined" | "skipped" | "error"; error?: string },
            ) => run("tg_join_queue_update", () => updateJoinQueue(params.agentId, params.link, params.status, params.error, log)),
        });

        reg({
            name: "tg_join_queue_stats",
            description: "Get current queue statistics: counts by status. Useful to check progress.",
            parameters: Type.Object({ agentId: agentIdParam }),
            execute: (_id: string, params: { agentId: string }) =>
                run("tg_join_queue_stats", () => joinQueueStats(params.agentId, log)),
        });

        // ─── Scheduler control panel (пульт управления, §3.6) ─────────

        const taskTypeParam = Type.Union(
            [
                Type.Literal("monitor"),
                Type.Literal("monitor-v2"),
                Type.Literal("monitor-v3"),
                Type.Literal("monitor-v4"),
                Type.Literal("monitor-v5"),
                Type.Literal("dm-send"),
                Type.Literal("dm-replies"),
                Type.Literal("account-warmup"),
                Type.Literal("join-queue"),
                Type.Literal("leave-banned"),
                Type.Literal("channel-context"),
            ],
            { description: "Task type — one of the ported skills the dispatcher can run" },
        );

        reg({
            name: "tg_scheduler_upsert_task",
            description:
                "Create or update a scheduled task for an agent in the tasks DB, and enable the agent's " +
                "systemd heartbeat timer if this is the agent's first active task. " +
                "Use when the user wants to start a recurring task (monitor, monitor-v2, monitor-v3, monitor-v4, monitor-v5, dm-send, dm-replies, account-warmup, join-queue, leave-banned, channel-context) " +
                "or change its schedule. schedule is a 5-field cron expression; tz is an IANA timezone. " +
                "Both are optional: if omitted, a default is computed automatically — periodic task types " +
                "get a start phase evenly staggered across agents (round-robin), calendar task types " +
                "(dm-send, leave-banned) get a fixed default time. Pass schedule/tz explicitly to override. " +
                "On conflict (same agentId+type) the schedule/tz are updated and the task is re-enabled. " +
                "Returns { schedule, tz, timerEnabled, systemctl } — schedule/tz are the values actually applied " +
                "(useful when they were computed, not passed); timerEnabled=true means the timer was just turned on.",
            parameters: Type.Object({
                agentId: agentIdParam,
                type: taskTypeParam,
                schedule: Type.Optional(Type.String({
                    description: "5-field cron expression, e.g. '0 */3 * * *' (every 3h) or '0 14 * * *' (daily 14:00). Omit to auto-compute a staggered default.",
                })),
                tz: Type.Optional(Type.String({
                    description: "IANA timezone, e.g. 'Asia/Yekaterinburg' or 'UTC'. Omit to auto-compute a staggered default.",
                })),
            }),
            execute: (_id: string, params: { agentId: string; type: TaskType; schedule?: string; tz?: string }) =>
                run("tg_scheduler_upsert_task", () => createOrUpdateTask(params, log)),
        });

        reg({
            name: "tg_scheduler_trigger_now",
            description:
                "Run a scheduled task out of band: set its nextRun to now and start the agent's dispatcher service. " +
                "If the dispatcher is free it starts immediately and picks up the due task; if busy, the start-job " +
                "coalesces and runs after the current run finishes. " +
                "The task must already exist and be enabled (use tg_scheduler_upsert_task first).",
            parameters: Type.Object({
                agentId: agentIdParam,
                type: taskTypeParam,
            }),
            execute: (_id: string, params: { agentId: string; type: TaskType }) =>
                run("tg_scheduler_trigger_now", () => triggerTaskNow(params, log)),
        });

        reg({
            name: "tg_scheduler_remove_task",
            description:
                "Stop a scheduled task (set enabled=0 in the tasks DB). If the agent has no active tasks left, " +
                "the systemd heartbeat timer is also disabled so the dispatcher stops waking up. " +
                "The task row is kept (disabled), not deleted. " +
                "Returns { timerDisabled, systemctl } — timerDisabled=true means the timer was just turned off.",
            parameters: Type.Object({
                agentId: agentIdParam,
                type: taskTypeParam,
            }),
            execute: (_id: string, params: { agentId: string; type: TaskType }) =>
                run("tg_scheduler_remove_task", () => removeTask(params, log)),
        });

        reg({
            name: "tg_scheduler_list_tasks",
            description:
                "List all scheduled tasks of an agent with their schedule, timezone, last run, next run and enabled flag. " +
                "Use to show the agent's current schedule status. lastRun/nextRun are Unix timestamps in seconds.",
            parameters: Type.Object({ agentId: agentIdParam }),
            execute: (_id: string, params: { agentId: string }) =>
                run("tg_scheduler_list_tasks", () => getSchedule(params.agentId)),
        });

        // ── tg_daily_summary ──────────────────────────────────────────
        // Сводка прогонов по ВСЕМ агентам за текущий день UTC+5 (от полуночи до
        // now). Читает таблицы runs всех агентов. Возвращает { summary, text } —
        // text готов к показу в чат. Параметров нет (читаются все агенты).
        reg({
            name: "tg_daily_summary",
            description:
                "Build a run-status summary across ALL agents for the current day (UTC+5, from midnight to now). " +
                "Aggregates per agent and per skill: number of runs, successes, errors, total LLM requests and total duration, " +
                "plus an overall total. Use when the user asks how the agents performed today or wants a daily run report. " +
                "Returns { summary, text } — present the `text` field to the user.",
            parameters: Type.Object({}),
            execute: (_id: string) =>
                run("tg_daily_summary", () => buildDailySummary(currentDayWindow())),
        });

        // ── tg_funnel_report ──────────────────────────────────────────
        // Воронка по ВСЕМ агентам — срез «на сейчас» (текущий день UTC+5).
        // Собирает метрики через MTProto + per-agent БД, считает дельту
        // относительно последнего сохранённого снапшота и НЕ пишет постоянный
        // снапшот (persist=false) — не задевает таймерный дневной ряд.
        // adminAgentId/privateChannelId берутся из окружения гейтвея.
        reg({
            name: "tg_funnel_report",
            description:
                "Build a funnel report across ALL agents for right now (current day UTC+5): per-agent group replies, " +
                "DMs sent, public-channel post views and subscriber growth, plus pending join requests to the private " +
                "channel (agent1). Collects fresh values via MTProto and computes deltas vs the last stored snapshot " +
                "WITHOUT persisting a daily snapshot. Sends the monospace funnel TEXT and a full 7-stage CSV to the " +
                "report recipient's Saved Messages itself (so the table stays aligned in a code block). " +
                "Use when the user asks for the funnel / channel stats now. Returns { text, result } where `text` is a " +
                "short confirmation to relay to the user — do NOT re-post the table, it is already in Saved Messages.",
            parameters: Type.Object({}),
            execute: (_id: string) =>
                run("tg_funnel_report", async () => {
                    const result = await collectFunnel(
                        tg,
                        {
                            window: currentDayWindow(),
                            persist: false,
                            adminAgentId: FUNNEL_ADMIN_AGENT_ID,
                            privateChannelId: FUNNEL_PRIVATE_CHANNEL_ID,
                        },
                        log,
                    );

                    const text = renderFunnel(result);

                    // Полная таблица по всем 7 этапам — CSV; текст воронки — отдельным
                    // сообщением. Оба шлём САМИ в Избранное получателя отчётов (текст — с
                    // parseMode "md"), чтобы моноширинная таблица не разъезжалась:
                    // агент-пересыльщик код-блок не гарантирует. Данные (CSV) лежат в
                    // reportsDir владельца данных (FUNNEL_ADMIN_AGENT_ID) — получатель
                    // отправки (REPORT_AGENT_ID) от него независим.
                    const csvPath = funnelCsvPath(FUNNEL_ADMIN_AGENT_ID, result.window);
                    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
                    fs.writeFileSync(csvPath, buildFunnelCsv(result), "utf-8");

                    tg.loadAccount(REPORT_AGENT_ID);
                    await tg.sendSavedMessage(text, "md");
                    await tg.sendSavedDocument(csvPath, `Воронка · ${result.window.label} — полная таблица по агентам`);

                    return {
                        text:
                            `Отчёт-воронка за ${result.window.label} отправлен в Избранное ${REPORT_AGENT_ID} ` +
                            `(текст + CSV по всем агентам).`,
                        result,
                    };
                }),
        });

        // ── tg_channel_coverage_report ────────────────────────────────

        reg({
            name: "tg_channel_coverage_report",
            description:
                "Собирает каналы всех агентов с кэшированным средним охватом (avg_views), " +
                "формирует CSV-файл и отправляет его в Saved Messages получателя отчётов. " +
                "Каналы отсортированы по убыванию охвата; каналы без охвата — в конце. " +
                "avg_views пересчитывается отдельным скриптом раз в месяц.",
            parameters: Type.Object({}),
            execute: (_id: string) =>
                run("tg_channel_coverage_report", async () => {
                    const agentIds = listAgentIds();

                    type Row = {
                        chatId: string;
                        title: string;
                        channelUsername: string | null;
                        avg_views: number | null;
                        coverage_updated_at: number | null;
                        agentId: string;
                    };

                    const rows: Row[] = [];
                    for (const agentId of agentIds) {
                        const channels = getAllChannelsWithAvgViews(agentId);
                        for (const ch of channels) {
                            rows.push({ ...ch, agentId });
                        }
                    }

                    rows.sort((a, b) => {
                        if (a.avg_views === null && b.avg_views === null) return 0;
                        if (a.avg_views === null) return 1;
                        if (b.avg_views === null) return -1;
                        return b.avg_views - a.avg_views;
                    });

                    const formatDate = (ts: number | null): string => {
                        if (ts === null) return "";
                        return new Date(ts * 1000).toISOString().slice(0, 10);
                    };

                    const escapeCsv = (v: string): string =>
                        v.includes(",") || v.includes('"') || v.includes("\n")
                            ? `"${v.replace(/"/g, '""')}"`
                            : v;

                    const header = "Название,Ссылка,chat_id,Средний охват,Дата пересчёта,Агент\n";
                    const lines = rows.map((r) =>
                        [
                            escapeCsv(r.title),
                            r.channelUsername ? `t.me/${r.channelUsername}` : "",
                            r.chatId,
                            r.avg_views !== null ? r.avg_views.toFixed(1) : "",
                            formatDate(r.coverage_updated_at),
                            r.agentId,
                        ].join(","),
                    );
                    const csv = header + lines.join("\n");

                    const csvPath = path.join(os.tmpdir(), `channel-coverage-${Date.now()}.csv`);
                    fs.writeFileSync(csvPath, csv, "utf-8");
                    try {
                        tg.loadAccount(REPORT_AGENT_ID);
                        await tg.sendSavedDocument(
                            csvPath,
                            `Охват каналов · ${new Date().toISOString().slice(0, 10)} — ${rows.length} каналов, ${agentIds.length} агентов`,
                        );
                    } finally {
                        fs.unlinkSync(csvPath);
                    }

                    return { channelCount: rows.length, agentCount: agentIds.length };
                }),
        });

        // ── tg_channel_activity_update ──────────────────────────────────
        // Запускает пересчёт метрик канала (avg_views/subs_count и
        // active_writers_p50/p90) для явно перечисленных агентов через
        // systemd (tg-channel-activity-update-manual@.service) — НЕ через
        // общий tg этого процесса: прогон может идти минуты-часы (полная
        // история чата за 30 дней, design.md channel-activity-percentiles),
        // а tg — один на весь плагин и держал бы остальные интерактивные
        // инструменты всех агентов заблокированными на всё это время.
        // Инструмент не дожидается завершения — только факт запуска юнита.

        reg({
            name: "tg_channel_activity_update",
            description:
                "Запускает в фоне (через systemd, не дожидаясь завершения) пересчёт охвата " +
                "(avg_views/subs_count) и активности чата (p50/p90 уникальных отправителей в " +
                "сутки за 30 дней) для перечисленных агентов — TTL игнорируется, пересчитываются " +
                "ВСЕ каналы каждого агента. Возвращает только факт успешного запуска, не " +
                "результат пересчёта (тот появится в channels.db агентов через минуты-часы). " +
                "limit — необязательно, ограничивает число каналов на КАЖДОГО перечисленного агента.",
            parameters: Type.Object({
                agentIds: Type.Array(Type.String(), {
                    description: "Список agentId для пересчёта. Обязателен — берётся из запроса пользователя.",
                }),
                limit: Type.Optional(Type.Number({
                    description: "Максимум каналов на каждого агента (для точечной проверки перед полным прогоном).",
                })),
            }),
            execute: (_id: string, params: { agentIds: string[]; limit?: number }) =>
                run("tg_channel_activity_update", () => triggerActivityUpdate(params.agentIds, params.limit, log)),
        });

        // ── tg_private_invite_links ─────────────────────────────────────
        // Список агентов передаёт вызывающий (не берётся из listAgentIds()) —
        // это ручная, точечная операция, не бэкфилл по всему флоту.

        reg({
            name: "tg_private_invite_links",
            description:
                "Создаёт персональные инвайт-ссылки в приватный канал для указанных агентов " +
                "(request-to-join: заявка требует подтверждения, без лимита по времени и числу " +
                "использований, без платной подписки, название ссылки в Telegram = agentId) от " +
                "имени REPORT_AGENT_ID (администратор канала). Сохраняет каждую ссылку в реестр " +
                "(private-invites.db у FUNNEL_ADMIN_AGENT_ID, поле post_updated = 0 при создании) " +
                "и вставляет её в закреплённый пост (personalChannelMessage) самого агента — три " +
                "строки ссылки в хвосте текста, существующие строки-ссылки заменяются, остальной " +
                "текст поста не трогается; при успехе post_updated = 1. Список agentIds обязателен " +
                "— берётся из запроса пользователя, не выводится сам. " +
                "retryPendingOnly=true — режим повтора: agentIds не нужен, шаг создания ссылки " +
                "пропускается, берутся все агенты с post_updated=0 (ссылка есть, но не подтверждена " +
                "вставленной — например, прошлый прогон упал на таймауте подключения) и для них " +
                "повторяется только вставка в пост существующей ссылкой. " +
                "verifyOnly=true — режим проверки: ничего не создаёт и не редактирует, читает " +
                "реальный текст закреплённого поста каждого агента (все агенты реестра, либо " +
                "только agentIds, если задан) и сравнивает со ссылкой в БД — отчёт о совпадениях " +
                "и расхождениях (например, пост отредактирован вручную или другим процессом).",
            parameters: Type.Object({
                agentIds: Type.Optional(
                    Type.Array(Type.String(), { description: "Список agentId (не нужен при retryPendingOnly; при verifyOnly сужает проверку до этого списка, по умолчанию — все агенты реестра)" }),
                ),
                retryPendingOnly: Type.Optional(
                    Type.Boolean({ description: "Повторить вставку в пост для агентов с post_updated=0, не создавая новых ссылок" }),
                ),
                verifyOnly: Type.Optional(
                    Type.Boolean({ description: "Только проверить соответствие ссылки в БД ссылке в посте, ничего не менять" }),
                ),
            }),
            execute: (_id: string, params: { agentIds?: string[]; retryPendingOnly?: boolean; verifyOnly?: boolean }) =>
                run("tg_private_invite_links", async () => {
                    if (params.verifyOnly && params.retryPendingOnly) {
                        throw new Error("verifyOnly и retryPendingOnly нельзя использовать одновременно");
                    }

                    if (params.verifyOnly) {
                        const registry = listPrivateInviteLinks(FUNNEL_ADMIN_AGENT_ID);
                        const targets = params.agentIds && params.agentIds.length > 0
                            ? registry.filter((r) => params.agentIds!.includes(r.agentId))
                            : registry;

                        const matched: string[] = [];
                        const mismatched: Record<string, { dbLink: string; postLinks: string[] }> = {};
                        const verifyErrors: Record<string, string> = {};

                        for (const row of targets) {
                            try {
                                tg.loadAccount(row.agentId);
                                const res = await tg.getPersonalChannelPostLinks();
                                if (!res.ok) {
                                    verifyErrors[row.agentId] = res.reason;
                                    log.warn(`[tg_private_invite_links] verify failed for agent=${row.agentId}: ${res.reason}`);
                                    continue;
                                }
                                if (res.links.includes(row.inviteLink)) {
                                    matched.push(row.agentId);
                                } else {
                                    mismatched[row.agentId] = { dbLink: row.inviteLink, postLinks: res.links };
                                    log.warn(`[tg_private_invite_links] mismatch for agent=${row.agentId}: db=${row.inviteLink} post=${JSON.stringify(res.links)}`);
                                }
                            } catch (err: any) {
                                const message = err.message ?? String(err);
                                verifyErrors[row.agentId] = message;
                                log.warn(`[tg_private_invite_links] verify error for agent=${row.agentId}: ${message}`);
                            }
                        }

                        const lines: string[] = [
                            `Проверено: ${targets.length}, совпадает: ${matched.length}, ` +
                                `расхождение: ${Object.keys(mismatched).length}, ошибка: ${Object.keys(verifyErrors).length}`,
                        ];
                        if (Object.keys(mismatched).length > 0) {
                            lines.push("Расхождения (ссылка в БД ≠ ссылка(и) в посте):");
                            for (const [agentId, m] of Object.entries(mismatched)) {
                                lines.push(`  ${agentId}: БД=${m.dbLink} пост=[${m.postLinks.join(", ") || "нет ссылок"}]`);
                            }
                        }
                        if (Object.keys(verifyErrors).length > 0) {
                            lines.push("Ошибки проверки:");
                            for (const [agentId, err] of Object.entries(verifyErrors)) lines.push(`  ${agentId}: ${err}`);
                        }

                        return { text: lines.join("\n"), matched, mismatched, verifyErrors };
                    }

                    const { retryPendingOnly } = params;
                    const now = Math.floor(Date.now() / 1000);
                    const created: Record<string, string> = {};
                    const createErrors: Record<string, string> = {};

                    if (retryPendingOnly) {
                        // Повтор: ссылки уже есть в реестре, шаг создания не выполняется.
                        for (const row of listPendingPostUpdates(FUNNEL_ADMIN_AGENT_ID)) {
                            created[row.agentId] = row.inviteLink;
                        }
                    } else {
                        if (!params.agentIds || params.agentIds.length === 0) {
                            throw new Error("agentIds обязателен, если retryPendingOnly не задан");
                        }
                        // Шаг 1 — создать ссылки от имени REPORT_AGENT_ID, сохранить под
                        // FUNNEL_ADMIN_AGENT_ID (владелец платформенных данных).
                        tg.loadAccount(REPORT_AGENT_ID);
                        for (const agentId of params.agentIds) {
                            try {
                                const { link } = await tg.exportChatInvite(FUNNEL_PRIVATE_CHANNEL_ID, { title: agentId });
                                upsertPrivateInviteLink(FUNNEL_ADMIN_AGENT_ID, agentId, link, now);
                                created[agentId] = link;
                                log.info(`[tg_private_invite_links] link created for agent=${agentId}: ${link}`);
                            } catch (err: any) {
                                const message = err.message ?? String(err);
                                createErrors[agentId] = message;
                                log.warn(`[tg_private_invite_links] link creation failed for agent=${agentId}: ${message}`);
                            }
                        }
                    }

                    // Шаг 2 — от имени каждого целевого агента вставить его ссылку в его
                    // собственный пост. Общий для обоих режимов — created уже заполнен либо
                    // свежесозданными, либо взятыми из реестра ссылками.
                    const inserted: string[] = [];
                    const insertSkipped: Record<string, string> = {};
                    for (const agentId of Object.keys(created)) {
                        try {
                            tg.loadAccount(agentId);
                            const res = await tg.updatePersonalChannelPostLink(created[agentId]);
                            if (res.ok) {
                                inserted.push(agentId);
                                markPostUpdated(FUNNEL_ADMIN_AGENT_ID, agentId);
                                log.info(`[tg_private_invite_links] post updated for agent=${agentId}`);
                            } else {
                                insertSkipped[agentId] = res.reason;
                                log.warn(`[tg_private_invite_links] post not updated for agent=${agentId}: ${res.reason}`);
                            }
                        } catch (err: any) {
                            const message = err.message ?? String(err);
                            insertSkipped[agentId] = message;
                            log.warn(`[tg_private_invite_links] post update failed for agent=${agentId}: ${message}`);
                        }
                    }

                    const lines: string[] = [];
                    if (retryPendingOnly) {
                        lines.push(`Повтор для агентов с post_updated=0: ${Object.keys(created).length}`);
                    } else {
                        lines.push(`Ссылки созданы: ${Object.keys(created).length}/${params.agentIds!.length}`);
                    }
                    lines.push(`Вставлены в пост: ${inserted.length}/${Object.keys(created).length}`);
                    if (Object.keys(createErrors).length > 0) {
                        lines.push("Ошибки создания ссылки:");
                        for (const [agentId, err] of Object.entries(createErrors)) lines.push(`  ${agentId}: ${err}`);
                    }
                    if (Object.keys(insertSkipped).length > 0) {
                        lines.push("Не вставлено в пост (post_updated остаётся 0):");
                        for (const [agentId, reason] of Object.entries(insertSkipped)) lines.push(`  ${agentId}: ${reason}`);
                    }

                    return { text: lines.join("\n"), created, inserted, createErrors, insertSkipped };
                }),
        });

        // ── tg_channel_cleanup ────────────────────────────────────────

        reg({
            name: "tg_channel_cleanup",
            description:
                "Выходит из каналов с низким avg_views и/или subs_count у указанных агентов " +
                "и удаляет все рабочие данные по ним из всех БД. " +
                "Хотя бы один из minSubsCount или minAvgViews обязателен. " +
                "NULL-значения считаются нулём. Фильтры комбинируются по AND.",
            parameters: Type.Object({
                agents: Type.Array(Type.String(), { description: "Список agentId" }),
                minSubsCount: Type.Optional(Type.Number({ description: "Чистить если subs_count < N (NULL = 0)" })),
                minAvgViews: Type.Optional(Type.Number({ description: "Чистить если avg_views < N (NULL = 0)" })),
            }),
            execute: (_id: string, params: ChannelCleanupParams) =>
                run("tg_channel_cleanup", async () => {
                    if (params.minSubsCount === undefined && params.minAvgViews === undefined) {
                        throw new Error("Нужен хотя бы один из параметров: minSubsCount или minAvgViews");
                    }
                    return runChannelCleanup(params, tg, log);
                }),
        });

        // ── tg_agent_autoregistration_run ───────────────────────────────

        reg({
            name: "tg_agent_autoregistration_run",
            description:
                "Массовая автоматическая регистрация Telegram-агентов из готовых tdata-сессий. " +
                "Один вызов обрабатывает всю пачку последовательно и детерминированно (без " +
                "пошагового диалога) — подбирает мобильный прокси, готовит аккаунт (2FA, очистка " +
                "прежних фото/каналов, профиль, канал персоны), регистрирует вторую MTProto-сессию, " +
                "переносит готовый агент в workspace-agent<N>. Возвращает статус по каждому аккаунту: " +
                "done / proxy_failed / setup_failed / needs_manual_code.",
            parameters: Type.Object({
                megaLinks: Type.Array(Type.String(), { description: "Ссылки на tdata-архивы в Mega, одна на аккаунт" }),
                startAgentNumber: Type.Number({ description: "Номер первого создаваемого агента (agent<N>)" }),
                proxyRegion: Type.String({ description: "Регион мобильного прокси для asocks" }),
                maxProxyAttempts: Type.Number({ description: "Максимум попыток подбора прокси на аккаунт" }),
                personName: Type.String({ description: "Имя персоны — шаблон в ~/.openclaw/tg-agent-autoregistration/templates/<personName>/" }),
            }),
            execute: (
                _id: string,
                params: { megaLinks: string[]; startAgentNumber: number; proxyRegion: string; maxProxyAttempts: number; personName: string },
            ) =>
                run("tg_agent_autoregistration_run", async () => {
                    const report = await runAutoregistration(params, log);
                    return { text: renderAutoregistrationReport(report), results: report.results, abortReason: report.abortReason };
                }),
        });

        // ── tg_agent_autoregistration_retry_code ────────────────────────

        reg({
            name: "tg_agent_autoregistration_retry_code",
            description:
                "Повторяет только регистрацию второй (агентской) MTProto-сессии для аккаунта, " +
                "застрявшего в статусе needs_manual_code после tg_agent_autoregistration_run — " +
                "БЕЗ повторной подготовки аккаунта (2FA/сессии/профиль/канал уже применены, " +
                "повторно не трогаются). Требует, чтобы запись в стейджинге всё ещё была needs_manual_code.",
            parameters: Type.Object({
                agentId: Type.String({ description: "agentId аккаунта в стейджинге, например agent220" }),
                personName: Type.String({ description: "Та же персона, что использовалась при первом прогоне" }),
                proxyRegion: Type.String({ description: "Регион мобильного прокси для asocks" }),
                maxProxyAttempts: Type.Number({ description: "Максимум попыток подбора прокси" }),
            }),
            execute: (
                _id: string,
                params: { agentId: string; personName: string; proxyRegion: string; maxProxyAttempts: number },
            ) =>
                run("tg_agent_autoregistration_retry_code", () =>
                    retryManualCode(params.agentId, params.personName, params.proxyRegion, params.maxProxyAttempts, log),
                ),
        });

        // ── tg_agent_reauth_from_tdata ───────────────────────────────────

        reg({
            name: "tg_agent_reauth_from_tdata",
            description:
                "Реавторизует УЖЕ СУЩЕСТВУЮЩЕГО агента новой MTProto-сессией, используя его " +
                "tdata-сессию (~/.openclaw/workspace-<agentId>/tdata/, должна быть загружена туда " +
                "заранее). В отличие от tg_agent_autoregistration_run — ничего не меняет в профиле, " +
                "фото, каналах и 2FA агента, только выпускает новую sessionString и перезаписывает " +
                "её в tg-account.json. Код авторизации перехватывается автоматически через tdata, " +
                "оператор его не вводит. Возвращает kind: done / agent_not_found / tdata_missing / " +
                "connect_failed / code_timeout / password_rejected / error.",
            parameters: Type.Object({
                agentId: Type.String({ description: "agentId существующего агента, например agent207" }),
                password2fa: Type.Optional(Type.String({
                    description: "2FA-пароль аккаунта. Если не передан — используется пароль шаблона персоны maria по умолчанию",
                })),
            }),
            execute: (_id: string, params: { agentId: string; password2fa?: string }) =>
                run("tg_agent_reauth_from_tdata", () => reauthFromTdata(params.agentId, params.password2fa, log)),
        });
    },
});
