## 1. Зависимости

- [x] 1.1 Добавить `@ai-sdk/deepseek` в `package.json`
- [x] 1.2 Удалить `ai-fallback` и `openai-oauth-provider` из `package.json`

## 2. LLM-клиент (`src/llm/client.ts`)

- [x] 2.1 Заменить сборку модели на `createDeepSeek({ apiKey })("deepseek-flash")` напрямую, без `createFallback`
- [x] 2.2 Читать ключ из `process.env.DEEPSEEK_API_KEY`; при отсутствии — бросать явную ошибку конфигурации
- [x] 2.3 Удалить `providerOptionsFor()` и передачу `providerOptions.openai.instructions`; персона идёт только через `system`
- [x] 2.4 Убедиться, что контракт `LlmClient` (`complete`/`completeObject`/`requestCount`), `extractJson` и три слоя `completeObject` остались без изменений
- [x] 2.5 Удалить неиспользуемые импорты codex/fallback (`createOpenAIOAuth`, `createFallback`, закомментированный `createOpenAI`)

## 3. Документация

- [x] 3.1 Обновить `docs/configuration.md`: секрет `DEEPSEEK_API_KEY` в `~/.openclaw/secrets.env` вместо codex-auth OAuth
- [x] 3.2 Выверить упоминания codex/`gpt-5.4-mini`/`auth.json` в `docs/` (architecture, operation) и привести к DeepSeek там, где это норма поведения
