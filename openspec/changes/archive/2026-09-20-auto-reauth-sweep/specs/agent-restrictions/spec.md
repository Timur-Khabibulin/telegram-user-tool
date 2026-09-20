## MODIFIED Requirements

### Requirement: Схема `agent_restrictions`

Система SHALL хранить активные ограничения агентов в единой таблице
`agent_restrictions`, в БД, общей на всю платформу (не per-agent), лежащей в
workspace административного агента (`FUNNEL_ADMIN_AGENT_ID`) — по тому же
приёму, что `funnel.db`/`discovery.db`/`private-invites.db`. Одна строка на
`agentId`: наличие строки означает, что агент ограничен, отсутствие — что
нет. Поля: `agentId` (PK), `restriction_type` (`banned` |
`need_update_session` | `suspend` | `manual_reauth`), `reason` (сырой
`errorMessage` или фиксированная строка — `"channels_banned"` для правила «10
каналов banned за сутки», `"дефолтный 2FA-пароль не подошёл"` для перевода
свипом реавторизации в `manual_reauth`), `restriction_duration` (секунды;
`NULL` = бессрочно), `restricted_at` (unix-время создания).

#### Scenario: Строка создаётся при первом срабатывании триггера
- **WHEN** для агента без активного ограничения происходит одно из событий
  из Requirement «Триггеры создания ограничения»
- **THEN** создаётся строка `agent_restrictions` с `agentId`,
  соответствующим `restriction_type`, `reason` и `restriction_duration`

#### Scenario: Новое основание не может возникнуть при активном ограничении
- **WHEN** у агента уже есть активная строка `agent_restrictions`
- **THEN** диспетчер не запускает задачи этого агента (Requirement
  «Диспетчер проверяет ограничение перед запуском задач»), поэтому ошибки,
  порождающие новое основание для ограничения, не могут произойти, пока
  текущее ограничение активно

#### Scenario: manual_reauth хранится как бессрочное ограничение
- **WHEN** свип реавторизации переводит агента в `manual_reauth`
- **THEN** строка `agent_restrictions` агента имеет `restriction_type =
  manual_reauth` и `restriction_duration = NULL` (бессрочно, до ручного
  снятия)

### Requirement: Диспетчер проверяет ограничение перед запуском задач

Диспетчер SHALL проверять `agent_restrictions` для `agentId` прогона перед
подключением к Telegram, после проверки назревших задач. Активная запись
(`banned`/`need_update_session`/`manual_reauth` — всегда; `suspend` — пока
`restricted_at + restriction_duration > now`) SHALL останавливать прогон без
подключения к Telegram и без вызова LLM — задачи не выполняются в этом прогоне.

#### Scenario: manual_reauth останавливает прогон
- **WHEN** у агента активна строка `agent_restrictions` с `restriction_type =
  manual_reauth`
- **THEN** диспетчер останавливает прогон агента без подключения к Telegram и
  без вызова LLM, как и для `banned`/`need_update_session`

#### Scenario: Ограниченный агент не подключается
- **WHEN** у агента есть активное ограничение любого типа
- **THEN** диспетчер завершает прогон без `connect()` к Telegram, задачи не
  выполняются, `nextRun` задач не пересчитывается

#### Scenario: Истёкший suspend не блокирует прогон
- **WHEN** у агента есть строка `agent_restrictions(restriction_type=suspend)`
  с `restricted_at + restriction_duration <= now`
- **THEN** диспетчер удаляет строку и продолжает прогон как обычно
