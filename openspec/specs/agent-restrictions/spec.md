# agent-restrictions Specification

## Purpose
TBD - created by archiving change telegram-error-handling. Update Purpose after archive.
## Requirements
### Requirement: Схема `agent_restrictions`

Система SHALL хранить активные ограничения агентов в единой таблице
`agent_restrictions`, в БД, общей на всю платформу (не per-agent), лежащей в
workspace административного агента (`FUNNEL_ADMIN_AGENT_ID`) — по тому же
приёму, что `funnel.db`/`discovery.db`/`private-invites.db`. Одна строка на
`agentId`: наличие строки означает, что агент ограничен, отсутствие — что
нет. Поля: `agentId` (PK), `restriction_type` (`banned` |
`need_update_session` | `suspend` | `manual_reauth`), `reason` (сырой
`errorMessage` или фиксированная строка — `"channels_banned"` для правила «30
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

### Requirement: Триггеры создания ограничения

Ограничение SHALL создаваться/обновляться по следующим триггерам:

- `need_update_session` — ошибки `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`,
  `SESSION_EXPIRED`, `AUTH_KEY_DUPLICATED`, `API_ID_INVALID`, возникшие в
  любом месте (не только при подключении); `restriction_duration = NULL`.
- `banned` — ошибки `USER_DEACTIVATED`, `USER_DEACTIVATED_BAN`,
  `FROZEN_PARTICIPANT_MISSING`, `FROZEN_METHOD_INVALID`, возникшие в любом
  месте; `restriction_duration = NULL`.
- `suspend` (триггер 1) — ошибка `PEER_FLOOD`, возникшая при отправке DM или
  ответа в канал; `restriction_duration = 86400` (сутки — явно переопределяет
  дефолт).
- `suspend` (триггер 2) — у агента минимум 30 каналов со `channels.status =
  'banned'`, у каждого `channels.statusUpdatedAt` не ранее 1 суток назад;
  `reason = "channels_banned"`; `restriction_duration = 259200` (3 дня,
  дефолт).

#### Scenario: Аккаунтная ошибка вне подключения создаёт ограничение
- **WHEN** `USER_DEACTIVATED` возникает во время вызова, не связанного с
  `connect()` (например, при отметке чата прочитанным)
- **THEN** создаётся `agent_restrictions(restriction_type=banned)`, как и при
  возникновении на `connect()`

#### Scenario: PEER_FLOOD при ответе в канал (не только DM)
- **WHEN** `PEER_FLOOD` возникает при отправке ответа в группу (`monitor-v2`),
  а не только при отправке DM (`dm-send`)
- **THEN** создаётся `agent_restrictions(restriction_type=suspend,
  restriction_duration=86400)`, текущий прогон немедленно останавливается

#### Scenario: Тридцатый забаненный канал за сутки создаёт suspend
- **WHEN** у агента уже есть двадцать девять каналов со `status='banned'` и
  `statusUpdatedAt` в последние сутки, и тридцатый канал получает
  `status='banned'` тоже в пределах последних суток
- **THEN** создаётся `agent_restrictions(restriction_type=suspend,
  reason="channels_banned", restriction_duration=259200)` тем же шагом, что
  и простановка статуса тридцатого канала

#### Scenario: Менее 30 забаненных каналов не создают suspend
- **WHEN** у агента менее 30 каналов со `status='banned'` за последние сутки
- **THEN** `agent_restrictions` не создаётся по правилу «30 каналов за сутки»

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

### Requirement: Снятие ограничения

`banned` SHALL сниматься автоматически — по успешному завершению авто-замены
аккаунта (sweep `banned-account-replacement` снимает ограничение последним шагом,
после успешной активации нового аккаунта) — либо вручную (прямое удаление строки
человеком). `need_update_session` SHALL сниматься только вручную либо успешной
реавторизацией. `suspend` SHALL сниматься автоматически, когда
`restricted_at + restriction_duration <= now`.

#### Scenario: Suspend снимается автоматически
- **WHEN** диспетчер обнаруживает истёкший `suspend` при проверке перед
  запуском задач
- **THEN** строка удаляется, задачи агента возобновляются в этом же прогоне

#### Scenario: Banned снимается успешной авто-заменой
- **WHEN** sweep авто-замены успешно подменяет аккаунт агента и завершает его
  активацию
- **THEN** строка `agent_restrictions(restriction_type=banned)` снимается тем же
  прогоном (commit point), и агент возвращается в рабочий контур

#### Scenario: Banned без замены не снимается сам по себе
- **WHEN** у агента есть `agent_restrictions(restriction_type=banned)`, замена не
  выполнена (пул пуст либо замена не завершена), и проходит произвольное время
- **THEN** строка остаётся, диспетчер продолжает останавливать прогоны, пока её не
  снимет успешная авто-замена или человек вручную

