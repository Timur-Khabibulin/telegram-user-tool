// skills/join-queue.ts — runJoinQueue (портирование skills/join-queue-run/SKILL.md).
//
// Периодическая задача: на каждом прогоне обрабатывает один батч очереди
// вступления. Пустая очередь — не повод выключать задачу: discovery пополняет
// её асинхронно, поэтому задача остаётся активной и просто завершает прогон
// вхолостую, чтобы подхватить новые каналы на следующем тике.

import type { SkillContext, SkillStatus } from "./types";
import { getJoinQueueBatch, updateJoinQueue } from "../core/db/join-queue";
import { recordAccountError } from "../core/db/error-log";
import { upsertChannelIdentityFromJoin } from "../core/db/channels";
import { classifyDefaultBannedRights } from "../core/write-access";
import { randomBetween } from "./util";

const BATCH_LIMIT_MIN = 5;
const BATCH_LIMIT_MAX = 20;

/**
 * Теги ошибок join-контекста (telegram-error-handling, №13-20, 22-23), при
 * которых строка очереди получает `status='error'` — постоянная причина
 * отказа, не зависящая от повторных попыток. `USER_BANNED_IN_CHANNEL` (№23)
 * в контексте вступления остаётся на этой же общей ветке, без выделения.
 * `channels_too_much` (№21) сюда намеренно не входит — см. отдельную ветку
 * ниже (асимметрия с `users_too_much` подтверждена доком).
 * `user_already_participant` тоже намеренно не входит (channel-not-found-
 * recovery) — `joinDiscussionGroups` трактует его как успех (self-heal),
 * поэтому сюда он больше не долетает как ошибка.
 */
const JOIN_ERROR_TAGS = new Set([
    "username_not_occupied",
    "username_invalid",
    "channel_private",
    "channel_invalid",
    "invite_request_sent",
    "invite_hash_expired",
    "invite_hash_invalid",
    "users_too_much",
    "user_banned_in_channel",
]);

export async function runJoinQueue(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, tg, log } = ctx;

    // Шаг 1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // Шаг 2 — Взять батч из очереди (случайный размер на прогон, human-pacing)
    const batchLimit = Math.round(randomBetween(BATCH_LIMIT_MIN, BATCH_LIMIT_MAX));
    const { links } = getJoinQueueBatch(agentId, log, batchLimit);

    // Пустой батч → очередь пуста на этот момент. Задачу НЕ выключаем —
    // discovery пополнит очередь позже, подхватим на следующем тике.
    if (links.length === 0) {
        log.info("[join-queue] queue empty — nothing to join this run");
        return { status: "success", details: { reason: "queue_empty" } };
    }

    // Шаг 3 — Обработать батч целиком (инструмент сам делает паузы и FLOOD_WAIT-ретраи)
    const summary = await tg.joinDiscussionGroups(links);

    // 3.1 — Обновить статусы по results. Флуд определяется по структурному признаку
    // (ссылка есть в summary.floodWaits), не по тексту reason — сырой текст GramJS
    // ("A wait of N seconds is required...") никогда не содержит подстроку
    // "FLOOD_WAIT" (см. openspec change flood-wait-detection, Why).
    for (const result of summary.results) {
        if (result.status === "joined") {
            if (result.identity) {
                // channel-write-access (§4.1): постоянную величину права записи
                // классифицируем при вступлении и пишем перезаписью (успешный join
                // заново снимает залипшую причину).
                const writeAccessReason = classifyDefaultBannedRights(result.identity.defaultBannedSendMessages);
                upsertChannelIdentityFromJoin(agentId, result.identity, writeAccessReason, log);
            }
            updateJoinQueue(agentId, result.link, "joined", undefined, log);
            continue;
        }

        const isFloodWait = summary.floodWaits.some((fw) => fw.link === result.link);
        if (isFloodWait) {
            // Флуд, исчерпавший повторы — временная причина отказа, не
            // постоянная (telegram-error-handling №9).
            updateJoinQueue(agentId, result.link, "skipped", result.reason, log);
            continue;
        }

        if (result.reason === "channels_too_much") {
            // Лимит подписок аккаунта (№21) — временная причина, асимметрично
            // users_too_much (error), подтверждено доком.
            updateJoinQueue(agentId, result.link, "skipped", result.reason, log);
            recordAccountError(agentId, "join-queue", "CHANNELS_TOO_MUCH");
            continue;
        }

        if (result.reason && JOIN_ERROR_TAGS.has(result.reason)) {
            updateJoinQueue(agentId, result.link, "error", result.reason, log);
            continue;
        }

        // Не классифицированная причина (внутренняя — приватная инвайт-ссылка,
        // нет группы обсуждения и т.п. — или неизвестная ошибка Telegram):
        // постоянная причина отказа по умолчанию — вне каталога
        // telegram-errors.md, новую временную категорию не изобретаем.
        updateJoinQueue(agentId, result.link, "error", result.reason, log);
    }

    // 3.2 — При FLOOD_WAIT завершить прогон (следующий батч — на следующем запуске)
    return {
        status: "success",
        details: {
            claimed: links.length,
            joined: summary.joined,
            skipped: summary.skipped,
            hadFloodWait: summary.hadFloodWait,
            floodWaits: summary.floodWaits,
        },
    };
}
