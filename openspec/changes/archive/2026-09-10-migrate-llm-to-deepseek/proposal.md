## Why

С ~08.09.2026 codex-бэкенд (`chatgpt.com/backend-api/codex/responses`) отвергает
**все** модели для нашего ChatGPT-аккаунта (гейтинг по `originator`: сторонний
`openai-oauth-provider` не проходит как официальный Codex-клиент) — весь
LLM-функционал платформы не работает (проверено: 100% ошибок LLM-прогонов, живой
пинг всех доступных моделей падает). Доступ к OpenAI из РФ и так «условно
доступен» (нет офиц. API/биллинга) — нужен провайдер, доступный напрямую и
устойчивый по цена/качество. Выбран DeepSeek V4 Flash (OpenAI-совместим,
автокэш входа под наш input-heavy профиль, по бенчам не ниже GPT-mini-линейки).

## What Changes

- **BREAKING**: LLM-вызовы уходят с codex OAuth (`gpt-5.4-mini`) на DeepSeek V4
  Flash (`deepseek-flash`) через официальный провайдер `@ai-sdk/deepseek`.
- Аутентификация меняется с OAuth-токена (`~/.openclaw/codex-auth/auth.json` +
  авто-рефреш + общий пул лимита Plus) на статический `DEEPSEEK_API_KEY` в
  `~/.openclaw/secrets.env`.
- В `createLlmClient()` модель используется напрямую, **без фолбэка**: удаляются
  `createFallback`/`ai-fallback`, `openai-oauth-provider` и codex-костыль
  `providerOptions.openai.instructions` (персона идёт через `system`, как и раньше).
- Контракт `LlmClient` (`complete` / `completeObject` / `requestCount`), обёртка
  `withLlmLogging`, журнал `llm_log` и все вызывающие (`dispatcher.ts`, `index.ts`,
  ops-скрипты) **не меняются** — точка правки одна.
- Перед переключением прода — eval реальных промптов на русский тон персоны и
  валидность JSON `completeObject` (вне рантайма, разовая проверка).
- Off-peak-тарификация DeepSeek — **вне скоупа** (взято на заметку).

## Capabilities

### New Capabilities
<!-- нет новых способностей: меняется реализация существующего LLM-слоя -->

### Modified Capabilities
- `llm-layer`: primary-провайдер меняется с codex-OAuth (`gpt-5.4-mini`) на
  DeepSeek (`deepseek-flash`) через `@ai-sdk/deepseek`; удаляются требования
  про авто-рефреш OAuth-токена и общий `auth.json`; аутентификация — статический
  API-key; requirement про единственный провайдер без фолбэка сохраняется, но уже
  без `createFallback`; structured output и персона-из-SOUL.md сохраняются.

## Impact

- **Код:** `src/llm/client.ts` (единственная точка сборки модели). Вызывающие не
  трогаются.
- **Зависимости:** `+ @ai-sdk/deepseek`; `− ai-fallback`, `− openai-oauth-provider`.
- **Секреты/деплой:** `DEEPSEEK_API_KEY` в `~/.openclaw/secrets.env` (systemd-юниты
  уже грузят его через `EnvironmentFile`); пересборка зависимостей на VPS; рестарт
  gateway. Отмирает каталог `~/.openclaw/codex-auth/` и авто-рефреш токена.
- **Спека:** `openspec/specs/llm-layer/spec.md` — переписываются требования про
  провайдера и аутентификацию.
- **Биллинг:** баланс DeepSeek (есть разовый грант 5M токенов).
