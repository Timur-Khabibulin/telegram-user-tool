---
name: proxy-failure-rotation-architecture
description: Архитектура второго триггера ротации прокси (по накопленным боевым провалам) — переиспользуемые механизмы и открытые вопросы
metadata:
  type: project
---

Design-doc `docs/design/proxy-failure-rotation/architecture.md` (парный к requirements-v1.md,
R1–R14). Второй триггер ротации прокси: probe проходит, боевое подключение проваливается —
существующий probe-триггер такой прокси не ротирует никогда.

Непроизводные находки в коде (ветка refactoring-2):
- `verifyConnection(override)` в `src/core/telegram/service.ts` (~573) — ГОТОВЫЙ боевой verify:
  `ensureClient({proxy})` идёт МИМО probe-gate (ветка `!override` пропущена) прямо в боевой
  цикл connect+getMe, затем disconnect; бросает подкласс при неудаче = контракт
  `(proxy)=>Promise<void>`. Отдельная verify-функция под R13 не нужна.
- `provisionProxyViaProbe` (`src/features/proxy/provision-via-probe.ts`) verify-агностична:
  verify передаётся коллбэком. Переиспользуется ОБОИМИ триггерами (probe-verify 10 канд. /
  боевой verify 5 канд.) — только коллбэк и maxCandidates разные. Даёт R9 буквально.
- Счётчик = per-agent операционное состояние. Рекомендованный дом — таблица `proxy_health`
  в per-agent `tasks.db` (прецедент: `error-log.ts`/`runs.ts`/`dispatcher-runs.ts` там же;
  диспетчер открывает tasks.db на шаге 0). Альтернатива — поле в proxy-блоке tg-account.json
  (рядом с countryCode); финальный выбор за координатором.
- Каданс monitor-v5: `V5_WAKE_GAP_MIN_SEC`=2.5ч..`MAX`=4ч (config.ts). Дефолт порога 2 →
  ≈5–8ч восстановления. Env-конфиг по образцу V5_WAKE_GAP.

**Why:** фиксирует, что боевой verify и отбор кандидатов НЕ пишутся с нуля — переиспользуются
verifyConnection + provisionProxyViaProbe; счётчик кладётся в tasks.db, не в конфиг.
**How to apply:** при реализации/ревью этой фичи не плодить новую verify-функцию и новый
цикл отбора; врезки инкремента/сброса — в боевой цикл ensureClient (не в probe-gate).

Открытые вопросы, оставленные человеку (§9 doc): (B) дом счётчика tasks.db vs конфиг;
(C) колонка proxy_key для реакции на внешнюю смену прокси; (D) «прогон» = процесс диспетчера
целиком vs задача, и участвуют ли ops-скрипты/funnel-tracker — gateway ИСКЛЮЧЁН (долгоживущий,
переподключения исказили бы посуточный счёт); (E) порог 2 vs 3; (F) сброс при probe-swap.
На момент написания — фаза проектирования, код src/ не менялся.
</content>
