# account-error-log Specification

## Purpose
TBD - created by archiving change telegram-error-handling. Update Purpose after archive.
## Requirements
### Requirement: Схема `error_log`

Система SHALL хранить append-only лог срабатываний ошибок аккаунта в таблице
`error_log`, per-agent, в существующей `tasks.db` (по прецеденту
`runs`/`dispatcher_runs`, которые тоже лежат в `tasks.db`, не в отдельном
файле). Поля: `skill_type` (тип задачи/скилла, в рамках которого возникла
ошибка), `errorMessage` (сырой текст ошибки или `"channels_banned"` для
правила «2 канала за 2 дня»), `occured_at` (unix-время). `agentId` не
хранится — принадлежность агенту определяется тем, в чьей БД лежит запись.

#### Scenario: Запись создаётся, существующие записи не изменяются
- **WHEN** происходит любое из событий Requirement «Точки записи»
- **THEN** в `error_log` вставляется новая строка; существующие строки не
  изменяются и не удаляются

### Requirement: Точки записи

`error_log` SHALL пополняться при каждом возникновении ошибок
`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, `SESSION_EXPIRED`,
`AUTH_KEY_DUPLICATED`, `API_ID_INVALID`, `USER_DEACTIVATED`,
`USER_DEACTIVATED_BAN`, `FROZEN_PARTICIPANT_MISSING`,
`FROZEN_METHOD_INVALID`, `CHANNELS_TOO_MUCH`, `PEER_FLOOD`, а также при
срабатывании правила «2 канала banned за 2 дня» (`errorMessage =
"channels_banned"`) — независимо от того, создаётся ли при этом же событии
запись в `agent_restrictions`.

#### Scenario: CHANNELS_TOO_MUCH пишет в error_log без agent_restrictions
- **WHEN** `join-queue` получает `CHANNELS_TOO_MUCH` (№21)
- **THEN** в `error_log` записывается строка с `errorMessage =
  "CHANNELS_TOO_MUCH"`; запись в `agent_restrictions` при этом НЕ создаётся

#### Scenario: Запись при ошибке, уже создавшей ограничение
- **WHEN** `USER_DEACTIVATED` создаёт `agent_restrictions(banned)`
- **THEN** одновременно с этим в `error_log` записывается строка с тем же
  `errorMessage` — обе записи создаются одним и тем же событием, не
  дублируют и не заменяют друг друга (`error_log` — история срабатываний,
  `agent_restrictions` — текущее состояние)

