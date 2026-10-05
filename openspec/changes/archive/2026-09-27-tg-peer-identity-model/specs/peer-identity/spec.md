## ADDED Requirements

### Requirement: Стабильная идентичность peer хранится постоянно

Система SHALL хранить в per-agent БД стабильные сведения о каждом peer, с которым
работает агент: marked id (ключ), тип peer (`broadcast`/`megagroup`/`basic_group`),
публичный username самого peer, отображаемое название, связь обсуждение↔broadcast
(`linked_broadcast_id` и публичный хэндл канала `linked_broadcast_username`).
Стабильные сведения не зависят от авторизации и переживают переавторизацию.

#### Scenario: Идентификатор переживает переавторизацию
- **WHEN** агент проходит новую авторизацию (новая `sessionString`)
- **THEN** marked id, тип peer, публичные хэндлы и связь обсуждение↔broadcast для
  каждого известного peer остаются без изменений

#### Scenario: Публичный хэндл канала доступен как first-class идентификатор
- **WHEN** система резолвит связь обсуждение→broadcast-канал
- **THEN** публичный username связанного канала сохраняется как
  `linked_broadcast_username` и доступен для join и сверки идентичности

### Requirement: Провенанс и правило валидности access_hash

Система SHALL хранить момент получения `access_hash` (`access_hash_updated_at`) и
момент текущей авторизации (`session_authorized_at`, рядом с `sessionString`).
`access_hash` считается действительным тогда и только тогда, когда он не NULL и
`access_hash_updated_at >= session_authorized_at`. Недействительный `access_hash`
использовать запрещено.

#### Scenario: Хэш из прошлой авторизации недействителен
- **WHEN** `access_hash_updated_at` строки peer меньше `session_authorized_at`
- **THEN** система MUST считать этот `access_hash` недействительным и не строить по
  нему `InputPeer`

#### Scenario: Отсутствующий момент авторизации
- **WHEN** `session_authorized_at` не задан (унаследованный конфиг)
- **THEN** система MUST считать любой сохранённый `access_hash` недействительным

### Requirement: Новая авторизация фиксирует момент авторизации

Когда система записывает новую `sessionString` в конфиг агента, она SHALL в той же
операции проставить `session_authorized_at = now`. Это относится ко всем точкам
создания сессии (реавторизация из tdata, автогенерация агента, провижининг пула,
интерактивный логин).

#### Scenario: Reauth фиксирует момент и не трогает БД
- **WHEN** агент переавторизуется и записывается новая `sessionString`
- **THEN** `session_authorized_at` обновляется на текущее время в конфиге агента
- **AND** per-agent БД идентичности при этом не изменяется

### Requirement: Переполучение access_hash по стабильному id

Когда действительного `access_hash` нет, система SHALL переполучить его для peer,
в котором агент состоит, по стабильному marked id через проход диалогов текущей
авторизации, без резолва по username. Полученный `access_hash` перезаписывается
вместе с `access_hash_updated_at = now`.

#### Scenario: Переполучение приватного обсуждения без username
- **WHEN** `access_hash` недействителен для peer без публичного username, в котором
  агент состоит
- **THEN** система получает свежий `access_hash` проходом диалогов по marked id и
  перезаписывает его с новым `access_hash_updated_at`

#### Scenario: Peer недоступен
- **WHEN** peer не найден в диалогах при переполучении
- **THEN** система сигнализирует «peer недоступен», при необходимости помечает
  `membership = not_found`, и не выполняет операцию по нему в этот прогон

### Requirement: Инвалидация access_hash при отказе API

Если операция над конкретным peer возвращает `PEER_ID_INVALID` или
`CHANNEL_INVALID`, система SHALL обнулить `access_hash` и `access_hash_updated_at`
этого peer и переполучить его при следующем обращении.

#### Scenario: Серверная ротация хэша
- **WHEN** обращение к peer с формально валидным таймстампом возвращает
  `CHANNEL_INVALID`
- **THEN** система обнуляет `access_hash`/`access_hash_updated_at` этого peer и на
  следующем обращении переполучает его

### Requirement: basic group адресуется без access_hash

Для peer типа `basic_group` система SHALL строить `InputPeer` по одному marked id,
без `access_hash`, и поддерживать по нему полноценные операции join / read / leave.

#### Scenario: Операция над basic group
- **WHEN** выполняется read или leave по peer типа `basic_group`
- **THEN** система строит `InputPeerChat` по marked id без обращения к `access_hash`

### Requirement: Членство хранится отдельным полем

Система SHALL хранить факт членства агента в peer в отдельном поле `membership`
(`member`/`left`/`banned`/`not_found`) как в единственном доме этого факта. На
переходный период `membership` пишется рядом с существующим `status` (dual-write) в
той же операции; `status` не вычищается, и потребители `status` не меняются.

#### Scenario: Dual-write при смене членства
- **WHEN** происходит событие join / leave / ban / not_found и записывается
  соответствующее значение `status`
- **THEN** в той же операции проставляется соответствующее `membership` и
  `membership_updated_at = now`

#### Scenario: should_leave не меняет членство
- **WHEN** каналу проставлен `status = should_leave`
- **THEN** `membership` остаётся `member` (агент ещё в чате), а намерение выхода
  остаётся в `status`

### Requirement: Миграция basic group в супергруппу не теряет чат

Когда basic group мигрирует в супергруппу (у объекта `chat` взведён `deactivated`
и заполнен `migrated_to`), система SHALL сохранить преемственность: пометить старую
строку `migrated_to_id` на новый marked id, а новую супергруппу завести как
`megagroup`, подпадающую под правило `access_hash`.

#### Scenario: Апгрейд basic group
- **WHEN** система обнаруживает миграцию basic group в супергруппу
- **THEN** старая строка получает `migrated_to_id` = marked id новой megagroup и
  `membership = left`, а новая megagroup заводится с `membership = member`
- **AND** чат не теряется из покрытия агента

### Requirement: Замена аккаунта сбрасывает per-account идентичность

При замене Telegram-аккаунта агента система SHALL сбросить per-account сведения
(`access_hash`, `membership`) и восстановить их повторным вступлением в закреплённые
за агентом каналы; закрепление каналов за агентом (кросс-аккаунтный факт) при этом
сохраняется отдельно от per-account БД.

#### Scenario: После замены аккаунта агент возвращается в те же каналы
- **WHEN** аккаунт агента заменён
- **THEN** новый аккаунт повторно вступает в закреплённые за агентом каналы и
  получает свежие `access_hash`, не используя сведения прошлого аккаунта
