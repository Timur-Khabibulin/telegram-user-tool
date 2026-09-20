// features/funnel/funnel-collect.ts — общее ядро сбора метрик воронки (funnel-tracking).
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
//
// funnel-tracking v3: перед сбором отфильтровываются неактивные агенты (нет ни
// enabled monitor любой версии, ни enabled account-warmup — см. isAgentActive) —
// см. docs/design/funnel-tracking/architecture-v3.md.

import * as fs from "fs";
import Database from "better-sqlite3";

import { listAgentIds, repliesDbPath, REPORT_AGENT_ID, buildPersonaIndex } from "../../core/config";
import { getChannelSendBreakdown } from "../../core/db/replies";
import { isAgentActive } from "../../core/db/tasks";
import { listPrivateInviteLinks } from "../../core/db/private-invites";
import { startOfUtcPlus5Day, type DayWindow } from "./runs-summary";
import type { TelegramService } from "../../core/telegram/service";
import type { Logger } from "../../core/logger";
import {
    getPreviousSnapshot,
    hasSnapshotForDay,
    insertSnapshot,
    upsertDailyStats,
    type SnapshotRow,
} from "../../core/db/funnel";
import {
    countChannels,
    countVisitsToday,
    countSendErrorsToday,
    groupSendErrorsByCode,
    problemChannels,
    sumAvgViewsForRepliedChannels,
    getChatTitlesAndUsernames,
    getActivityPercentilesByChatIds,
    buildChannelUrl,
    countChannelsBannedInWindow,
    countChannelsSuspendedInWindow,
    type SendErrorBreakdownRow,
    type ProblemChannelRow,
} from "../../core/db/channels";
import { listRestrictionsSince, getActiveRestriction, type RestrictionType } from "../../core/db/agent-restrictions";

// ─── Types ────────────────────────────────────────────────────────────

/** Разбивка отправленных сообщений по каналам за день (funnel-tracking v3, US-5). */
export interface ChannelSendBreakdownRow {
    chatId: string;
    title: string;
    url: string | null;
    /** Ссылка на привязанный канал (t.me/<username>) — без адреса на конкретное
     *  сообщение, id сообщений группы обсуждения и канала не совпадают. Null,
     *  если канал не резолвлен/не имеет username. */
    channelUrl: string | null;
    msgCount: number;
    /** p50/p90 уникальных отправителей сообщений в сутки за 7 дней (channel-activity-percentiles).
     *  null — ещё не посчитано (activity_updated_at не задан). */
    activeWritersP50: number | null;
    activeWritersP90: number | null;
}

export interface AgentFunnelRow {
    agentId: string;
    // ── Этапы 1-4 (локальные БД агента) ──
    /** Этап 1: всего каналов у агента. */
    channelsTotal: number;
    /** Этап 2: каналов просмотрено за день (любой визит монитора). */
    channelsVisited: number;
    /** Этап 3: каналов с активностью за день (visit outcome='active'). */
    channelsActive: number;
    /** Этап 4: сообщений отправлено за день (ответы в группах) — внутренний
     *  подсчёт для `daily_stats.group_replies` (читает скилл `funnel-stats`),
     *  в отчёте воронки не отображается (funnel-tracking v3, US-2). */
    groupReplies: number;
    /** Этап 4: каналов, куда отправлено хотя бы одно сообщение за день —
     *  показатель отчёта воронки (funnel-tracking v3, US-2), заменяет счёт сообщений. */
    channelsWithSending: number;
    /** Разбивка сообщений по каналам за день (funnel-tracking v3, US-5, только CSV). */
    channelBreakdown: ChannelSendBreakdownRow[];
    /** Этап 4: ошибок отправки за день (monitor + dm-send). */
    sendErrors: number;
    /** Число каналов, у которых `status='banned'` появился за отчётные сутки (funnel-report-restrictions). */
    channelsBannedToday: number;
    /** Число каналов, у которых `status='suspend'` появился за отчётные сутки (channel-suspend-on-deletion). */
    channelsSuspendedToday: number;
    /** Этап 4: потенциальный охват — SUM(avg_views) каналов с ответами за день. */
    potentialReach: number;
    /** Этап 4: разбивка ошибок отправки агента по типу (для слияния в отчёте). */
    errorBreakdown: SendErrorBreakdownRow[];
    /** Этапы 3-4: проблемные каналы агента за день (для списка в отчёте). */
    problemChannels: ProblemChannelRow[];
    // ── Этапы 5-7 (MTProto) ──
    postViewsAbs: number | null;
    postViewsDelta: number | null;
    publicSubsAbs: number | null;
    publicSubsDelta: number | null;
    /** Этап 7: заявки в приватный канал по персональной ссылке агента
     *  (funnel-tracking v3, US-3). null — нет настроенной ссылки, не 0. */
    privateRequestsAbs: number | null;
    privateRequestsDelta: number | null;
    /** Пометка о пропуске сбора этапов 1-4 (локальные БД недоступны). */
    note1to4?: string;
    /** Пометка о пропуске сбора этапов 5-7 (нет канала в профиле, MTProto-ошибка). */
    note5to7?: string;
    /** Персона агента (значение AccountConfig.persona) — null, если не определена. Только для CSV-отчёта. */
    persona: string | null;
    /** Активное ограничение агента на момент сбора (agent-restrictions), null — не ограничен. */
    restrictionType: RestrictionType | null;
}

