// llm/error-class.ts — классификация ошибок ответа LLM-слоя и типизированная
// ошибка вызова (llm-multi-account-failover, spec llm-layer §6.1).
//
// Чистая классификация по сигнатуре ошибки — без знания о провайдерах, пуле и
// cooldown-сторе. Решение (cooldown / рефреш / переход / пропуск) принимает цикл
// failover (llm/failover.ts). Аналог каталога docs/telegram-errors.md для MTProto.

import { APICallError } from "ai";
import { ZodError } from "zod";

/** Семь классов ошибок ответа LLM-слоя (spec llm-layer §6.1). */
export type LlmErrorClass =
    | "usage_limit" // лимит подписки исчерпан (codex 429 / "usage limit has been reached")
    | "schema_error" // structured output: невалидная схема/JSON (codex 400, Zod, JSON-parse)
    | "transient" // сеть/таймаут/5xx
    | "auth_401" // токен невалиден/протух
    | "auth_403" // доступ запрещён
    | "runtime_error" // исключение в коде слоя, не ответ API
    | "other"; // нераспознанный ответ API

/**
 * Типизированная ошибка неуспеха LLM-вызова — ЕДИНСТВЕННЫЙ тип, которым LLM-слой
 * сигналит наружу (spec «Изоляция ошибки LLM по рабочему элементу»). По типу отличима
 * от сигналов останова прогона (ClientNotConnectedError, PeerFloodError), поэтому
 * per-item catch скилла трактует её как пропуск элемента, а не падение прогона.
 */
export class LlmCallError extends Error {
    readonly errorClass: LlmErrorClass;
    constructor(errorClass: LlmErrorClass, message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = "LlmCallError";
        this.errorClass = errorClass;
        if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    }
}

/**
 * Классы, относящиеся к доступности провайдера (а не к схеме/коду). В `completeObject`
 * слой нативного structured output их пробрасывает наружу в failover (не деградирует на
 * текст); остальные классы (schema_error/other/runtime_error) — деградируют.
 */
export function isFailoverClass(cls: LlmErrorClass): boolean {
    return cls === "usage_limit" || cls === "auth_401" || cls === "auth_403" || cls === "transient";
}

/** Похоже ли на сетевую/транспортную ошибку (таймаут, разрыв, fetch failed). */
function isNetworkError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR/i.test(code)) {
        return true;
    }
    const name = (err as { name?: unknown } | null)?.name;
    if (typeof name === "string" && /timeout|connect/i.test(name)) return true;
    const msg = err instanceof Error ? err.message : "";
    return /fetch failed|network|socket hang up|timed? out|terminated/i.test(msg);
}

/** Непустой заголовок codex о достигнутом лимите (имена — lowercase в responseHeaders). */
function hasRateLimitReachedHeader(h: Record<string, string> | undefined): boolean {
    if (!h) return false;
    const v = h["x-codex-rate-limit-reached-type"] ?? h["x-codex-primary-rate-limit-reached-type"];
    return typeof v === "string" && v.length > 0;
}

/**
 * Классифицирует ошибку в один из 7 классов. Идемпотентна по LlmCallError
 * (повторная классификация возвращает уже присвоенный класс).
 */
export function classifyLlmError(err: unknown): LlmErrorClass {
    if (err instanceof LlmCallError) return err.errorClass;

    if (APICallError.isInstance(err)) {
        const code = err.statusCode;
        const body = (err.responseBody ?? "").toLowerCase();
        if (code === 429 || body.includes("usage limit has been reached") || hasRateLimitReachedHeader(err.responseHeaders)) {
            return "usage_limit";
        }
        if (code === 400 && body.includes("invalid schema for response_format")) return "schema_error";
        if (code === 401) return "auth_401";
        if (code === 403) return "auth_403";
        if (code != null && code >= 500) return "transient";
        if (err.isRetryable) return "transient";
        return "other";
    }

    if (isNetworkError(err)) return "transient";
    // Исход structured output, не ответ провайдера: Zod-валидация и JSON.parse (SyntaxError).
    if (err instanceof ZodError || err instanceof SyntaxError) return "schema_error";

    return "runtime_error";
}
