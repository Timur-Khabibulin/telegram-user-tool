// skills/leave-banned-channels.ts — runLeaveBannedChannels (leave-banned-human-pacing).
//
// Обрабатывает очередь каналов на выход (channels.status IN ('banned',
// 'should_leave')): 'banned' — монитор поймал CHAT_WRITE_FORBIDDEN,
// 'should_leave' — оператор вручную решил, что канал агенту больше не нужен.
// Для каждого: опционально читает несколько батчей сообщений (человекоподобный
// след перед выходом), выходит из канала, чистит dm_candidates и сбрасывает
// статус. Пометка реестра discovery убрана (механизм бан/переназначение
// упразднён) — реестр этот скилл больше не трогает.
//
// Порядок важен: выход РАНЬШЕ чистки данных — иначе syncChannels вернёт канал
// из диалогов. Если выход не удался — данные и статус не трогаем, канал
// остаётся в очереди (повтор на следующем прогоне).

import type { SkillContext, SkillStatus } from "./types";
import { ClientNotConnectedError } from "../core/telegram/errors";
import {
    getLeaveQueue,
    setLeftChannelStatus,
    purgeChannelData,
} from "../core/db/channels";
import { sleepRandom, randomBetween } from "./util";
import {
    LEAVE_BANNED_BATCH_LIMIT,
    LEAVE_BANNED_PRE_LEAVE_DELAY_MIN_SEC,
    LEAVE_BANNED_PRE_LEAVE_DELAY_MAX_SEC,
    LEAVE_BANNED_CHANNEL_DELAY_MIN_SEC,
    LEAVE_BANNED_CHANNEL_DELAY_MAX_SEC,
    LEAVE_BANNED_READ_GATE_PROBABILITY,
    LEAVE_BANNED_READ_BATCHES_MIN,
    LEAVE_BANNED_READ_BATCHES_MAX,
    LEAVE_BANNED_MSG_BATCH_MIN,
    LEAVE_BANNED_MSG_BATCH_MAX,
    LEAVE_BANNED_MSG_BATCH_DELAY_MIN_SEC,
    LEAVE_BANNED_MSG_BATCH_DELAY_MAX_SEC,
} from "../core/config";

/**
 * Опциональное чтение 1-3 батчей сообщений перед выходом (человекоподобный
 * след трафика, design.md Decision 4). Курсор растёт между батчами
 * (`reverse: true` — минимальный курсор одного вызова становится нижней
 * границей следующего), иначе повторные вызовы вернули бы один и тот же срез
 * новых сообщений. Best-effort: любая ошибка, кроме ClientNotConnectedError,
 * просто прерывает чтение — это необязательный шаг, не должен ронять весь
 * прогон.
 */
async function maybeReadBeforeLeave(ctx: SkillContext, chatId: string): Promise<void> {
    const { tg, log } = ctx;
    if (Math.random() >= LEAVE_BANNED_READ_GATE_PROBABILITY) return;

    const batches = Math.round(randomBetween(LEAVE_BANNED_READ_BATCHES_MIN, LEAVE_BANNED_READ_BATCHES_MAX));
    let cursor = 0;
    try {
        for (let i = 0; i < batches; i++) {
            const batchSize = Math.round(randomBetween(LEAVE_BANNED_MSG_BATCH_MIN, LEAVE_BANNED_MSG_BATCH_MAX));
            const { messages } = await tg.getMessages(chatId, cursor, batchSize, { reverse: true });
            if (messages.length === 0) break;

            const maxId = Math.max(...messages.map((m) => m.id));
            await tg.markAsRead(chatId, maxId);
            cursor = maxId;

            if (i < batches - 1) {
                await sleepRandom(LEAVE_BANNED_MSG_BATCH_DELAY_MIN_SEC, LEAVE_BANNED_MSG_BATCH_DELAY_MAX_SEC);
            }
        }
    } catch (err: any) {
        if (err instanceof ClientNotConnectedError) throw err;
        log.warn(`[leave-banned] optional read before leave failed chatId=${chatId}, continuing to leave: ${err.message ?? err}`);
    }
}

export async function runLeaveBannedChannels(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, tg, log } = ctx;

    // Шаг 1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // Шаг 2 — Очередь каналов на выход (status IN ('banned', 'should_leave'))
    const queue = getLeaveQueue(agentId, log, LEAVE_BANNED_BATCH_LIMIT);
    if (queue.length === 0) {
        return { status: "success", details: { reason: "queue_empty" } };
    }

    // Шаг 3 — Заполнить peerCache (нужен для leaveChannel/resolve по chatId).
    // getDialogs() не годится — берёт только первые 200 диалогов (service.ts
    // ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ), а каналы в очереди на выход — давно неактивные
    // (banned/should_leave), почти всегда вне этого окна: peer не находился
    // никогда, leaveChannel падал на каждом канале с "No channel InputPeer
    // cached", канал так и оставался в очереди навсегда. populatePeerCacheForIds
    // ищет конкретные chatId без потолка в 200 — тот же приём, что уже
    // использует monitor-v3/monitor-v4 для того же случая.
    await tg.populatePeerCacheForIds(queue.map((q) => q.chatId));

    let left = 0;
    let leaveFailed = 0;

    for (let idx = 0; idx < queue.length; idx++) {
        const { chatId, status: sourceStatus } = queue[idx];

        // 3.1 — Опционально: несколько батчей чтения перед выходом (human-pacing)
        await maybeReadBeforeLeave(ctx, chatId);

        // 3.2 — Пауза перед leave (всегда, human-pacing)
        await sleepRandom(LEAVE_BANNED_PRE_LEAVE_DELAY_MIN_SEC, LEAVE_BANNED_PRE_LEAVE_DELAY_MAX_SEC);

        // 3.3 — Выход из канала
        try {
            await tg.leaveChannel(chatId);
        } catch (err: any) {
            if (err instanceof ClientNotConnectedError) throw err;
            // Не удалось выйти — не чистим, статус не трогаем, оставляем в очереди
            log.warn(`[leave-banned] leaveChannel failed chatId=${chatId}, keeping in queue: ${err.message ?? err}`);
            leaveFailed += 1;
            continue;
        }

        // 3.4 — Чистка dm_candidates агента по каналу (остальное сохраняется)
        purgeChannelData(agentId, chatId, log);

        // 3.5 — Терминальный статус канала (последним) — зависит от исходного
        // триггера очереди (leave-banned-terminal-status): 'banned' →
        // 'leaved_from_banned', 'should_leave' → 'leaved_manual'.
        setLeftChannelStatus(agentId, chatId, sourceStatus === "banned" ? "leaved_from_banned" : "leaved_manual", log);
        left += 1;

        // 3.6 — Пауза между каналами (не после последнего)
        if (idx < queue.length - 1) {
            await sleepRandom(LEAVE_BANNED_CHANNEL_DELAY_MIN_SEC, LEAVE_BANNED_CHANNEL_DELAY_MAX_SEC);
        }
    }

    return {
        status: "success",
        details: {
            "в очереди": queue.length,
            "покинуто": left,
            "выход не удался": leaveFailed,
        },
    };
}
