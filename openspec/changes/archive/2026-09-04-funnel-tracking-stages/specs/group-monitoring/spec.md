## ADDED Requirements

### Requirement: Запись визита монитора в канал

Скилл `monitor` SHALL на каждой итерации цикла по каналам записывать визит в
таблицу `channel_visits` (`chatId`, `visitedAt`, `outcome`, `messagesCount`),
синхронно с `tg_channels_mark_processed`, независимо от исхода визита:

- нет непрочитанных сообщений → `outcome = 'empty'`, `messagesCount = 0`
- `get_messages` завершился ошибкой (кроме повторного `FLOOD_WAIT`) →
  `outcome = 'error'`, `messagesCount = 0`
- получено `messages.length === 0` сообщений → `outcome = 'empty'`,
  `messagesCount = 0`
- получено `messages.length > 0` сообщений → `outcome = 'active'`,
  `messagesCount = messages.length`

#### Scenario: Канал без непрочитанных

- **WHEN** у канала нет непрочитанных сообщений (`readInboxMaxId` не определён)
- **THEN** записывается визит с `outcome = 'empty'`, `messagesCount = 0`

#### Scenario: Ошибка получения сообщений

- **WHEN** `get_messages` завершается ошибкой, отличной от повторного `FLOOD_WAIT`
- **THEN** записывается визит с `outcome = 'error'`, `messagesCount = 0`, канал помечается обработанным, прогон переходит к следующему каналу

#### Scenario: Канал с активностью

- **WHEN** `get_messages` возвращает непустой список сообщений
- **THEN** записывается визит с `outcome = 'active'`, `messagesCount` равным числу полученных сообщений

#### Scenario: Повторный FLOOD_WAIT не пишет визит

- **WHEN** `get_messages` или отправка ответа завершаются повторным `FLOOD_WAIT` (`FloodAbortError`)
- **THEN** визит для этого канала не записывается, весь прогон скилла завершается с ошибкой

### Requirement: Запись ошибки отправки в канале

Скилл `monitor` SHALL записывать в таблицу `send_errors` (`chatId`,
`occurredAt`, `source = 'monitor'`, `errorCode`) каждый случай ошибки
`get_messages` (`errorCode = 'get_messages_error'`) и каждый случай не-flood
ошибки отправки ответа (`sendReply`), не изменяя существующую обработку
повторного `FLOOD_WAIT`.

#### Scenario: Ошибка get_messages записывается

- **WHEN** `get_messages` завершается ошибкой, отличной от повторного `FLOOD_WAIT`
- **THEN** в `send_errors` добавляется строка с `source = 'monitor'`, `errorCode = 'get_messages_error'`, `chatId` этого канала

#### Scenario: Ошибка отправки ответа записывается

- **WHEN** `sendReply` завершается не-flood ошибкой
- **THEN** в `send_errors` добавляется строка с `source = 'monitor'`, `errorCode` ошибки, `chatId` канала

### Requirement: Ошибка отправки ответа в группе не прерывает прогон

Скилл `monitor` SHALL при не-flood ошибке отправки ответа (`sendReply`, шаги
5.4/5.5/5.6) записывать ошибку (см. «Запись ошибки отправки в канале»),
помечать канал обработанным и переходить к следующему каналу батча, не
прерывая прогон для оставшихся каналов. Повторный `FLOOD_WAIT`
(`FloodAbortError`) SHALL продолжать прерывать весь прогон скилла, как и
прежде.

#### Scenario: Не-flood ошибка отправки ответа пропускает канал

- **WHEN** отправка ответа в канале завершается ошибкой, отличной от `FloodAbortError`
- **THEN** ошибка записывается в `send_errors`, канал помечается обработанным, прогон продолжается со следующего канала батча

#### Scenario: Повторный FLOOD_WAIT при отправке прерывает весь прогон

- **WHEN** отправка ответа завершается повторным `FLOOD_WAIT` (`FloodAbortError`)
- **THEN** прогон скилла завершается с ошибкой `repeated_flood_wait`, как и до этого изменения
