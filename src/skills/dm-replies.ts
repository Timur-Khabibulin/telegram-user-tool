// skills/dm-replies.ts — runDmReplies (портирование skills/dm-replies/SKILL.md).
//
// Push-модель: список личных чатов с непрочитанными → матч с dm_threads →
// продолжение диалога с полным контекстом. Работает только в дневные часы UTC+5.
// Логика, тональность и обработка ошибок перенесены один-в-один (R-B2).
//
// Примечание к 4.4: SKILL.md вызывает send_dm только с userId+text. Инструмент
// требует (chatId+msgId) или accessHash, поэтому детерминированный порт передаёт
// thread.userAccessHash (свежо обновлён в шаге 3 через dm_threads_get_by_users).

import { z } from "zod";

import type { SkillContext, SkillStatus } from "./types";
import { ClientNotConnectedError } from "../core/telegram/errors";
import { getDmThreadsByUsers, updateDmThreadMsgs, type DmThreadMessage } from "../core/db/dm-threads";
import { analyzeAndReply } from "../llm/prompts";

const GET_MESSAGES_LIMIT = 100;

interface StoredMessage {
    role: "agent" | "user";
    msgId: number;
    text: string;
    sentAt: number;
}

/** Текущий час в UTC+5 (Екатеринбург / Астана). */
function hourInUtcPlus5(): number {
    return (new Date().getUTCHours() + 5) % 24;
}

export async function runDmReplies(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, persona, tg, llm, log } = ctx;

    // Шаг 0 — Проверить время (UTC+5). Окно 08:00–01:00; вне его (01:00–08:00) — выход.
    const hour = hourInUtcPlus5();
    if (hour >= 1 && hour < 8) {
        return { status: "success", details: { reason: "outside_active_hours", hourUtcPlus5: hour } };
    }

    // Шаг 1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // Шаг 2 — DM-чаты с непрочитанными (также заполняет peerCache)
    const { dms } = await tg.getDmDialogs();
    if (dms.length === 0) {
        return { status: "success", details: { reason: "no_unread_dms" } };
    }

    // Шаг 3 — Найти треды для этих пользователей (notFound игнорируем)
    const { threads, notFound } = getDmThreadsByUsers(
        agentId,
        dms.map((d) => ({ userId: d.userId, accessHash: d.accessHash, userName: d.userName ?? undefined })),
        log,
    );
    if (threads.length === 0) {
        return { status: "success", details: { reason: "no_matching_threads", unreadDms: dms.length, notFound: notFound.length } };
    }

    let repliesSent = 0;
    let processed = 0;
    let aborted: string | null = null;

    // Шаг 4 — Обработать каждый тред
    for (const thread of threads) {
        processed += 1;

        // 4.1 — Получить новые сообщения после последнего известного msgId
        const stored = JSON.parse(thread.messages) as StoredMessage[];
        const lastMsgId = stored.length > 0 ? stored[stored.length - 1].msgId : 0;

        const { messages: newMessages } = await tg.getMessages(thread.userId, lastMsgId, GET_MESSAGES_LIMIT);
        if (newMessages.length === 0) continue;

        // SKILL.md опускает maxId в mark_as_read; помечаем прочитанным до последнего
        // полученного сообщения (точнее и безопаснее семантики maxId=0).
        const maxNewId = Math.max(...newMessages.map((m) => m.id));

        // 4.2+4.3 — Один структурированный вызов: тональность + готовый ответ с
        // полным контекстом. При negative поле `ответ` пустое (ответ не генерируется).
        const historyLines = stored.map((m) => `${m.role}: ${m.text}`).join("\n");
        const newLines = newMessages.map((m) => `${m.fromName}: ${m.text}`).join("\n");
        const analyzePrompt = analyzeAndReply(thread.triggerMessage, historyLines, newLines);
        const analysis = await llm.completeObject(
            { system: persona, prompt: analyzePrompt },
            z.object({ sentiment: z.enum(["positive", "negative"]), ответ: z.string().nullish() }),
        );

        if (analysis.sentiment === "negative" || !analysis.ответ) {
            await tg.markAsRead(thread.userId, maxNewId);
            continue; // тред не удаляется — cooldown продолжает работать
        }

        const replyText = analysis.ответ;

        // 4.4 — Отправить ответ (accessHash из треда — см. примечание в шапке файла)
        let sendResult;
        try {
            sendResult = await tg.sendDm({ userId: thread.userId, accessHash: thread.userAccessHash, text: replyText });
        } catch (err: any) {
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[dm-replies] send_dm error for userId=${thread.userId}: ${err.message ?? err}`);
            await tg.markAsRead(thread.userId, maxNewId);
            continue;
        }

        if ("error" in sendResult) {
            if (sendResult.error === "flood_wait") {
                aborted = "flood_wait";
                break; // немедленно прервать прогон
            }
            // privacy_blocked / peer_id_invalid / прочее → mark_as_read и к следующему треду
            await tg.markAsRead(thread.userId, maxNewId);
            continue;
        }

        // 4.5 — Обновить тред: все новые user-сообщения + ответ агента
        const now = Math.floor(Date.now() / 1000);
        const appended: DmThreadMessage[] = newMessages.map((m) => ({
            role: "user" as const,
            msgId: m.id,
            text: m.text,
            sentAt: m.date,
        }));
        appended.push({ role: "agent", msgId: sendResult.messageId, text: replyText, sentAt: now });
        updateDmThreadMsgs(agentId, thread.userId, appended, log);

        repliesSent += 1;

        // 4.6 — Пометить прочитанным (всегда последний шаг обработки треда)
        await tg.markAsRead(thread.userId, maxNewId);
    }

    // Шаг 5 — Итоговая статус-модель
    return {
        status: "success",
        details: {
            unreadDms: dms.length,
            matchedThreads: threads.length,
            processed,
            repliesSent,
            aborted,
        },
    };
}
