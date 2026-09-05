## Why

С деплоем `telegram-error-handling` появились два новых источника данных — статус
канала (`channels.status='banned'`) и ограничения агента (`agent_restrictions`) —
но ежедневный отчёт-воронка их не показывает. Оператор не видит из отчёта, сколько
каналов забанено и какие агенты получили ограничение за отчётные сутки — эту
информацию приходится добывать вручную через VPS/SQLite.

## What Changes

- CSV-вложение отчёта (`buildFunnelCsv`, главная таблица): новый столбец на
  агента — число каналов, у которых `status='banned'` появился в отчётные сутки.
- CSV-вложение: новая (третья) таблица — список агентов, которым за отчётные
  сутки было наложено ограничение (`agent_restrictions.restricted_at` попадает в
  окно дня), с колонками `agent_id`, `restriction_type`.
- Текстовое сообщение отчёта (`renderFunnel`, уходит в Saved Messages): новая
  строка с числом агентов, получивших ограничение за отчётные сутки (только
  число, без списка — список остаётся в CSV).

«Наложено за отчётные сутки» = `restricted_at` попадает в окно дня отчёта —
фиксирует новые/повторные срабатывания, а не текущий снимок состояния (иначе
незакрывающиеся ограничения вроде `need_update_session` попадали бы в отчёт
каждый день после первого наложения).

## Capabilities

### Modified Capabilities

- `funnel-report`: рендер CSV и текстового отчёта дополняется данными о забаненных
  каналах и ограничениях агентов за отчётные сутки.

## Impact

- `src/core/db/channels.ts` — новая функция `countChannelsBannedInWindow(agentId, startSec, endSec)`.
- `src/core/db/agent-restrictions.ts` — новая функция `listRestrictionsSince(adminAgentId, startSec, endSec)`.
- `src/core/funnel-collect.ts` — `AgentFunnelRow.channelsBannedToday`, `FunnelResult.restrictedAgents`, сбор обоих полей в `collectFunnel`.
- `src/core/funnel-report.ts` — новый столбец в `buildFunnelCsv`, новая таблица в CSV, новая строка в `renderFunnel`.
- Новых таблиц/БД не требуется — оба источника (`channels.status`, `agent_restrictions`) уже существуют.
