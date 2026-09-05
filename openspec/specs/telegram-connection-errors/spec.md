# telegram-connection-errors Specification

## Purpose
TBD - created by archiving change mobile-proxy-provisioning. Update Purpose after archive.
## Requirements
### Requirement: Временный override прокси и бюджета попыток без изменения конфигурации аккаунта

`TelegramService.ensureClient()`/`requireClient()` SHALL принимать необязательный override —
прокси и/или бюджет попыток (число попыток, таймаут на попытку) — используемый вместо значений
из `AccountConfig`, загруженного `loadAccount()`. Override SHALL не читать и не изменять
`tg-account.json` — действует только на время конкретного вызова. Без override поведение SHALL
быть идентично поведению без этой возможности (обычный бюджет и прокси из персистентного
конфига аккаунта).

#### Scenario: Override не влияет на персистентный конфиг

- **WHEN** `ensureClient()` вызван с override-прокси, отличным от того, что записан в
  `tg-account.json`
- **THEN** соединение устанавливается с override-прокси, но `tg-account.json` не читается для
  прокси и не изменяется этим вызовом

#### Scenario: Классификация ошибок одинакова для override и обычного пути

- **WHEN** соединение с override-прокси не удаётся
- **THEN** бросается тот же набор классов ошибок (`ConnectTimeoutError`/`SessionRevokedError`/
  `MissingAccountConfigError`), что и при обычном подключении — отдельной ветки классификации
  для override нет

#### Scenario: Вызовы без override не меняют поведение

- **WHEN** `ensureClient()`/`requireClient()` вызваны без override-параметра
- **THEN** используются прокси и бюджет (`MAX_ATTEMPTS=3`, `CONNECT_TIMEOUT_MS=60_000`) из
  `AccountConfig`, как до появления этой возможности

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

### Requirement: Причина ошибки отражается в логе и отчёте без раскопок

Диспетчер SHALL записывать конкретное сообщение брошенной ошибки в `runs.error` и в
отчёт Saved Messages через существующий `formatError()`, без дополнительного механизма
показа причины.

#### Scenario: runs.error содержит причину

- **WHEN** прогон завершился ошибкой подключения к Telegram
- **THEN** `runs.error` содержит текст, из которого однозначно понятно, какая из трёх
  причин произошла (например «401: AUTH_KEY_UNREGISTERED» или «connect timed out after
  60s (попытка 3/3, proxy <PROXY_HOST>:443)»)

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

