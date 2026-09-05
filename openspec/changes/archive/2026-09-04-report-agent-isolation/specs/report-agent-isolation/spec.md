## ADDED Requirements

### Requirement: Зарезервированный агент-получатель отчётов

Система SHALL хранить идентификатор зарезервированного агента-получателя отчётов как
константу `REPORT_AGENT_ID` в `src/core/config.ts`, отдельную от `FUNNEL_ADMIN_AGENT_ID`.
Эти два идентификатора SHALL быть независимо изменяемыми и не обязаны совпадать.

#### Scenario: Независимость от владельца данных воронки

- **WHEN** `REPORT_AGENT_ID` и `FUNNEL_ADMIN_AGENT_ID` заданы разными агентами
- **THEN** данные воронки (`funnel.db`, `discovery.db`, `reports/`) продолжают храниться в workspace `FUNNEL_ADMIN_AGENT_ID`, а отчёты доставляются в Saved Messages `REPORT_AGENT_ID`

### Requirement: Исключение из перечисления агентов

`listAgentIds()` (`src/core/config.ts`) SHALL исключать `REPORT_AGENT_ID` из возвращаемого
списка, даже если для него существует каталог `~/.openclaw/workspace-<REPORT_AGENT_ID>/`.

#### Scenario: Зарезервированный агент не участвует в обходе флота

- **WHEN** любой код вызывает `listAgentIds()` для перечисления агентов платформы (сбор метрик воронки, дневная сводка, пересчёт `avg_views`, раскладка обнаруженных каналов, распределение задач поиска)
- **THEN** `REPORT_AGENT_ID` отсутствует в результате, даже если его workspace-каталог существует и содержит `tg-account.json`

### Requirement: Запрет запуска диспетчером

`src/scripts/dispatcher.ts` SHALL отказывать в выполнении, если `--agent` равен
`REPORT_AGENT_ID`. Проверка SHALL выполняться в начале `main()`, до подключения к
Telegram и до обращения к БД агента (`tasks.db`, `runs.db`).

#### Scenario: Ручной запуск диспетчера отклонён

- **WHEN** `dispatcher.ts` запущен с `--agent <REPORT_AGENT_ID>` (планово или вручную)
- **THEN** процесс завершается с ошибкой немедленно, без подключения к Telegram и без чтения БД агента

### Requirement: Запрет постановки задач в расписание

`src/core/scheduler-control.ts:createOrUpdateTask` SHALL отказывать в создании или
обновлении задачи для `REPORT_AGENT_ID` той же проверкой, что и диспетчер. Проверка SHALL
выполняться до записи в `tasks.db` и до включения heartbeat-таймера.

#### Scenario: Постановка задачи отклонена

- **WHEN** `createOrUpdateTask` вызван с `agentId = REPORT_AGENT_ID` (через пульт или программно)
- **THEN** вызов завершается ошибкой, запись в `tasks.db` не создаётся, `systemctl enable` не выполняется

#### Scenario: Отключение задачи остаётся доступным

- **WHEN** для `REPORT_AGENT_ID` вызывается `removeTask` (например, если задача была создана до появления guard'а)
- **THEN** вызов выполняется как для любого другого агента, без дополнительной проверки
