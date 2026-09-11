import * as path from "path";
import * as os from "os";
import { generateText, generateObject } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { openaiCredentials } from "@openai-oauth/local";
import { createFallback } from "ai-fallback";
import { ZodError, type ZodType } from "zod";

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

export interface LlmClient {
    /**
     * Счётчик фактических запросов к модели за время жизни клиента. Инкремент на
     * каждый `generateText`/`generateObject`, включая внутренние ретраи
     * `completeObject`. Диспетчер снимает срез вокруг скилла (после − до), чтобы
     * вывести «запросов к LLM» в отчёте (учитывает реальную нагрузку, а не число
     * логических вызовов `complete`/`completeObject`).
     */
    readonly requestCount: number;
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

    // Primary — ChatGPT-подписка через codex (@openai-oauth/ai-sdk шлёт корректный
    // originator). Токен — общий ~/.openclaw/codex-auth/auth.json, рефреш делает
    // библиотека. Fallback — DeepSeek. Персона доезжает через `system` (маппинг в
    // codex instructions — на стороне библиотеки).
    const codexAuthFile = path.join(os.homedir(), ".openclaw", "codex-auth", "auth.json");
    const codex = createOpenAIOAuth(openaiCredentials({ authFilePath: codexAuthFile }));
    const deepseek = createDeepSeek({ apiKey });

    // Любая ошибка primary (codex) → fallback на DeepSeek. Срабатывание логируется
    // (journald), чтобы отказ codex и переход на платный DeepSeek не были тихими.
    const model = createFallback({
        models: [codex("gpt-5.6-sol"), deepseek("deepseek-flash")],
        shouldRetryThisError: () => true,
        onError: (error, modelId) => {
            console.warn(
                `[llm] fallback: модель "${modelId}" упала (${error?.message ?? error}) — переключение на следующую`,
            );
        },
    });

    // Счётчик фактических запросов к модели (R: «запросов к LLM» в отчёте). Каждый
    // round-trip оборачивается genText/genObject, поэтому ретраи completeObject
    // учитываются честно.
    let requestCount = 0;
    const genText: typeof generateText = (opts: any) => {
        requestCount += 1;
        return generateText(opts);
    };
    const genObject: typeof generateObject = (opts: any) => {
        requestCount += 1;
        return generateObject(opts);
    };

    return {
        get requestCount() {
            return requestCount;
        },

        async complete({ system, prompt }) {
            const { text } = await genText({ model, system, prompt });
            return text;
        },

        async completeObject<T>({ system, prompt }: LlmCompleteOptions, schema?: ZodType<T>): Promise<T> {
            // Без схемы валидировать нечего — свободный JSON одним проходом.
            if (!schema) {
                const { text } = await genText({ model, system, prompt });
                return extractJson(text) as T;
            }

            // ── Слой 1: нативный structured output (приоритет). ──────────────
            // generateObject транслирует zod-схему в text.format json_schema
            // Responses API → декодер модели конструктивно ограничен схемой, типы
            // гарантированы. Если бэкенд/модель его не поддерживает — бросает, и мы
            // спускаемся на текстовый путь. Сетевые/авторизационные ошибки тоже
            // приведут сюда — текстовый путь честно повторит запрос и пробросит их.
            try {
                const { object } = await genObject({ model, system, prompt, schema });
                return object;
            } catch {
                // structured output недоступен — fallback ниже
            }

            // ── Слой 2: текстовая генерация + фидбэк-ретрай. ─────────────────
            // 1-й проход — обычный текст; при ошибке схемы 2-й проход повторяет
            // запрос, подложив модели конкретные zod-ошибки (путь + ожидаемый тип),
            // чтобы она прицельно исправила, а не «верни валидный JSON» вслепую.
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

            // ── Слой 3: тихое приведение типов (крайняя мера). ──────────────
            // По zod-ошибкам последнего ответа точечно приводим типы проблемных
            // полей в распарсенном JSON и валидируем снова. Срабатывает только на
            // invalid_type — структурные ошибки (отсутствие поля и т.п.) не маскирует.
            if (lastError instanceof ZodError) {
                try {
                    const coerced = applyCoercions(extractJson(lastText), lastError.issues as ZodIssueLike[]);
                    return schema.parse(coerced);
                } catch (err) {
                    lastError = err;
                }
            }

            const detail = lastError instanceof Error ? lastError.message : String(lastError);
            throw new Error(
                `completeObject: валидный JSON не получен (structured output → фидбэк-ретрай → coerce исчерпаны): ${detail}`,
            );
        },
    };
}
