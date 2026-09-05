// skills/account-warmup.ts — runAccountWarmup (портирование skills/account-warmup/SKILL.md).
//
// Имитирует активность живого пользователя: читает непрочитанные чаты, помечает
// прочитанными, затем один раз отвечает на самое релевантное сообщение. Без
// записи в БД. Логика и лимиты перенесены один-в-один (R-B2).

import { z } from "zod";

import type { SkillContext, SkillStatus } from "./types";
import { sleep, randomDelayMs, FloodAbortError, withFloodRetry } from "./util";
import { ClientNotConnectedError } from "../core/telegram/errors";
import { extractTopics, selectRelevantMessageInBatch, generateWarmupReply } from "../llm/prompts";

const MAX_CHATS = 15;
const GET_MESSAGES_LIMIT = 50;

interface WarmupCandidate {
    chatId: string;
    chatTitle: string;
    id: number;
    fromName: string;
    text: string;
}

export async function runAccountWarmup(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, persona, tg, llm, log } = ctx;

    // Шаг 1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { "шаг": "загрузка аккаунта", "ошибка": err.message ?? String(err) } };
    }

    // Шаг 2 — Диалоги с непрочитанными
    const { groups } = await tg.getDialogs();
    if (groups.length === 0) {
        return { status: "success", details: { "итог": "нет непрочитанных чатов" } };
    }

    // Шаг 3 — Случайные 15 чатов
    const shuffled = [...groups].sort(() => Math.random() - 0.5).slice(0, MAX_CHATS);

    // Шаг 4 — Обработать каждый чат, накапливая буфер кандидатов
    const candidates: WarmupCandidate[] = [];

    for (const chat of shuffled) {
        // 4.1 — Получить сообщения (FLOOD_WAIT: подождать и повторить один раз)
        let messages;
        try {
            const res = await withFloodRetry(() => tg.getMessages(chat.chatId, chat.readInboxMaxId, GET_MESSAGES_LIMIT), log);
            messages = res.messages;
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { "шаг": "получение сообщений", "итог": "повторный flood_wait", "чат": chat.chatId } };
            }
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[account-warmup] get_messages failed for chatId=${chat.chatId}, skipping: ${err.message ?? err}`);
            continue; // другая ошибка — пропустить чат
        }

        if (messages.length === 0) continue;

        for (const m of messages) {
            candidates.push({ chatId: chat.chatId, chatTitle: chat.title, id: m.id, fromName: m.fromName, text: m.text });
        }

        // 4.2 — Пометить прочитанными (сразу после получения)
        const maxId = Math.max(...messages.map((m) => m.id));
        try {
            await withFloodRetry(() => tg.markAsRead(chat.chatId, maxId), log);
        } catch (err: any) {
            if (err instanceof FloodAbortError) {
                return { status: "error", details: { "шаг": "отметка прочитанным", "итог": "повторный flood_wait", "чат": chat.chatId } };
            }
            if (err instanceof ClientNotConnectedError) throw err;
            log.warn(`[account-warmup] mark_as_read failed for chatId=${chat.chatId}, skipping: ${err.message ?? err}`);
            continue;
        }

        // 4.3 — Пауза 10–30 секунд
        await sleep(randomDelayMs(10, 30));
    }

    // Шаг 5 — Темы обсуждения (LLM)
    if (candidates.length === 0) {
        return { status: "success", details: { "итог": "нет кандидатов", "чатов обработано": shuffled.length } };
    }

    const topicsPrompt = extractTopics(candidates.map((c) => `- [${c.chatTitle}] ${c.fromName}: ${c.text}`).join("\n"));
    const topics = await llm.complete({ system: persona, prompt: topicsPrompt });
    log.info(`[account-warmup] topics: ${topics.slice(0, 200)}`);

    // Шаг 6 — Выбрать одно релевантное сообщение (LLM).
    // Гейт «темы не соотносятся с личностью» (шаг 5) реализован здесь: промпт
    // выбора учитывает личность и возвращает {} при отсутствии подходящего.
    const selectPrompt = selectRelevantMessageInBatch(candidates.map((c) => `- chatId=${c.chatId}, id=${c.id}, ${c.fromName}: ${c.text}`).join("\n"));
    const selected = await llm.completeObject(
        { system: persona, prompt: selectPrompt },
        // Все поля nullish: при отсутствии подходящего сообщения LLM возвращает {}.
        z.object({ chatId: z.string().nullish(), id: z.number().nullish(), text: z.string().nullish() }),
    );

    if (!selected || selected.id == null || selected.chatId == null) {
        return { status: "success", details: { "итог": "нет релевантного сообщения", "кандидатов": candidates.length } };
    }

    // Шаг 7 — Сгенерировать ответ (LLM)
    const replyPrompt = generateWarmupReply(selected.text ?? "");
    const reply = await llm.complete({ system: persona, prompt: replyPrompt });

    // Шаг 8 — Отправить ответ (FLOOD_WAIT: подождать и повторить один раз)
    try {
        const res = await withFloodRetry(
            () => tg.replyToMessage(selected.chatId!, selected.id!, reply),
            log,
        );
        return {
            status: "success",
            details: {
                "чатов обработано": shuffled.length,
                "кандидатов": candidates.length,
                "чат ответа": selected.chatId,
                "id сообщения ответа": res.messageId,
                "ответ": reply,
            },
        };
    } catch (err: any) {
        if (err instanceof FloodAbortError) {
            return { status: "error", details: { "шаг": "ответ", "итог": "повторный flood_wait" } };
        }
        // instanceof-проверка обязана быть throw, не return — иначе исключение не
        // долетит до catch-блока dispatcher.ts, который создаёт agent_restrictions.
        if (err instanceof ClientNotConnectedError) throw err;
        log.warn(`[account-warmup] reply failed: ${err.message ?? err}`);
        return { status: "error", details: { "шаг": "ответ", "ошибка": err.message ?? String(err) } };
    }
}
