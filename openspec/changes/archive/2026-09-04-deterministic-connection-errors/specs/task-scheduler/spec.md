## ADDED Requirements

### Requirement: Массовое отключение всех задач агента

Модуль `core/db/tasks.ts` SHALL предоставлять операцию `disableAllTasks(agentId)`,
отключающую (`enabled=0`) все задачи указанного агента одним запросом, без фильтра по
типу задачи — в дополнение к существующему поштучному `disableTask(agentId, type)`.

#### Scenario: Все задачи агента отключены одним вызовом

- **WHEN** вызывается `disableAllTasks(agentId)`
- **THEN** все строки `tasks` с этим `agentId` получают `enabled=0`, независимо от
  текущего значения `enabled` и типа задачи
