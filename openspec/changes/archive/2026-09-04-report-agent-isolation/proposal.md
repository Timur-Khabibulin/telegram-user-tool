## Why

Получатель обоих ежедневных отчётов (funnel-report, daily-summary) — аккаунт `agent1`,
жёстко заданный константой `FUNNEL_ADMIN_AGENT_ID`. `agent1` при этом выполняет обычную
рабочую нагрузку наравне с остальными агентами (мониторинг групп, ответы). 2026-07-16
`agent1` перестал отправлять сообщения (`406: PEER_ID_INVALID` при `sendMessage("me", ...)`),
из-за чего оба отчёта перестали доставляться.

Разбор журнала прогона `tg-funnel-tracker` за 2026-07-16 показал, что среди ~40 агентов
флота (`agent1`, `agent4`–`agent46`) сбои сессии — не единичный случай:
`AUTH_KEY_UNREGISTERED` (сессия недействительна) зафиксирован у 5 агентов,
`FROZEN_METHOD_INVALID` (ограничение на часть MTProto-методов) — у 6 агентов, отдельно
таймауты подключения ещё у ~10. При таком масштабе потеря аккаунтом работоспособности —
фоновый процесс. Привязка получателя отчёта к агенту, который выполняет ту же рабочую
нагрузку, что и остальные (и потому подвержен тем же рискам потери сессии), структурно
воспроизводит один и тот же инцидент.

## What Changes

- Новая константа `REPORT_AGENT_ID` в `src/core/config.ts`, отдельная от
  `FUNNEL_ADMIN_AGENT_ID`. Текущее значение — `agent27`.
- `src/scripts/funnel-tracker.ts` и `src/scripts/daily-summary.ts`: получатель отчёта
  (`tg.loadAccount` + `sendSavedMessage`/`sendSavedDocument`) — `REPORT_AGENT_ID`. Хранение
  данных (`funnel.db`, `discovery.db`, `reports/`) и права на приватный канал остаются на
  `FUNNEL_ADMIN_AGENT_ID` (`agent1`) без изменений — эти два идентификатора больше не
  обязаны совпадать.
- `listAgentIds()` (`src/core/config.ts`) исключает `REPORT_AGENT_ID` из возвращаемого
  списка. Эффект распространяется на весь код, использующий эту функцию для обхода флота
  без явного списка агентов: `funnel-collect.ts` (сбор метрик воронки), `runs-summary.ts`
  (дневная сводка прогонов), `channel-coverage-update.ts` (пересчёт `avg_views`),
  `discovery-backfill.ts`, `discovery.ts`, `discovery-similar.ts`, `distribute-pool.ts`
  (раскладка обнаруженных каналов) — во всех этих местах `REPORT_AGENT_ID` не должен
  получать каналы или задачи наравне с рабочими агентами.
- `src/scripts/dispatcher.ts`: в начале `main()`, до подключения к Telegram, — проверка
  `agentId !== REPORT_AGENT_ID`; при совпадении процесс завершается с ошибкой без выполнения
  каких-либо задач.
- `src/core/scheduler-control.ts`: `createOrUpdateTask` отклоняет постановку задачи для
  `REPORT_AGENT_ID` той же проверкой — планирование новой задачи для этого агента
  невозможно ни через пульт, ни программно.
- `deploy/systemd/tg-funnel-tracker.service`, `deploy/systemd/tg-daily-summary.service`:
  аргумент, задающий получателя отчёта, указывает на `agent27`.
- `index.ts` (корневой — фактическая точка входа OpenClaw-плагина, не `src/index.ts`):
  два интерактивных инструмента отправляли отчёт напрямую в Saved Messages
  `FUNNEL_ADMIN_AGENT_ID`, в обход стандартных скриптов — обнаружено в процессе
  реализации (`/opsx:apply`), не было учтено на этапе проектирования. Оба переведены на
  `REPORT_AGENT_ID`:
  - `tg_funnel_report` — воронка «на сейчас» по запросу пользователя;
  - `tg_channel_coverage_report` — CSV по среднему охвату каналов.
  В обоих владелец данных (`FUNNEL_ADMIN_AGENT_ID`, `reportsDir`) не менялся — менялся
  только `tg.loadAccount(...)` перед отправкой.
- Операционно на сервере (выполнено 2026-07-17, до кода): у `agent27` отключена
  единственная активная задача (`account-warmup`, `enabled=0`) и остановлен
  `tg-agent@agent27.timer` (`disabled`, `inactive`).

## Capabilities

### New Capabilities

- `report-agent-isolation`: агент, заданный `REPORT_AGENT_ID`, исключён из перечисления
  агентов (`listAgentIds()`) и не может быть запущен диспетчером или поставлен в расписание
  задач.

### Modified Capabilities

- `funnel-report`: получатель ежедневного отчёта-воронки — `REPORT_AGENT_ID`, не обязан
  совпадать с агентом-владельцем данных воронки.
- `daily-summary`: получатель дневной сводки прогонов — `REPORT_AGENT_ID`;
  `listAgentIds()` исключает его из обхода агентов при построении сводки.
- `funnel-metrics`: `REPORT_AGENT_ID` не участвует в сборе метрик воронки — он не выполняет
  рабочих задач, метрики (каналы, ответы, DM, охват) для него не имеют смысла.

## Impact

- Код: `src/core/config.ts`, `src/scripts/funnel-tracker.ts`, `src/scripts/daily-summary.ts`,
  `src/scripts/dispatcher.ts`, `src/core/scheduler-control.ts`,
  `deploy/systemd/tg-funnel-tracker.service`, `deploy/systemd/tg-daily-summary.service`.
- Данные: без миграций — `funnel.db`, `discovery.db`, `reports/` остаются в
  `~/.openclaw/workspace-agent1/`.
- Конфигурация: `docs/configuration.md` — добавить строку `REPORT_AGENT_ID` в таблицу
  констант `src/core/config.ts` рядом с `FUNNEL_ADMIN_AGENT_ID`.
- Локальный `openclaw.json` не затрагивается и не приводится в соответствие с реальным
  списком агентов на сервере — вне скоупа этого change.
- `openspec/changes/channel-coverage-report/specs/channel-coverage-report/spec.md`
  (другой, не архивированный change) содержит требование «отправляет его в Saved
  Messages агента agent1» — текст устарел после этого фикса (получатель теперь
  `REPORT_AGENT_ID`). Не правится в рамках этого change (не наш delta), но требует
  сверки при архивации `channel-coverage-report`.
