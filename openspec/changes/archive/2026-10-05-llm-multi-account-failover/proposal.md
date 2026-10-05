## Why

LLM-слой ходит на одну codex-подписку с единственным fallback на DeepSeek и каскадит
на **любую** ошибку без разбора причины. На практике это даёт перерасход и отказы:
за 02.10.2026 в логах — 34 реальных исчерпания лимита подписки, 156 ошибок схемы
structured output (каскадили как лимит) и 190 отказов DeepSeek по нулевому балансу.
Нужно расходовать квоту нескольких подписок прежде, чем прибегать к потокенному DeepSeek,
и реагировать на ошибки по их классу, а не единообразным каскадом.

Нормативные требования и дизайн зафиксированы отдельно (не дублируются здесь):
- `docs/design/llm-multi-account-failover/requirements-v1.md` (R1–R19, классы ошибок §6.1, AC-1…AC-15);
- `docs/design/llm-multi-account-failover/architecture.md` (решение, §9 принятые развилки).

## What Changes

- Единственный codex-аккаунт заменяется **пулом codex-слотов** с failover по строгому
  приоритету (слот₁ → слот₂ → … → DeepSeek последним).
- **BREAKING (внутренний):** удаляется `ai-fallback`; каскад «на любую ошибку» заменяется
  **явным циклом `withFailover`** с поведением по классу ошибки.
- Вводится **классификатор ошибок LLM** (7 классов: `usage_limit`, `schema_error`,
  `transient`, `auth_401`, `auth_403`, `runtime_error`, `other`). Повтор выполняется
  **только** при `usage_limit` (переход к следующему провайдеру) и `auth_401` (рефреш
  токена + повтор на том же). Остальные классы — лог без повтора и фолбэка.
- При `usage_limit` — **cooldown аккаунта** до `reset_at`, полученного из
  `GET /backend-api/wham/usage` (без траты квоты генерации). Состояние — host-level SQLite
  `~/.openclaw/codex-cooldown.db`. Доступность аккаунта проверяется по сохранённой дате,
  не пробным запросом.
- **Изоляция ошибки по рабочему элементу:** неуспех LLM-вызова по одному элементу (канал,
  тред, пост, DM) логируется и не прерывает весь прогон — ловится per-item (как
  `ChannelSkipError`) через типизированную `LlmCallError`.
- Исправляется слепой `catch {}` в слое 1 `completeObject`: наружу пробрасывается всё,
  кроме `schema_error` (иначе `usage_limit` маскируется и failover не срабатывает).

## Capabilities

### New Capabilities
<!-- нет -->

### Modified Capabilities
- `llm-layer`: добавляются требования про мультиаккаунтный failover по приоритету,
  классификацию ошибок ответа и поведение по классу, cooldown аккаунта по остатку лимита
  из `/wham/usage`, проверку доступности по дате, изоляцию ошибки по рабочему элементу.
  Существующее требование про единый fallback DeepSeek на любую ошибку primary —
  уточняется (DeepSeek становится последним звеном цепочки, а не реакцией на любую ошибку).

## Impact

- **Код LLM-слоя:** `src/llm/client.ts` (убрать `ai-fallback`, обёртка `withFailover`,
  правка `catch` слоёв `completeObject`); новые `src/llm/failover.ts`,
  `src/llm/codex-pool.ts`, `src/llm/error-class.ts`, `src/core/db/codex-cooldown.ts`.
- **Конфигурация:** `src/core/config.ts` — `CODEX_ACCOUNTS`, пути слотов, cooldown-БД.
- **Зависимости:** `package.json` — удалить `ai-fallback`.
- **Скиллы-потребители:** per-item `catch` в `monitor-v5`/`monitor-v4`/`monitor-v3`/
  `monitor-v2` и прочих местах, где результат `llm.*` используется в цикле по элементам —
  добавить обработку `LlmCallError` как skip-элемента.
- **Эксплуатация:** несколько каталогов `~/.openclaw/codex-auth/<slot>/auth.json` и
  `~/.openclaw/codex-cooldown.db` (host-level); `docs/configuration.md` обновить.
- **Вне scope:** починка `.optional()`/`.nullish()` в других схемах (кроме уже
  исправленного monitor-v5), баланс/деградация DeepSeek, дашборд расхода квот,
  релогин/провижининг OAuth-токенов, перевод gateway-агента с sol.
