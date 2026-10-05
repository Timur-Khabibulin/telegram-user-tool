import { generateText, generateObject } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { ZodError, type ZodType } from "zod";
import { withFailover } from "./failover";
import { classifyLlmError, isFailoverClass, LlmCallError } from "./error-class";

export interface LlmCompleteOptions {
    /**
     * Системное сообщение — персона агента из SOUL.md. Опционально: вызывающий
     * решает сам, нужна ли персона этому конкретному запросу (monitor-v4-comment-signal —
     * решение по посту строится на голосе аудитории треда, а не персоны, поэтому
     * не передаёт system вовсе). Не передан → `ai-sdk` не добавляет системное
     * сообщение (`generateText`/`generateObject` сами принимают `system` как
     * опциональный параметр).
     */
    system?: string;
    /** Пользовательский промпт шага скилла. */
    prompt: string;
}

export interface LlmTokenUsage {
    /** Входные (prompt) токены, суммарно за время жизни клиента. */
    inputTokens: number;
    /** Выходные (completion) токены, суммарно за время жизни клиента. */
    outputTokens: number;
    /** Суммарные токены (input+output, по данным провайдера). */
    totalTokens: number;
}

export interface LlmClient {
    /**
     * Счётчик фактических запросов к модели за время жизни клиента. Инкремент на
     * каждый `generateText`/`generateObject`, включая внутренние ретраи
     * `completeObject`. Диспетчер снимает срез вокруг скилла (после − до), чтобы
     * вывести «запросов к LLM» в отчёте (учитывает реальную нагрузку, а не число
     * логических вызовов `complete`/`completeObject`).
     */
    readonly requestCount: number;
    /**
     * Накопленный расход токенов за время жизни клиента (тот же принцип, что и
     * `requestCount`: суммируется по каждому round-trip к модели, включая ретраи
     * `completeObject`). Диспетчер снимает срез вокруг скилла для записи в `runs`.
     * Провайдер может не вернуть часть полей (`undefined` в `ai-sdk`) — тогда в
     * сумму идёт 0, поэтому значение является нижней оценкой фактического расхода.
     */
    readonly tokenUsage: LlmTokenUsage;
    /** Генерация свободного текста (ответы, DM). */
    complete(opts: LlmCompleteOptions): Promise<string>;
    /**
     * Генерация структурированного JSON. Если передана `schema` (zod) — результат
     * валидируется ею. При невалидном JSON/схеме делается один повтор с
     * ужесточённой инструкцией; если и он не прошёл — бросается ошибка
     * (скилл → status error, диспетчер всё равно сдвигает nextRun, R-D1).
     */
    completeObject<T>(opts: LlmCompleteOptions, schema?: ZodType<T>): Promise<T>;
}

/** Извлекает JSON из ответа LLM (снимает markdown-код-блоки если есть). Бросает при невалидном JSON. */
function extractJson(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1].trim() : text.trim();
    const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    return JSON.parse(match ? match[0] : raw);
}

// ── Слой 3 (тихое приведение типов) ─────────────────────────────────────────
// Приведение работает по zod-ошибкам: для каждого invalid_type-issue берём
// значение по его path и конвертируем в ожидаемый тип. Это точечно (трогаем
// только проблемные поля), не лезет во внутренности zod и потому устойчиво к
// апгрейдам. Главный кейс — числовой chatId, пришедший JSON-числом → строка.

type ZodIssueLike = { code: string; path: PropertyKey[]; expected?: string };

function getAtPath(obj: unknown, pathArr: PropertyKey[]): unknown {
    let cur: any = obj;
    for (const key of pathArr) {
        if (cur == null) return undefined;
        cur = cur[key as any];
    }
    return cur;
}

function setAtPath(obj: unknown, pathArr: PropertyKey[], value: unknown): void {
    if (pathArr.length === 0) return;
    let cur: any = obj;
    for (let i = 0; i < pathArr.length - 1; i++) {
        if (cur == null) return;
        cur = cur[pathArr[i] as any];
    }
    if (cur != null) cur[pathArr[pathArr.length - 1] as any] = value;
}

/** Консервативная конвертация примитива в ожидаемый тип; иначе возвращает как есть. */
function coerceToType(value: unknown, expected: string): unknown {
    switch (expected) {
        case "string":
            if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
            break;
        case "number":
            if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
            break;
        case "boolean":
            // Только явные строковые литералы — без "любая непустая строка = true".
            if (value === "true") return true;
            if (value === "false") return false;
            break;
    }
    return value;
}

/** Мутирует распарсенный объект, приводя типы только у полей из issue-списка. */
function applyCoercions(value: unknown, issues: ZodIssueLike[]): unknown {
    for (const issue of issues) {
        if (issue.code !== "invalid_type" || !issue.expected) continue;
        const current = getAtPath(value, issue.path);
        const coerced = coerceToType(current, issue.expected);
        if (coerced !== current) setAtPath(value, issue.path, coerced);
    }
    return value;
}

