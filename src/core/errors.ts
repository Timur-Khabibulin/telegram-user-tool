// core/errors.ts — форматирование проброшенных ошибок для отчёта/лога.
//
// Для сетевых ошибок LLM (AI SDK `APICallError`) `.message` бесполезен
// ("Bad Request") — настоящая причина лежит в `.statusCode` и `.responseBody`
// (тело ответа провайдера, обычно JSON {"error":{"message":...,"code":...}}).
// `formatError` собирает код + сообщение + тело + url; для прочих ошибок —
// обычный message (+ cause, если есть).

import { APICallError } from "ai";

export function formatError(err: unknown): string {
    if (APICallError.isInstance(err)) {
        const parts = [`LLM API ${err.statusCode ?? "?"}: ${err.message}`];
        if (err.responseBody) parts.push(`тело: ${err.responseBody}`);
        if (err.url) parts.push(`url: ${err.url}`);
        if (typeof err.isRetryable === "boolean") parts.push(`retryable: ${err.isRetryable}`);
        return parts.join(" · ");
    }
    if (err instanceof Error) {
        const cause = (err as { cause?: unknown }).cause;
        const causeMsg = cause instanceof Error ? ` (cause: ${cause.message})` : "";
        return (err.message || err.name) + causeMsg;
    }
    return String(err);
}