/** Агент, получивший ограничение за отчётные сутки (funnel-report-restrictions). */
export interface RestrictedAgentRow {
    agentId: string;
    restrictionType: RestrictionType;
}

export interface FunnelResult {
    window: DayWindow;
    agents: AgentFunnelRow[];
    privateRequestsAbs: number | null;
    privateRequestsDelta: number | null;
    /** Пометка, если заявки недоступны (нет прав / не задан приватный канал). */
    privateNote?: string;
    /** Агенты, которым за отчётные сутки наложено ограничение (`agent_restrictions.restricted_at` в окне). */
    restrictedAgents: RestrictedAgentRow[];
}

export interface CollectOptions {
    window: DayWindow;
    persist: boolean;
    adminAgentId: string;
    privateChannelId?: string;
    /**
     * Рвать MTProto-соединение каждого агента сразу после сбора его этапов 5-7,
     * с паузой перед снятием замка (TelegramService.disconnectAgent). Для
     * таймерного скрипта funnel-tracker, который обходит все сессии подряд одним
     * процессом: без этого клиенты копятся открытыми до финального disconnect()
     * (обрезается таймаутом, освобождает 1-2 сессии из десятков) и создают риск
     * AUTH_KEY_DUPLICATED при следующем heartbeat тех же агентов. Пауза между
     * disconnect и следующим агентом заодно разносит подключения во времени.
     * Плагин-гейтвей (persist=false) НЕ выставляет флаг — он переиспользует один
     * общий долгоживущий клиент и рвать его между агентами нельзя.
     */
    disconnectAfterEachAgent?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** COUNT строк `replies` по `sentAt` в полуинтервале [startSec, endSec). */
function countSince(dbPath: string, startSec: number, endSec: number): number {
    if (!fs.existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readonly: true });
    try {
        const row = db
            .prepare(`SELECT COUNT(*) AS c FROM replies WHERE sentAt >= ? AND sentAt < ?`)
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

/**
 * Верхняя граница на этапы 5-7 одного агента (2026-07-05: agent4 завис внутри
 * MTProto-вызова без ошибки и без внутреннего таймаута GramJS, что заблокировало
 * весь прогон на 30 мин до убийства systemd — отчёт за день потерялся целиком).
 * ensureClient сам укладывается в ~45с (3 попытки × 15с), остальное — быстрые вызовы;
 * 60с — запас без риска обрубить здоровый агент.
 */
const AGENT_STAGES_5_TO_7_TIMEOUT_MS = 60_000;

/**
 * Промис гонки с таймаутом: если promise не успел за ms — reject с понятным
 * сообщением. Проигравший promise после гонки не отменяется (GramJS/сетевые
 * промисы нельзя прервать) и может зарезолвиться или зареджектиться значительно
 * позже — .catch-заглушка гасит его, иначе необработанный reject уронит весь
 * процесс (Node — unhandledRejection по умолчанию фатален), см. coding-standards.md §8.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
        promise.catch(() => {});
    }
}

// ─── Сбор ─────────────────────────────────────────────────────────────

export async function collectFunnel(
    tg: TelegramService,
    opts: CollectOptions,
    log: Logger,
): Promise<FunnelResult> {
    const { window, persist, adminAgentId, privateChannelId, disconnectAfterEachAgent } = opts;
    const nowSec = Math.floor(Date.now() / 1000);
    const guardDayStart = startOfUtcPlus5Day(nowSec);

    const result: FunnelResult = {
        window,
        agents: [],
        privateRequestsAbs: null,
        privateRequestsDelta: null,
        restrictedAgents: [],
    };

    // ── Фильтр активных агентов (US-4) — до всех остальных шагов: неактивный
    // агент не тратит на себя ни МТProto-, ни БД-обращений дальше. ──
    const activeAgentIds = listAgentIds().filter(isAgentActive);

    // ── Заявки в приватный канал: по персональной ссылке каждого агента (US-3) ──
    // REPORT_AGENT_ID — администратор приватного канала (report-agent-isolation).
    // Один tg.loadAccount на весь цикл ссылок, не на каждый запрос. Агент без
    // записи в private_invite_links не попадает в links — MTProto-запрос для
    // него не делается.
    //
    // Фильтр — по listAgentIds() (реально существующие агенты), а НЕ по
    // activeAgentIds: человек кликает по персональной ссылке агента в его
    // закреплённом посте независимо от того, включён ли у агента monitor
    // (любой версии) прямо сейчас. Раньше фильтровали по activeAgentIds — заявки
    // агентов с выключенным мониторингом молча выпадали из суммы (баг,
    // обнаружен 2026-07-30: отчёт показывал 32 вместо реальных 58 заявок).
    const links = new Map(
        listPrivateInviteLinks(adminAgentId)
            .filter((r) => listAgentIds().includes(r.agentId))
            .map((r) => [r.agentId, r.inviteLink]),
    );
    const privateAbsByAgent = new Map<string, number>();

    if (privateChannelId && links.size > 0) {
        tg.loadAccount(REPORT_AGENT_ID);
        for (const [agentId, link] of links) {
            try {
                const pr = await withTimeout(
                    tg.getPendingJoinRequests(privateChannelId, { link }),
                    AGENT_STAGES_5_TO_7_TIMEOUT_MS,
                    `private channel requests for agent=${agentId}`,
                );
                if ("error" in pr) {
                    result.privateNote = "недоступно (нет прав invite_users)";
                } else {
                    privateAbsByAgent.set(agentId, pr.count);
                }
            } catch (err: any) {
                log.warn(
                    `[funnel-collect] private requests for agent=${agentId} failed: ${err.message ?? err}`,
                );
            }
        }
    }

    // ── Ограничения агентов за отчётные сутки (telegram-error-handling) ──
    // Платформенная БД (не per-agent) — считается один раз вне цикла по агентам,
    // без фильтрации по activeAgentIds (ограничение — платформенный факт).
    result.restrictedAgents = listRestrictionsSince(adminAgentId, window.startSec, window.endSec).map((r) => ({
        agentId: r.agentId,
        restrictionType: r.restriction_type,
    }));

    const personaIndex = buildPersonaIndex();
    for (const agentId of activeAgentIds) {
        const row: AgentFunnelRow = {
            agentId,
            channelsTotal: 0,
            channelsVisited: 0,
            channelsActive: 0,
            groupReplies: 0,
            channelsWithSending: 0,
            channelBreakdown: [],
            sendErrors: 0,
            channelsBannedToday: 0,
            channelsSuspendedToday: 0,
            potentialReach: 0,
            errorBreakdown: [],
            problemChannels: [],
            postViewsAbs: null,
            postViewsDelta: null,
            publicSubsAbs: null,
            publicSubsDelta: null,
            privateRequestsAbs: null,
            privateRequestsDelta: null,
            persona: personaIndex.get(agentId) ?? null,
            restrictionType: null,
        };

        // ── Этапы 1-4: локальные БД агента (без сети) ──
        // Изолированы от MTProto-блока: блокировка/сбой tg-channels.db не должен
        // терять собранные ниже данные охвата, и наоборот.
        try {
            row.channelsTotal = countChannels(agentId);
            const visits = countVisitsToday(agentId, window.startSec, window.endSec);
            row.channelsVisited = visits.visited;
            row.channelsActive = visits.active;
            row.groupReplies = countSince(repliesDbPath(agentId), window.startSec, window.endSec);

            const breakdown = getChannelSendBreakdown(agentId, window.startSec, window.endSec);
            row.channelsWithSending = breakdown.length;
            const chatIds = breakdown.map((b) => b.chatId);
            row.potentialReach = sumAvgViewsForRepliedChannels(agentId, chatIds);
            const chatInfo = getChatTitlesAndUsernames(agentId, chatIds);
            const activityInfo = getActivityPercentilesByChatIds(agentId, chatIds);
            row.channelBreakdown = breakdown.map((b) => {
                const info = chatInfo.get(b.chatId);
                const activity = activityInfo.get(b.chatId);
                return {
                    chatId: b.chatId,
                    title: info?.channelTitle ?? info?.title ?? b.chatId,
                    url: buildChannelUrl(b.chatId, info?.chatUsername ?? null, b.lastReplyMsgId),
                    channelUrl: info?.channelUsername ? `https://t.me/${info.channelUsername}` : null,
                    msgCount: b.msgCount,
                    activeWritersP50: activity?.p50 ?? null,
                    activeWritersP90: activity?.p90 ?? null,
                };
            });

            row.sendErrors = countSendErrorsToday(agentId, window.startSec, window.endSec);
            row.errorBreakdown = groupSendErrorsByCode(agentId, window.startSec, window.endSec);
            row.problemChannels = problemChannels(agentId, window.startSec, window.endSec);
            row.channelsBannedToday = countChannelsBannedInWindow(agentId, window.startSec, window.endSec);
            row.channelsSuspendedToday = countChannelsSuspendedInWindow(agentId, window.startSec, window.endSec);
        } catch (err: any) {
            row.note1to4 = `этапы 1-4 пропущены: ${err.message ?? err}`;
            log.warn(`[funnel-collect] agent=${agentId} stages 1-4 skipped: ${err.message ?? err}`);
        }

        // ── Заявки в приватный канал: уже получены выше через REPORT_AGENT_ID,
        // не через сессию этого агента — не должны зависеть от того, подключился
        // ли собственный прокси агента ниже (иначе значение молча теряется при
        // таймауте, хотя данные уже есть — баг funnel-tracking, обнаружен 2026-07-22).
        row.privateRequestsAbs = privateAbsByAgent.get(agentId) ?? null;
        const prevSnapshot = getPreviousSnapshot(adminAgentId, agentId);
        row.privateRequestsDelta = deltaOf(row.privateRequestsAbs, prevSnapshot?.privatePendingRequests ?? null);

        // ── Этапы 5-7: охват через MTProto ──
        // Пропуск агентов с несовместимым ограничением (stop-agent-run-reports,
        // funnel-metrics): need_update_session/banned означают, что сессия сломана
        // или аккаунт удалён/заморожен целиком — MTProto-подключение гарантированно
        // неуспешно, попытка только повторяет уже известную ошибку. suspend НЕ
        // пропускается — сессия рабочая, ограничена только отправка. Пропуск НЕ
        // считается сбоем сбора (note5to7 не устанавливается) — агент уже виден в
        // таблице ограничений CSV (result.restrictedAgents выше).
        const restriction = getActiveRestriction(adminAgentId, agentId);
        row.restrictionType = restriction?.restriction_type ?? null;
        let personal: Awaited<ReturnType<typeof tg.getOwnPersonalChannel>> | undefined;
        if (restriction && (restriction.restriction_type === "need_update_session" || restriction.restriction_type === "banned" || restriction.restriction_type === "manual_reauth")) {
            log.info(`[funnel-collect] agent=${agentId} stages 5-7 skipped: restricted (${restriction.restriction_type})`);
        } else {
            // Блок-таймаут снят (решение оператора 2026-09-18): 60с резали легитимный
            // медленный connect (бюджет ensureClient — 3×60с) и теряли метрики охвата.
            // Сам connect защищён своим таймаутом (ConnectTimeoutError после 3 попыток),
            // поэтому дохлый прокси не подвесит прогон навсегда. try/catch по-прежнему
            // изолирует сбой одного агента от остальных и от отправки отчёта.
            try {
                tg.loadAccount(agentId);
                personal = await tg.getOwnPersonalChannel();
                if (!personal) {
                    row.note5to7 = "нет канала в профиле";
                } else {
                    if (personal.postId != null) {
                        const realPostId = await tg.resolvePersonalPostId(personal.inputPeer, personal.postId);
                        if (realPostId != null) {
                            row.postViewsAbs = await tg.getPostViews(personal.inputPeer, realPostId);
                        }
                    }
                    row.publicSubsAbs = await tg.getChannelSubsCount(personal.inputChannel);
                }

                row.postViewsDelta = deltaOf(row.postViewsAbs, prevSnapshot?.postViews ?? null);
                row.publicSubsDelta = deltaOf(row.publicSubsAbs, prevSnapshot?.publicChannelSubs ?? null);
            } catch (err: any) {
                row.note5to7 = `этапы 5-7 пропущены: ${err.message ?? err}`;
                log.warn(`[funnel-collect] agent=${agentId} stages 5-7 skipped: ${err.message ?? err}`);
            }
        }

        // Снапшот — вне блока MTProto-таймаута: заявки в приватный канал уже
        // известны независимо от связи агента, их нельзя терять вместе с
        // postViews/publicSubs при сбое подключения этого конкретного агента.
        if (persist && !hasSnapshotForDay(adminAgentId, agentId, guardDayStart)) {
            const snap: SnapshotRow = {
                agentId,
                snappedAt: nowSec,
                publicChannelSubs: row.publicSubsAbs,
                postId: personal?.postId ?? null,
                postViews: row.postViewsAbs,
                privatePendingRequests: row.privateRequestsAbs,
            };
            insertSnapshot(adminAgentId, snap);
            upsertDailyStats(adminAgentId, {
                date: window.label,
                agentId,
                groupReplies: row.groupReplies,
                // DM исключены из воронки (funnel-tracking v3, US-2) — колонка
                // daily_stats.dms_sent остаётся в схеме без читателей, всегда 0.
                dmsSent: 0,
                postViewsDelta: row.postViewsDelta,
                postViewsAbs: row.postViewsAbs,
                publicSubsDelta: row.publicSubsDelta,
                publicSubsAbs: row.publicSubsAbs,
                privateRequestsDelta: row.privateRequestsDelta,
                privateRequestsAbs: row.privateRequestsAbs,
            });
        }

        // Пер-агентный teardown (см. CollectOptions.disconnectAfterEachAgent):
        // рвём соединение этого агента и держим паузу перед взятием следующего.
        // No-op, если агент был пропущен без подключения (ограничение) — метод
        // сверяет, что именно этот agentId сейчас загружен.
        if (disconnectAfterEachAgent) {
            await tg.disconnectAgent(agentId);
        }

        result.agents.push(row);
    }

    // ── Заявки: агенты со ссылкой, но не прошедшие фильтр активности (monitor
    // любой версии выключен) — не участвуют в основном цикле выше (экономия
    // MTProto на остальные метрики по-прежнему в силе), но их заявки реальны и
    // должны попасть и в платформенный итог, и в снапшот/daily_stats — иначе их
    // теряют оба потребителя (funnel-report и funnel-stats). Дельта считается
    // ДО записи сегодняшнего снапшота, иначе «предыдущий» окажется только что
    // вставленным сегодняшним же (см. тот же приём в основном цикле выше).
    const inactiveLinkedAgents = new Map<string, { abs: number; delta: number | null }>();
    for (const [agentId, abs] of privateAbsByAgent) {
        if (activeAgentIds.includes(agentId)) continue;
        const prev = getPreviousSnapshot(adminAgentId, agentId);
        const delta = deltaOf(abs, prev?.privatePendingRequests ?? null);
        inactiveLinkedAgents.set(agentId, { abs, delta });

        if (persist && !hasSnapshotForDay(adminAgentId, agentId, guardDayStart)) {
            insertSnapshot(adminAgentId, {
                agentId,
                snappedAt: nowSec,
                publicChannelSubs: null,
                postId: null,
                postViews: null,
                privatePendingRequests: abs,
            });
            upsertDailyStats(adminAgentId, {
                date: window.label,
                agentId,
                groupReplies: 0,
                dmsSent: 0,
                postViewsDelta: null,
                postViewsAbs: null,
                publicSubsDelta: null,
                publicSubsAbs: null,
                privateRequestsDelta: delta,
                privateRequestsAbs: abs,
            });
        }
    }

    // ── Платформенный итог заявок — сумма по активным агентам (result.agents) +
    // по неактивным со ссылкой (inactiveLinkedAgents); раньше считали только по
    // result.agents, поэтому итог был занижен ровно на неактивных агентов.
    if (privateChannelId && !result.privateNote) {
        let abs = result.agents.reduce((s, a) => s + (a.privateRequestsAbs ?? 0), 0);
        let delta = result.agents.reduce((s, a) => s + (a.privateRequestsDelta ?? 0), 0);
        for (const v of inactiveLinkedAgents.values()) {
            abs += v.abs;
            delta += v.delta ?? 0;
        }
        result.privateRequestsAbs = abs;
        result.privateRequestsDelta = delta;
    }

    return result;
}
