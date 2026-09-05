## MODIFIED Requirements

### Requirement: Ошибки подключения к Telegram классифицируются по конкретной причине

Система SHALL при невозможности установить подключение к Telegram бросать один из
следующих конкретных типов ошибок, каждый со своим самоописывающим сообщением,
вместо одного общего `ClientNotConnectedError`:

- **`MissingAccountConfigError`** — отсутствует обязательное поле аккаунта (`apiId`,
  `apiHash` или `sessionString`); сообщение называет конкретное отсутствующее поле.
- **`ConnectTimeoutError`** — все попытки подключения (`MAX_ATTEMPTS`) исчерпаны по
  таймауту; сообщение включает длительность таймаута, номер последней попытки и прокси
  (если используется).
- **`SessionRevokedError`** — Telegram вернул RPC-ошибку с кодом 401 (сессия
  невалидна/отозвана — `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, `SESSION_EXPIRED`,
  `AUTH_KEY_DUPLICATED`) либо `API_ID_INVALID` (код 400, неверный `apiId`/`apiHash` в
  `tg-account.json`); сообщение включает сырой код и текст ошибки Telegram как есть,
  без переформулирования.

Все три SHALL наследоваться от общего абстрактного класса-маркера (для существующих
`instanceof`-проверок «подключение мертво, пора останавливать прогон/цикл» — используется
в `dispatcher.ts` и `discovery/similar.ts`), который сам никогда не бросается напрямую и
не оказывается именем ошибки в логе.

#### Scenario: Каждая причина видна по имени класса и тексту

- **WHEN** подключение к Telegram не удалось по любой из трёх причин
- **THEN** тип брошенной ошибки и её `message` однозначно указывают на конкретную причину
  без необходимости смотреть `.cause` или сырые логи попыток

#### Scenario: Общий класс не логируется

- **WHEN** код перехватывает ошибку подключения через `instanceof` общего
  класса-маркера для решения «остановить прогон»
- **THEN** в логах/отчётах фигурирует конкретный подкласс (`MissingAccountConfigError` /
  `ConnectTimeoutError` / `SessionRevokedError`), а не имя общего класса-маркера

#### Scenario: API_ID_INVALID классифицируется как SessionRevokedError

- **WHEN** `connect()` завершился ошибкой `API_ID_INVALID` (код 400)
- **THEN** бросается `SessionRevokedError` с сырым текстом `API_ID_INVALID` в
  сообщении — то же поведение (реакция), что и для 401-ошибок этой группы

### Requirement: Отзыв сессии отключает все задачи агента

**Заменено на запись в `agent_restrictions`** — см. `agent-restrictions`
Requirement «Триггеры создания ограничения» (`need_update_session`). При
получении `SessionRevokedError` в любом месте (не только на `connect()`)
диспетчер SHALL создавать/обновлять `agent_restrictions(restriction_type=
need_update_session)` вместо `disableAllTasks`. `disableAllTasks`/
`tasks.enabled=0` для этой цели больше не используется.

#### Scenario: SessionRevokedError создаёт ограничение вместо отключения задач
- **WHEN** прогон любой задачи агента получил `SessionRevokedError`
- **THEN** создаётся/обновляется `agent_restrictions(need_update_session)`,
  диспетчер немедленно прекращает прогон; `tasks.enabled` строк этого агента
  не изменяется

#### Scenario: Остальные причины не меняют текущее поведение остановки
- **WHEN** прогон получил `MissingAccountConfigError` или `ConnectTimeoutError`
- **THEN** диспетчер останавливает текущий прогон как сегодня (без записи в
  `agent_restrictions`), `nextRun` сдвигается штатно, следующая попытка — на
  следующем плановом сроке

## ADDED Requirements

### Requirement: Аккаунтные ошибки классифицируются в любом MTProto-вызове, не только на подключении

Система SHALL классифицировать `USER_DEACTIVATED`, `USER_DEACTIVATED_BAN`,
`FROZEN_PARTICIPANT_MISSING`, `FROZEN_METHOD_INVALID` в любом MTProto-вызове
(не только при `connect()`/`getMe()`) через общую обёртку вокруг вызовов
`TelegramService`, бросая типизированную ошибку `AccountBannedError`.
Сообщение включает сырой код и текст ошибки Telegram как есть.
`FROZEN_METHOD_INVALID` (код 420, общий с `FLOOD_WAIT_N`/`SLOWMODE_WAIT_N`)
SHALL различаться по `errorMessage`, не по коду.

#### Scenario: USER_DEACTIVATED вне подключения классифицируется
- **WHEN** `USER_DEACTIVATED` возвращается операцией, не связанной с
  установлением соединения (например, `channels.ReadHistory`)
- **THEN** бросается `AccountBannedError`, сообщение содержит сырой текст
  `USER_DEACTIVATED`

#### Scenario: FROZEN_METHOD_INVALID отличается от FLOOD_WAIT по коду 420
- **WHEN** вызов метода возвращает ошибку с кодом 420
- **THEN** классификация проверяет `errorMessage`: `FLOOD_WAIT_N`/
  `SLOWMODE_WAIT_N` (структурные поля GramJS, см. `parseFloodWait`) — одно
  поведение, `FROZEN_METHOD_INVALID` — другое (`AccountBannedError`)

### Requirement: AccountBannedError создаёт ограничение banned

При получении `AccountBannedError` в любом месте диспетчер SHALL
создавать/обновлять `agent_restrictions(restriction_type=banned)` — см.
`agent-restrictions` Requirement «Триггеры создания ограничения». При
возникновении внутри `dm-send` (отправка DM конкретному получателю)
дополнительно сохраняется пометка кандидата `deactivated` — см. `dm-send`
Requirement «USER_DEACTIVATED при отправке DM».

#### Scenario: AccountBannedError создаёт ограничение и останавливает прогон
- **WHEN** прогон любой задачи агента получил `AccountBannedError`
- **THEN** создаётся/обновляется `agent_restrictions(banned)`, диспетчер
  немедленно прекращает прогон
