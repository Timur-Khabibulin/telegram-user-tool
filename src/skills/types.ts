// skills/types.ts — общий контекст и статус-модель портированных скиллов.
//
// Скиллы — это бывшие SKILL.md, переписанные в код (R-B2). Они зависят от
// абстракций ядра (TelegramService, core/db) и LLM (LlmClient), а не от OpenClaw.
// Контекст создаёт диспетчер (раздел 4): читает SOUL.md (persona), поднимает
// TelegramService и LlmClient. Скилл возвращает статус-модель (R-D1) — отчёт в
// Saved Messages и сдвиг nextRun делает диспетчер, не скилл.

import type { Logger } from "../core/logger";
import type { TelegramService } from "../core/telegram/service";
import type { LlmClient } from "../llm/client";

export interface SkillContext {
    /** agentId === agentName (R-E1). */
    agentId: string;
    /** Содержимое SOUL.md агента — передаётся как `system` в LLM (R-E2, §6.5). */
    persona: string;
    tg: TelegramService;
    llm: LlmClient;
    log: Logger;
}

/**
 * Статус-модель прогона (R-D1): основной статус `success` или альтернативный
 * `error` + детали для отчёта. `terminal` выставляется конечными задачами (R-A3),
 * по нему диспетчер отключает задачу (`enabled = 0`).
 */
export interface SkillStatus {
    status: "success" | "error";
    terminal?: boolean;
    details: Record<string, unknown>;
}
