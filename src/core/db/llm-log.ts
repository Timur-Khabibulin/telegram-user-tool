// core/db/llm-log.ts — журнал успешных LLM-ответов по скиллам (monitor-v3-post-comment-scoring).
//
// Append-only, per-agent, отдельный файл (не tasks.db — payload тяжелее, чем у
// error_log/runs: полный текст промпта и ответа, а не короткий код). Пишется
// только финальный успешный результат complete/completeObject — неудачные
// попытки (невалидный JSON, ретраи) внутри client.ts не долетают сюда и не
// логируются: они говорят о несоответствии формата, не о содержании ответа.
// Персона (system) не пишется — одна и та же в рамках агента, не дублируем.

import Database from "better-sqlite3";
import type { ZodType } from "zod";
import { llmLogDbPath } from "../config";
import type { Logger } from "../logger";
import type { LlmClient, LlmCompleteOptions } from "../../llm/client";

function openDb(agentId: string): Database.Database {
    const db = new Database(llmLogDbPath(agentId));
    ensureTable(db);
    return db;
}

function ensureTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS llm_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            skillType  TEXT    NOT NULL,
            prompt     TEXT    NOT NULL,
            response   TEXT    NOT NULL,
            createdAt  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_log_time ON llm_log(createdAt);
    `);
}

/** Записывает успешный LLM-вызов скилла. Append-only — существующие строки не меняются. */
export function recordLlmCall(
    agentId: string,
    record: { skillType: string; prompt: string; response: string },
    log: Logger,
): void {
    const db = openDb(agentId);
    try {
        db.prepare(`
            INSERT INTO llm_log (skillType, prompt, response, createdAt)
            VALUES (@skillType, @prompt, @response, @createdAt)
        `).run({
            skillType: record.skillType,
            prompt: record.prompt,
            response: record.response,
            createdAt: Math.floor(Date.now() / 1000),
        });
    } finally {
        db.close();
    }
}

/**
 * Оборачивает `LlmClient`, дописывая каждый успешный `complete`/`completeObject` в
 * `llm_log` под указанным `skillType` (monitor-v3-post-comment-scoring,
 * channel-context). Общая точка для двух входов платформы (диспетчер — скиллы,
 * OpenClaw-плагин — ручные тулы), которые оба могут захотеть логировать конкретный
 * тип задачи — не дублировать обёртку в каждом входе.
 */
export function withLlmLogging(base: LlmClient, agentId: string, skillType: string, log: Logger): LlmClient {
    return {
        get requestCount() {
            return base.requestCount;
        },
        async complete(opts: LlmCompleteOptions) {
            const response = await base.complete(opts);
            recordLlmCall(agentId, { skillType, prompt: opts.prompt, response }, log);
            return response;
        },
        async completeObject<T>(opts: LlmCompleteOptions, schema?: ZodType<T>) {
            const response = await base.completeObject<T>(opts, schema);
            recordLlmCall(agentId, { skillType, prompt: opts.prompt, response: JSON.stringify(response) }, log);
            return response;
        },
    };
}
