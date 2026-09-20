## Why

Агент, попавший под ограничение `need_update_session` (сломанная сессия), висит
ограниченным, пока оператор вручную не реавторизует его через `tg-agent-reauth-from-tdata`.
Для агентов, заведённых массовой автpрегистрацией, tdata-сессия лежит в
`workspace-<agentId>/` (её переносит `promoteToWorkspace`), значит реавторизацию
можно выполнять автоматически, без участия человека — восстанавливать восстановимые
сессии и отделять невосстановимые в отдельную очередь на ручной разбор.

## What Changes

- **Суточный кросс-агентный свип реавторизации.** Отдельная платформенная задача на
  собственном systemd-таймере (по образцу `channel-rotation`/`daily-summary`), не
  per-agent задача диспетчера и не завязана на per-tool-call watchdog. Раз в сутки
  берёт всех агентов с активным ограничением `need_update_session` и последовательно
  реавторизует каждого через существующую `reauthFromTdata(agentId, undefined)` с
  2FA-паролем шаблона персоны по умолчанию. Ошибка одного агента не останавливает
  остальных.
- **Новый тип ограничения `manual_reauth`** — «требуется ручная реавторизация».
  Свип уводит в него исходы, которые авто-ретрай не починит (`tdata_missing`,
  `password_rejected`). Свип выбирает только `need_update_session`, поэтому агенты в
  `manual_reauth` (как и `banned`/`suspend`) повторно не дёргаются. Диспетчер трактует
  `manual_reauth` как любое активное ограничение — агент не запускается — без отдельной
  доработки. Выход из состояния — штатный: оператор кладёт tdata / даёт пароль и гоняет
  `tg-agent-reauth-from-tdata`; `reauthFromTdata` при успехе снимает ограничение.
- **Карта исходов свипа → запись в `agent_restrictions`:**
  - `done` → ограничение снято (это делает сама `reauthFromTdata`);
  - `tdata_missing` → тип меняется на `manual_reauth`;
  - `password_rejected` → тип меняется на `manual_reauth`;
  - `error`, распознанный `classifyAccountError` как бан → тип меняется на `banned`, `reason` = текст ошибки;
  - `connect_failed` / `code_timeout` / `error`-не-бан → строка НЕ трогается (ретрай на следующем суточном прогоне);
  - `agent_not_found` → строка НЕ трогается, только лог.
- **Транзиентные исходы не перезаписывают строку** — чтобы не сдвигать `restricted_at`,
  по которому суточный funnel-report считает «кому наложено ограничение за сутки».
- **Значок статуса `manual_reauth` в funnel-report.**
- **Наблюдаемость — только логи systemd-юнита** (`journalctl`). Никаких сводок в Saved
  Messages, записей в журнал операций каналов, новых таблиц-журналов.

## Capabilities

### New Capabilities
- `agent-reauth-sweep`: суточный кросс-агентный свип, реавторизующий агентов с
  `need_update_session` через tdata, с картой исходов и journal-наблюдаемостью.

### Modified Capabilities
- `agent-restrictions`: в перечень `restriction_type` добавляется `manual_reauth`;
  диспетчер трактует его как всегда-активное ограничение (наравне с `banned`/`need_update_session`).

## Impact

- Код (новое):
  - `src/core/db/agent-restrictions.ts` — `manual_reauth` в `RestrictionType`; новый
    запрос `listActiveByType(adminAgentId, type)` (активные ограничения заданного типа,
    с учётом истечения `suspend` — как в `getActiveRestriction`).
  - `src/features/agent-reauth-sweep/run.ts` — свип-логика с картой исходов.
  - `src/scripts/periodic/reauth-sweep.ts` — тонкий запускатор (по образцу
    `periodic/channel-rotation.ts`).
  - `deploy/systemd/tg-reauth-sweep.service` + `.timer`.
- Код (правка): `src/features/funnel/funnel-report.ts` — значок для `manual_reauth`;
  `src/features/funnel/funnel-collect.ts` — добавить `manual_reauth` в список пропуска
  MTProto-этапов охвата (наравне с `need_update_session`/`banned`).
- Переиспользуется без изменений: `reauthFromTdata`, `clearRestriction`,
  `upsertRestriction`, `classifyAccountError`.
- Доки: `docs/task-scheduling.md` / `docs/operation.md` — упомянуть новый суточный
  таймер (платформенная задача вне таблицы `tasks`).
- Ограничение v1: транзиентные исходы ретраятся ежесуточно бесконечно; `code_timeout`
  при каждом ретрае инициирует отправку кода на аккаунт — принято осознанно, счётчик
  попыток вне скоупа.
