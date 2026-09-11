## 1. Зависимости

- [x] 1.1 Добавить `@openai-oauth/ai-sdk` и `@openai-oauth/local` в `package.json`
- [x] 1.2 Вернуть `ai-fallback` в `package.json` (`@ai-sdk/deepseek` оставить)

## 2. LLM-клиент (`src/llm/client.ts`)

- [x] 2.1 Primary: `createOpenAIOAuth(openaiCredentials({ authFilePath: "~/.openclaw/codex-auth/auth.json" }))("gpt-5.6-sol")`
- [x] 2.2 Fallback: `createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })("deepseek-flash")` (ключ обязателен — иначе ошибка конфигурации)
- [x] 2.3 Обернуть обе модели в `createFallback([primary, fallback])` — переключение на **любую** ошибку primary (`shouldRetryThisError: () => true`)
- [x] 2.4 Логировать срабатывание фолбэка (`onError` `ai-fallback`) с причиной — в stderr (journald)
- [x] 2.5 Сохранить контракт `LlmClient` (`complete`/`completeObject`/`requestCount`), `extractJson` и три слоя `completeObject` без изменений
- [x] 2.6 Персона: `system` передаётся как прежде (маппинг в codex `instructions` — на стороне `@openai-oauth/ai-sdk`, подтверждается спайком в Migration Plan)

## 3. Документация

- [x] 3.1 `docs/configuration.md`: LLM — primary codex-подписка (`@openai-oauth/ai-sdk`, `gpt-5.6-sol`, токен `~/.openclaw/codex-auth/auth.json`), fallback DeepSeek (`deepseek-flash`, `DEEPSEEK_API_KEY`); каталог `codex-auth/` снова обязателен
- [x] 3.2 Выверены упоминания в `docs/`: `operation.md` (вернул `codex-auth/`, LLM-доступ), `decisions/0006` + индекс (пометка «codex primary + DeepSeek fallback»)
