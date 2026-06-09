// core/funnel-collect.ts — общее ядро сбора метрик воронки (funnel-tracking).
//
// Используется в двух режимах на одном коде (design.md §Decisions 8):
//   • persist=true  — таймерный прогон: пишет channel_snapshots + daily_stats
//                     под защитой от двойного прогона по дню UTC+5;
//   • persist=false — запуск по требованию (инструмент tg_funnel_report): считает
//                     дельту относительно последнего сохранённого снапшота, ничего
//                     не пишет.
// Сбор по каждому агенту изолирован try/catch: сбой одного агента (сессия/прокси/
// MTProto/БД) → пропуск с пометкой, прогон остальных продолжается.
// disconnect() НЕ вызывается — это ответственность вызывающей стороны (скрипт
// рвёт соединения в finally; плагин-гейтвей переиспользует общий клиент).

import * as fs from "fs";
import Database from "better-sqlite3";

import { listAgentIds, repliesDbPath, channelsDbPath } from "./config";
import { startOfUtcPlus5Day, type DayWindow } from "./runs-summary";
import type { TelegramService } from "./telegram/service";
import type { Logger } from "./logger";
import {
    getPreviousSnapshot,
    hasSnapshotForDay,
    insertSnapshot,
    upsertDailyStats,
    type SnapshotRow,
} from "./db/funnel";

// ─── Types ────────────────────────────────────────────────────────────

export interface AgentFunnelRow {
    agentId: string;
    groupReplies: number;
    dmsSent: number;
    postViewsAbs: number | null;
    postViewsDelta: number | null;
    publicSubsAbs: number | null;
    publicSubsDelta: number | null;
    /** Пометка о пропуске/частичном сборе (нет канала в профиле, ошибка и т.п.). */
    note?: string;
}

export interface FunnelResult {
    window: DayWindow;
    agents: AgentFunnelRow[];
    privateRequestsAbs: number | null;
    privateRequestsDelta: number | null;
    /** Пометка, если заявки недоступны (нет прав / не задан приватный канал). */
    privateNote?: string;
}

export interface CollectOptions {
    window: DayWindow;
    persist: boolean;
    adminAgentId: string;
    privateChannelId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** COUNT строк таблицы по `sentAt` в полуинтервале [startSec, endSec). */
function countSince(dbPath: string, table: "replies" | "dm_history", startSec: number, endSec: number): number {
    if (!fs.existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readonly: true });
    try {
        const row = db
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE sentAt >= ? AND sentAt < ?`)
            .get(startSec, endSec) as { c: number };
        return row.c;
    } catch {
        // Таблица ещё не создана (агент не запускал соответствующий скилл) → 0.
        return 0;
    } finally {
        db.close();
    }
}

function deltaOf(cur: number | null, prev: number | null): number | null {
    if (cur == null || prev == null) return null;
    return cur - prev;
}

// ─── Сбор ─────────────────────────────────────────────────────────────

export async function collectFunnel(
    tg: TelegramService,
    opts: CollectOptions,
    log: Logger,
): Promise<FunnelResult> {
    const { window, persist, adminAgentId, privateChannelId } = opts;
    const nowSec = Math.floor(Date.now() / 1000);
    const guardDayStart = startOfUtcPlus5Day(nowSec);

    const result: FunnelResult = {
        window,
        agents: [],
        privateRequestsAbs: null,
        privateRequestsDelta: null,
    };

    for (const agentId of listAgentIds()) {
        const row: AgentFunnelRow = {
            agentId,
            groupReplies: 0,
            dmsSent: 0,
            postViewsAbs: null,
            postViewsDelta: null,
            publicSubsAbs: null,
            publicSubsDelta: null,
        };

        try {
            // Активность — из per-agent БД (разные файлы: tg-replies.db, tg-channels.db).
            row.groupReplies = countSince(repliesDbPath(agentId), "replies", window.startSec, window.endSec);
            row.dmsSent = countSince(channelsDbPath(agentId), "dm_history", window.startSec, window.endSec);

            // Охват — через MTProto аккаунта агента.
            tg.loadAccount(agentId);
            const personal = await tg.getOwnPersonalChannel();
            if (!personal) {
                row.note = "нет канала в профиле";
            } else {
                if (personal.postId != null) {
                    row.postViewsAbs = await tg.getPostViews(personal.inputPeer, personal.postId);
                }
                row.publicSubsAbs = await tg.getChannelSubsCount(personal.inputChannel);
            }

            // Заявки в приватный канал — только админ-агент (agent1).
            let privateAbs: number | null = null;
            if (agentId === adminAgentId && privateChannelId) {
                const pr = await tg.getPendingJoinRequests(privateChannelId);
                if ("error" in pr) {
                    result.privateNote = "недоступно (нет прав invite_users)";
                } else {
                    privateAbs = pr.count;
                    result.privateRequestsAbs = privateAbs;
                }
            }

            // Дельты относительно последнего сохранённого снапшота.
            const prev = getPreviousSnapshot(adminAgentId, agentId);
            row.postViewsDelta = deltaOf(row.postViewsAbs, prev?.postViews ?? null);
            row.publicSubsDelta = deltaOf(row.publicSubsAbs, prev?.publicChannelSubs ?? null);
            if (agentId === adminAgentId) {
                result.privateRequestsDelta = deltaOf(privateAbs, prev?.privatePendingRequests ?? null);
            }

            // Запись — только в режиме persist и не чаще раза в день UTC+5.
            if (persist && !hasSnapshotForDay(adminAgentId, agentId, guardDayStart)) {
                const snap: SnapshotRow = {
                    agentId,
                    snappedAt: nowSec,
                    publicChannelSubs: row.publicSubsAbs,
                    postId: personal?.postId ?? null,
                    postViews: row.postViewsAbs,
                    privatePendingRequests: agentId === adminAgentId ? privateAbs : null,
                };
                insertSnapshot(adminAgentId, snap);
                upsertDailyStats(adminAgentId, {
                    date: window.label,
                    agentId,
                    groupReplies: row.groupReplies,
                    dmsSent: row.dmsSent,
                    postViewsDelta: row.postViewsDelta,
                    postViewsAbs: row.postViewsAbs,
                    publicSubsDelta: row.publicSubsDelta,
                    publicSubsAbs: row.publicSubsAbs,
                    privateRequestsDelta: agentId === adminAgentId ? result.privateRequestsDelta : null,
                    privateRequestsAbs: agentId === adminAgentId ? privateAbs : null,
                });
            }
        } catch (err: any) {
            row.note = `пропущен: ${err.message ?? err}`;
            log.warn(`[funnel-collect] agent=${agentId} skipped: ${err.message ?? err}`);
        }

        result.agents.push(row);
    }

    return result;
}
