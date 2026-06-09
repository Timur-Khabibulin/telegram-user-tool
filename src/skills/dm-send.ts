// skills/dm-send.ts — runDmSend (портирование skills/dm-send/SKILL.md).
//
// Ежедневная отправка DM топ-кандидатам из dm_candidates. Лимиты, cooldown,
// паузы и обработка ошибок Telegram перенесены один-в-один (R-B2). Запись треда
// делается отдельным вызовом dm_threads_create (historyRecord в send_dm не
// используется, как и в SKILL.md).

import type { SkillContext, SkillStatus } from "./types";
import { sleep, randomDelayMs } from "./util";
import { expireOldDmCandidates, getPendingDmCandidates, updateDmCandidateStatus } from "../core/db/channels";
import { dmThreadExists, deleteDmThread, createDmThread, countDmThreadsToday } from "../core/db/dm-threads";
import { generateDM } from "../llm/prompts";

const DAILY_LIMIT = 15;
const PER_RUN_LIMIT = 2;
const CANDIDATE_EXPIRE_DAYS = 3;
const CANDIDATE_FETCH_LIMIT = 100;
const MAX_FLOOD_ERRORS = 5;

export async function runDmSend(ctx: SkillContext): Promise<SkillStatus> {
    const { agentId, persona, tg, llm, log } = ctx;

    // Шаг 0 — Проверить дневной лимит
    const today = countDmThreadsToday(agentId, log).count;
    if (today >= DAILY_LIMIT) {
        return { status: "success", details: { reason: "daily_limit_reached", sentToday: today } };
    }

    // Шаг 1 — Загрузить аккаунт
    try {
        tg.loadAccount(agentId);
    } catch (err: any) {
        return { status: "error", details: { step: "load_account", error: err.message ?? String(err) } };
    }

    // Шаг 1.5 — Заполнить peerCache (нужно для InputPeerUserFromMessage)
    await tg.getDialogs();

    // Шаг 2 — Истечь старые кандидаты
    expireOldDmCandidates(agentId, CANDIDATE_EXPIRE_DAYS, log);

    // Шаг 3 — Получить очередь кандидатов (score DESC)
    const { candidates } = getPendingDmCandidates(agentId, CANDIDATE_FETCH_LIMIT, log);

    // Шаг 4 — Cooldown-фильтр через dm_threads
    const eligible = [];
    for (const candidate of candidates) {
        const existsRes = dmThreadExists(agentId, candidate.userId, log);
        if (existsRes.exists && existsRes.cooldownActive) {
            updateDmCandidateStatus(agentId, candidate.id, "skipped", log);
            continue;
        }
        if (existsRes.exists && !existsRes.cooldownActive) {
            deleteDmThread(agentId, candidate.userId, log);
        }
        eligible.push(candidate);
    }

    // Шаг 5 — Отправить DM
    let sentThisRun = 0;
    let floodErrors = 0;
    let sentToday = today;
    let stopReason: string | null = null;

    for (const candidate of eligible) {
        if (sentThisRun >= PER_RUN_LIMIT || sentToday >= DAILY_LIMIT) {
            stopReason = sentThisRun >= PER_RUN_LIMIT ? "per_run_limit" : "daily_limit";
            break;
        }

        // 5a — Сформулировать DM (LLM)
        const dmPrompt = generateDM(candidate.msgText);
        const dmText = await llm.complete({ system: persona, prompt: dmPrompt });

        // 5b — Отправить DM (chatId + msgId → InputPeerUserFromMessage)
        let sendResult;
        try {
            sendResult = await tg.sendDm({
                userId: candidate.userId,
                chatId: candidate.sourceChatId,
                msgId: candidate.msgId,
                text: dmText,
            });
        } catch (err: any) {
            // Любая непредвиденная ошибка → skipped, без 5c, без паузы
            log.warn(`[dm-send] send_dm unexpected error for userId=${candidate.userId}: ${err.message ?? err}`);
            updateDmCandidateStatus(agentId, candidate.id, "skipped", log);
            continue;
        }

        if ("error" in sendResult) {
            if (sendResult.error === "peer_flood") {
                // Временный бан на рассылку — немедленно прервать, кандидат остаётся pending
                stopReason = "peer_flood";
                break;
            }
            if (sendResult.error === "flood_wait") {
                floodErrors += 1;
                if (floodErrors >= MAX_FLOOD_ERRORS) {
                    stopReason = "flood_errors_exceeded";
                    break;
                }
                continue; // пропустить кандидата
            }
            if (sendResult.error === "privacy_blocked") {
                updateDmCandidateStatus(agentId, candidate.id, "privacy_blocked", log);
                continue;
            }
            if (sendResult.error === "deactivated") {
                updateDmCandidateStatus(agentId, candidate.id, "deactivated", log);
                continue;
            }
            // peer_id_invalid и любой иной error → skipped, без паузы
            updateDmCandidateStatus(agentId, candidate.id, "skipped", log);
            continue;
        }

        // 5c — Создать тред (только после ok)
        const now = Math.floor(Date.now() / 1000);
        createDmThread(
            agentId,
            {
                userId: candidate.userId,
                userAccessHash: candidate.userAccessHash ?? "",
                userName: undefined,
                fromChatId: candidate.sourceChatId,
                triggerMessage: candidate.msgText,
                firstMessage: { role: "agent", msgId: sendResult.messageId, text: dmText, sentAt: now },
            },
            log,
        );

        // 5d — Обновить статус кандидата
        updateDmCandidateStatus(agentId, candidate.id, "sent", log);
        sentThisRun += 1;
        sentToday += 1;

        // 5e — Пауза 30–60 секунд (только при успехе)
        await sleep(randomDelayMs(30, 60));
    }

    // Шаг 6 — Итоговая статус-модель
    return {
        status: "success",
        details: {
            candidatesPending: candidates.length,
            eligible: eligible.length,
            sentThisRun,
            sentToday,
            floodErrors,
            stopReason,
        },
    };
}
