// scripts/ops/regress-llm.ts — регресс живого запроса к LLM
// (llm-multi-account-failover). Прогоняет весь путь createLlmClient → withFailover →
// codex-слот: complete() (свободный текст) и completeObject() (structured, слой 1
// нативного json_schema). PASS = оба метода вернули непустой валидный результат без
// LlmCallError-шторма; значит рефактор failover не сломал базовый вызов.
//
// Запуск на хосте с токенами: нужен DEEPSEEK_API_KEY в окружении и
// ~/.openclaw/codex-auth/ (слоты). Тратит доли квоты codex (gpt-6-luna).
//   set -a; . ~/.openclaw/secrets.env; set +a
//   npx tsx src/scripts/ops/regress-llm.ts

import { z } from "zod";
import { createLlmClient } from "../../llm/client";

async function main(): Promise<void> {
    const llm = createLlmClient();

    console.log("[regress] 1/2 complete() …");
    const before = llm.requestCount;
    const text = await llm.complete({ prompt: "Ответь ровно одним словом: ping" });
    if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error(`complete() вернул пустой/невалидный результат: ${JSON.stringify(text)}`);
    }
    console.log(`[regress]   complete OK: ${JSON.stringify(text.trim().slice(0, 60))}`);

    console.log("[regress] 2/2 completeObject() …");
    const obj = await llm.completeObject(
        { prompt: 'Верни строго JSON по схеме: {"ok": true, "n": 7}. Только JSON, без пояснений.' },
        z.object({ ok: z.boolean(), n: z.number() }),
    );
    if (typeof obj?.ok !== "boolean" || typeof obj?.n !== "number") {
        throw new Error(`completeObject() вернул не по схеме: ${JSON.stringify(obj)}`);
    }
    console.log(`[regress]   completeObject OK: ${JSON.stringify(obj)}`);

    console.log(`[regress] requestCount: ${llm.requestCount} (delta ${llm.requestCount - before})`);
    console.log("[regress] PASS — базовый запрос к LLM работает после рефактора failover");
}

main().catch((err: any) => {
    const cls = err?.errorClass ? ` class=${err.errorClass}` : "";
    console.error(`[regress] FAIL${cls}: ${err?.message ?? err}`);
    process.exit(1);
});
