## Why

DeepSeek (текущий primary после `migrate-llm-to-deepseek`) — потокенный и платный.
Доступ к ChatGPT-подписке (флэт, $0 за токены) снова стал возможен через живую
библиотеку `@openai-oauth/ai-sdk`, которая корректно шлёт codex-`originator` —
проверено живым спайком: `gpt-5.6-sol` отвечает, `generateObject` даёт валидный
JSON. Хотим вернуть дешёвый флэт как primary, но не остаться снова без LLM при
отказе codex — поэтому DeepSeek становится страховкой.

## What Changes

- **BREAKING**: primary LLM меняется на codex-подписку через `@openai-oauth/ai-sdk`
  (`createOpenAIOAuth(openaiCredentials({ authFilePath }))`), модель
  **`gpt-5.6-sol`** (лёгкая), токен из `~/.openclaw/codex-auth/auth.json` c
  авто-рефрешем библиотекой.
- **DeepSeek (`deepseek-flash`) становится fallback** — срабатывает на **любую**
  ошибку primary. Механизм — `ai-fallback` (`createFallback([primary, fallback])`).
- **Срабатывание фолбэка логируется** (`onError` → logger → journald), чтобы тихий
  отказ codex и незаметный расход DeepSeek были видимы.
- Контракт `LlmClient` (`complete`/`completeObject`/`requestCount`), `withLlmLogging`,
  `llm_log` и все вызывающие — **не меняются** (точка правки одна: `src/llm/client.ts`).
- `~/.openclaw/codex-auth/` — **сохраняется** (нужен primary'ю).
- Off-peak DeepSeek — **вне скоупа**.

## Capabilities

### New Capabilities
<!-- нет новых способностей: меняется реализация LLM-слоя -->

### Modified Capabilities
- `llm-layer`: снова **primary + failover**. Primary — codex-подписка через
  `@openai-oauth/ai-sdk` (`gpt-5.6-sol`) вместо DeepSeek-only; DeepSeek
  (`deepseek-flash`) — реальный fallback на любую ошибку primary через `ai-fallback`;
  добавляется требование логировать срабатывание фолбэка. Частично откатывает
  `migrate-llm-to-deepseek` (там был единственный провайдер без фолбэка).

## Impact

- **Код:** `src/llm/client.ts` (единственная точка сборки модели). Вызывающие не
  трогаются.
- **Зависимости:** `+ @openai-oauth/ai-sdk`, `+ @openai-oauth/local`, вернуть
  `+ ai-fallback`; `@ai-sdk/deepseek` остаётся. Оба провайдера — spec `v3` (ai@6).
- **Секреты/файлы:** `DEEPSEEK_API_KEY` (secrets.env) — как есть; `~/.openclaw/codex-auth/auth.json`
  (живой codex-токен) — снова обязателен, не удалять.
- **Спека:** `openspec/specs/llm-layer/spec.md` — primary/fallback и логирование фолбэка.
- **Наблюдаемость:** новый лог-сигнал «codex→deepseek fallback» в journald.