export function createLlmClient(): LlmClient {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error(
            "DEEPSEEK_API_KEY не задан в окружении (нужен как fallback, ожидается из ~/.openclaw/secrets.env)",
        );
    }

    // Primary — пул codex-слотов (llm/codex-pool.ts); fallback — DeepSeek последним звеном.
    // Цепочку провайдеров и поклассовое переключение ведёт withFailover (llm/failover.ts):
    // переход к следующему codex-слоту только при usage_limit, повтор на том же при 401,
    // прочие классы — без повтора. DeepSeek обязателен (§9-E) — ключ проверен выше.
    const deepseek = createDeepSeek({ apiKey });
    const deepseekModel = deepseek("deepseek-flash");

    // Счётчик фактических запросов к модели (R: «запросов к LLM» в отчёте). Каждый
    // round-trip оборачивается genText/genObject, поэтому ретраи completeObject
    // учитываются честно. Расход токенов аккумулируется в той же точке — из
    // `result.usage` (ai@6: inputTokens/outputTokens/totalTokens, каждое может
    // быть undefined, если провайдер его не вернул → в сумму идёт 0).
    let requestCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    const addUsage = (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): void => {
        if (!usage) return;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        totalTokens += usage.totalTokens ?? 0;
    };
    const genText: typeof generateText = (async (opts: any) => {
        requestCount += 1;
        const result = await generateText(opts);
        addUsage(result.usage);
        return result;
    }) as typeof generateText;
    const genObject: typeof generateObject = (async (opts: any) => {
        requestCount += 1;
        const result = await generateObject(opts);
        addUsage(result.usage);
        return result;
    }) as typeof generateObject;

    return {
        get requestCount() {
            return requestCount;
        },

        get tokenUsage() {
            return { inputTokens, outputTokens, totalTokens };
        },

        async complete({ system, prompt }) {
            return withFailover(deepseekModel, async (model) => {
                const { text } = await genText({ model, system, prompt });
                return text;
            });
        },

        async completeObject<T>({ system, prompt }: LlmCompleteOptions, schema?: ZodType<T>): Promise<T> {
            // Без схемы — свободный JSON одним проходом (на каждом провайдере цепочки).
            if (!schema) {
                return withFailover(deepseekModel, async (model) => {
                    const { text } = await genText({ model, system, prompt });
                    return extractJson(text) as T;
                });
            }

            // Пайплайн схемы исполняется для ОДНОГО провайдера внутри run(model).
            // Провайдерные классы ошибок (usage_limit/auth_401/auth_403/transient)
            // пробрасываются наружу в withFailover; схемные/прочие — деградируют на
            // текстовый путь ТОГО ЖЕ провайдера (а не роняют failover).
            return withFailover(deepseekModel, async (model): Promise<T> => {
                // ── Слой 1: нативный structured output. ──────────────────────
                // generateObject транслирует zod-схему в json_schema (strict) → типы
                // гарантированы. Провайдерную ошибку бросаем наружу (в failover),
                // схемную/прочую — деградируем ниже на текст (НЕ глотаем молча).
                try {
                    const { object } = await genObject({ model, system, prompt, schema });
                    return object as T;
                } catch (err) {
                    if (isFailoverClass(classifyLlmError(err))) throw err;
                }

                // ── Слой 2: текст + фидбэк-ретрай. ───────────────────────────
                // Провайдерная ошибка genText всплывёт наружу в failover сама.
                let lastText = "";
                let lastError: unknown;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    let feedback = "";
                    if (attempt === 2 && lastError instanceof ZodError) {
                        const issues = lastError.issues
                            .map((i) => {
                                const field = i.path.length ? `поле "${i.path.join(".")}"` : "корень";
                                const exp = (i as ZodIssueLike).expected;
                                return exp ? `${field}: ожидается ${exp}` : `${field}: ${i.message}`;
                            })
                            .join("; ");
                        feedback =
                            `\n\nПрошлый ответ не прошёл валидацию: ${issues}. ` +
                            "Верни ТОЛЬКО валидный JSON с правильными типами — без markdown-ограждения, без пояснений.";
                    }
                    const { text } = await genText({ model, system, prompt: prompt + feedback });
                    lastText = text;
                    try {
                        return schema.parse(extractJson(text));
                    } catch (err) {
                        lastError = err;
                    }
                }

                // ── Слой 3: тихое приведение типов (крайняя мера). ───────────
                if (lastError instanceof ZodError) {
                    try {
                        const coerced = applyCoercions(extractJson(lastText), lastError.issues as ZodIssueLike[]);
                        return schema.parse(coerced);
                    } catch (err) {
                        lastError = err;
                    }
                }

                const detail = lastError instanceof Error ? lastError.message : String(lastError);
                throw new LlmCallError(
                    "schema_error",
                    `completeObject: валидный JSON не получен (structured output → фидбэк-ретрай → coerce исчерпаны): ${detail}`,
                    { cause: lastError },
                );
            });
        },
    };
}
