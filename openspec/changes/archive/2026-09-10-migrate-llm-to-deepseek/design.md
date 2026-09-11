## Context

Весь LLM-слой платформы собран в одной функции `createLlmClient()`
(`src/llm/client.ts`). Все входы (`dispatcher.ts`, плагин `index.ts`,
ops-скрипты `discovery-similar`/`channel-niche`/`channel-metrics`) зовут её без
аргументов и работают через контракт `LlmClient` (`complete` / `completeObject` /
`requestCount`). Обёртка `withLlmLogging` и журнал `llm_log` провайдеро-независимы.

Текущая реализация — codex через OAuth (`openai-oauth-provider` →
`gpt-5.4-mini`), обёрнутый в `createFallback` с единственной моделью. С ~08.09.2026
codex-бэкенд отвергает все модели для ChatGPT-аккаунта (гейтинг по `originator`),
LLM не работает. Диагностика и выбор DeepSeek зафиксированы в разговоре и в
`sravnenie-llm-api.md`.

Профиль нагрузки: input-heavy (персона SOUL.md + сообщения чата на вход, короткий
ответ на выход), стабильный префикс персоны, объём — сотни–тысяча вызовов/сутки.

## Goals / Non-Goals

**Goals:**
- Заменить LLM-провайдера на DeepSeek V4 Flash без изменения контракта `LlmClient`
  и без правок вызывающего кода.
- Убрать OAuth-механику (рефреш токена, `auth.json`) в пользу статического ключа.
- Сохранить работоспособность structured output (`completeObject`) и передачи
  персоны через `system`.
- Проверить пригодность на реальных промптах (русский тон, валидность JSON) до
  переключения прода.

**Non-Goals:**
- Фолбэк / мульти-провайдерность (осознанно: один провайдер напрямую).
- Оптимизация под off-peak-тарифы DeepSeek (взято на заметку, вне скоупа).
- Изменение промптов, схем `zod`, скиллов или трёхслойной логики `completeObject`.
- Изменение `withLlmLogging` / `llm_log`.

## Decisions

### Провайдер — официальный `@ai-sdk/deepseek`, не `@ai-sdk/openai`+baseURL

`@ai-sdk/openai@3` по умолчанию (с AI SDK 5) бьёт в **Responses API**, которого у
DeepSeek нет — пришлось бы всюду помнить `.chat()`, иначе тихий облом. Официальный
`@ai-sdk/deepseek` нативно ходит в Chat Completions, пробрасывает поля кэша
(`prompt_cache_hit_tokens`) в `providerMetadata` и берёт на себя квирки. Цена —
одна дополнительная зависимость.
**Альтернатива:** `@ai-sdk/openai` + `baseURL` (без новой зависимости) — отклонена
из-за ловушки с Responses API и слепоты к кэшу (кэш — наш главный рычаг экономии).

### Модель — `deepseek-flash`

Точный текущий id (старые алиасы `deepseek-chat`/`deepseek-reasoner` ретайрнуты
24.07.2026). Выбрана по цена/качество для нашего профиля: дешёвый воркхорс с
автокэшем входа, по бенчам не ниже GPT-mini-линейки.

### Один провайдер напрямую, без `createFallback`

Решение пользователя — фолбэка нет. `createFallback` и зависимость `ai-fallback`
удаляются, модель используется напрямую. `openai-oauth-provider` также уходит из
зависимостей.

### Персона — через `system`, без codex-костыля

`providerOptions.openai.instructions` был обходным приёмом для codex-backend
(дублировал персону в привилегированное поле `instructions`). Для DeepSeek он
бессмыслен — персона едет как `system`-сообщение штатно. Костыль удаляется;
`providerOptionsFor()` больше не нужен.

### Ключ — статический `DEEPSEEK_API_KEY` из окружения

Читается из `process.env` (паттерн уже применён для других секретов, напр.
`TELEGRAM_REVIEW_BOT_TOKEN`), заполняется из `~/.openclaw/secrets.env`, который
systemd-юниты грузят через `EnvironmentFile`. Один ключ на всех агентов.

## Risks / Trade-offs

- **Русский тон/персона может отличаться от GPT** → eval на реальных промптах
  (`generateReply`, `generateThreadReply`, `analyzeChannelMessages`) до
  переключения прода; переключаем только при приемлемом качестве.
- **`json_schema`-strict у DeepSeek может отличаться в нюансах** → уже есть
  layer-2/3 в `completeObject` (текст+ретрай+coerce); падения в layer-2 заметны
  по логам, не ломают прогон.
- **Один провайдер = single point of failure** → принято осознанно; при отказе
  DeepSeek LLM встаёт до восстановления (как и было с codex).
- **Ключ в окружении, не в файле** → при отсутствии ключа вызов должен падать явной
  ошибкой конфигурации, а не тихим неверным запросом.

## Migration Plan

1. Добавить `@ai-sdk/deepseek`, удалить `ai-fallback` и `openai-oauth-provider` из
   зависимостей.
2. Переписать `createLlmClient()` на `createDeepSeek({ apiKey })("deepseek-flash")`
   напрямую; снять `providerOptionsFor`/`instructions`.
3. Прописать `DEEPSEEK_API_KEY` в `~/.openclaw/secrets.env` на VPS.
4. Eval: прогнать реальные промпты на DeepSeek, сверить русский тон и валидность
   JSON с прежним поведением. Гейт на продолжение.
5. Деплой: пересобрать зависимости на VPS, рестарт gateway; убедиться по логам, что
   LLM-прогоны успешны и `llmCalls>0` без ошибок.
6. После стабилизации — убрать каталог `~/.openclaw/codex-auth/` (обратимое,
   с подтверждением).

**Rollback:** вернуть прежний `createLlmClient()` (codex) не восстановит доступ
(codex отвергает модели) — реальный откат только на другого доступного провайдера;
поэтому основная страховка — eval-гейт перед переключением.

## Open Questions

- Разовый грант DeepSeek 5M токенов vs пополнение баланса — кто/когда заводит ключ и
  биллинг (действие пользователя, вне кода).
