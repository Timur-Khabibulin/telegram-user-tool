---
name: llm-multi-account-failover-architecture
description: Архитектурные факты фичи мультиаккаунтного failover codex-подписок с cooldown и классификацией ошибок
metadata:
  type: project
---

Design-doc `docs/design/llm-multi-account-failover/architecture.md` (парный к requirements-v1.md,
R1-R18, §6.1). Неочевидные факты, выверенные по коду/библиотекам ветки refactoring-2:

- **ai-fallback выброшен в пользу явного цикла failover.** Его `shouldRetryThisError` —
  одно булево «следующая модель / нет», не выражает три реакции требований (usage_limit →
  следующий провайдер+повтор; auth_401 → рефреш+повтор на ТОМ ЖЕ; остальное → лог без
  фолбэка) и не пропускает аккаунты по cooldown ДО вызова. Зависимость удаляется.
- **cooldown-стор host-level, НЕ per-agent.** Пул codex — ресурс хоста
  (`~/.openclaw/codex-auth/<slot>/auth.json`), общий для всех telegram-агентов/прогонов.
  `createLlmClient()` остаётся процесс-уровневым, без agentId. Рекомендован файл
  `~/.openclaw/codex-cooldown.db` (нет host-level прецедента БД, но дом совпадает с домом
  пула) — §9-A открыт. Схема минимальна: account_id (имя слота) PK, cooldown_until,
  reached_type, checked_at. used_percent НЕ храним (нет проактивного поллинга).
- **@openai-oauth сам авто-рефрешит access-token по refresh-token.** Значит 401 долетает
  до приложения только если протух refresh-token → релогин (вне фичи). R16 вырождается в
  «1 принудительный loadAuthTokens(ensureFresh)+повтор; не помогло → лог без каскада».
- **loadAuthTokens({authFilePath, fetch, ensureFresh:true})** (из @openai-oauth/local)
  возвращает {accessToken, accountId} — используется и для заголовков `/wham/usage`
  (Authorization Bearer + chatgpt-account-id), и как путь рефреша. Это основа
  fetchResetAt без траты квоты генерации (R14).
- **Момент сброса — реактивно из GET /backend-api/wham/usage** только при классе
  usage_limit (не заголовки x-codex-*, они по issues пусты/-1). cooldown_until = max
  reset_at исчерпанных окон (primary 5ч / secondary неделя).
- **completeObject слепой `catch {}` слоя 1 маскировал бы провал failover.** Провайдерные
  ошибки (usage_limit/401/403/transient) должны пробрасываться наружу в цикл failover;
  в `catch` глохнет ТОЛЬКО schema_error (деградация схемы ортогональна выбору провайдера).
- **APICallError** экспортируется из `ai`, поля statusCode/responseBody/responseHeaders,
  static isInstance() — основа классификатора `src/llm/error-class.ts` (аналог
  telegram-errors.md). Классы: usage_limit/schema_error/transient/auth_401/auth_403/
  runtime_error/other.
- Модель в коде — `gpt-6-luna` (НЕ gpt-5.6-luna из старой памяти llm_codex). Достижимость
  гейтится minimal_client_version бэкендом — внешний риск, не логика фичи.
- **R19/AC-15 — изоляция ошибки по рабочему элементу.** LLM-слой наружу бросает ОДНУ
  типизированную `LlmCallError{errorClass,cause}` (не сырое исключение провайдера, не
  ClientNotConnectedError, не PeerFloodError). Ловится per-item `catch` скилла (канал/
  тред/пост/DM) тем же приёмом, что уже существующий `ChannelSkipError` (markProcessed +
  continue), НЕ пробрасывается в диспетчер. usage_limit/401 решаются ВНУТРИ withFailover;
  LlmCallError наружу = «этот вызов не удался» вкл. исчерпание всей цепочки. Корень бага:
  monitor-v5 per-channel catch (строки ~743-758) ловит только Flood/PeerFlood/Channel
  Skip/ClientNotConnected, всё прочее `throw err` → роняет прогон (20 status=error 02.10).
  Фикс — добавить ветку LlmCallError в monitor-v2/v3/v4/v5.
- Образец стора — `src/core/db/proxy-health.ts` (паттерн «сбой→cooldown→возврат» —
  proxy-failure-rotation). Образец логирования — структурные строки в stdout/journald,
  без отдельного журнала-БД.
