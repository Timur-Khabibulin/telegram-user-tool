## 1. Конфигурация и пул codex-слотов

- [x] 1.1 В `src/core/config.ts` добавить `codexAuthRoot()` (`~/.openclaw/codex-auth`),
  `codexCooldownDbPath()` (`~/.openclaw/codex-cooldown.db`) и чтение env `CODEX_ACCOUNTS`.
- [x] 1.2 Создать `src/llm/codex-pool.ts`: обнаружение слотов (список из `CODEX_ACCOUNTS`
  слева направо; при пустом — автодискавери подкаталогов `codex-auth/*/`; легаси
  `codex-auth/auth.json` → слот `default`), сборка `createOpenAIOAuth(openaiCredentials({
  authFilePath }))` на каждый слот с моделью `gpt-6-luna`.
- [x] 1.3 В `codex-pool.ts` реализовать `fetchResetAt(slot)` — запрос
  `GET /backend-api/wham/usage` токеном слота, разбор `primary_window`/`secondary_window`,
  возврат `max(reset_at исчерпанных окон)`; при недоступности эндпоинта — фолбэк-окно 5 ч.
- [x] 1.4 В `codex-pool.ts` реализовать форс-рефреш токена слота (для класса `auth_401`).

## 2. Классификатор ошибок

- [x] 2.1 Создать `src/llm/error-class.ts`: тип `LlmErrorClass` (7 классов) и чистую
  `classifyLlmError(err)` по `APICallError` (`statusCode`/`responseBody`/`responseHeaders`)
  и типу JS-исключения (сеть → `transient`, Zod/JSON/исчерпание `completeObject` →
  `schema_error`, прочее JS → `runtime_error`).
- [x] 2.2 Определить типизированную `LlmCallError extends Error` (поле `errorClass`,
  `cause`) — единый тип неуспеха LLM-слоя наружу.

## 3. Cooldown-стор

- [x] 3.1 Создать `src/core/db/codex-cooldown.ts` по образцу `src/core/db/proxy-health.ts`:
  host-level SQLite (WAL, busy_timeout), таблица `codex_cooldown(account_id PK,
  cooldown_until, reached_type, checked_at)`.
- [x] 3.2 Реализовать `listAvailableAccounts(slots)`, `setCooldown(accountId, until,
  reachedType)` (атомарный upsert), `getCooldownUntil(accountId)`.

## 4. Цикл failover и интеграция в client.ts

- [x] 4.1 Создать `src/llm/failover.ts`: `buildProviderChain()` (доступные слоты по
  приоритету через `listAvailableAccounts` + DeepSeek последним) и `withFailover(run)` —
  цикл по цепочке с поведением по классу: `usage_limit` → `fetchResetAt`+`setCooldown`+
  переход к следующему; `auth_401` → форс-рефреш + 1 повтор на том же; остальные → лог и
  бросок `LlmCallError`.
- [x] 4.2 В `src/llm/client.ts` удалить `createFallback`/статическую модель; обернуть
  `complete` и `completeObject` в `withFailover`, где единица `run(model)` — полный путь
  вызова одного провайдера.
- [x] 4.3 Сохранить семантику `requestCount` (инкремент в обёртках `genText`/`genObject`,
  учёт повторов).
- [x] 4.4 Эмитить структурные `[llm]`-строки: обслужено (слот), переключение (класс,
  куда), cooldown (слот, `cooldown_until`, окно), пропуск по cooldown, 401/рефреш, «все
  исчерпаны».

## 5. Правка 3-слойной деградации completeObject

- [x] 5.1 Заменить слепые `catch {}` слоёв 1 и 2 `completeObject` на «ловить/деградировать
  только если `classifyLlmError(err) === "schema_error"`, иначе пробросить наружу» — чтобы
  `usage_limit`/`auth_*`/`transient` доходили до цикла failover, а не глохли.
- [x] 5.2 Убедиться, что финальный throw `completeObject` оборачивается в `LlmCallError`
  (класс `schema_error`), а `complete` (без слоёв) тоже отдаёт `LlmCallError` наружу.

## 6. Изоляция ошибки по рабочему элементу в скиллах-потребителях

- [x] 6.1 В `src/skills/monitor-v5.ts` в per-channel `catch` добавить ветку `LlmCallError`
  (перед финальным `throw err`): лог → `markChannelProcessed` → `continue`, по образцу
  `ChannelSkipError`.
- [x] 6.2 Повторить обработку `LlmCallError` как skip-элемента в `monitor-v4`, `monitor-v3`,
  `monitor-v2`, `monitor` и других местах, где `llm.*` вызывается в цикле по элементам
  (`dm-replies`, `account-warmup`, `dm-send`, feature/ops-потребители — провести аудит
  вызовов `llm.complete`/`llm.completeObject`).

## 7. Зависимости и документация

- [x] 7.1 Удалить `ai-fallback` из `package.json` и импортов.
- [x] 7.2 Обновить `docs/configuration.md`: пул codex-слотов (`CODEX_ACCOUNTS`, раскладка
  `codex-auth/<slot>/auth.json`), host-level `codex-cooldown.db`, поведение по классам
  ошибок; при необходимости — каталог классов ошибок LLM (по образцу `docs/telegram-errors.md`).
