## REMOVED Requirements

### Requirement: Очередь забаненных каналов

**Reason**: Таблица `banned_channels` дублировала факт, уже хранимый в
`channels.status = 'banned'` (проставляется синхронно в тех же местах кода).
Источником очереди на выход становится `channels.status`.
**Migration**: см. `MODIFIED Requirements` → «Очередь каналов на выход» в этом
файле; см. `design.md` → Migration Plan для миграции накопленных строк.

Система SHALL хранить per-agent очередь каналов с `CHAT_WRITE_FORBIDDEN` в
таблице `banned_channels` (`tg-channels.db`) с ключом `chatId` и временем
обнаружения. Постановка в очередь SHALL быть идемпотентной (`INSERT OR IGNORE`):
повторная ошибка по тому же каналу не создаёт дубль.

#### Scenario: Канал ставится в очередь один раз

- **WHEN** монитор дважды получает `CHAT_WRITE_FORBIDDEN` для одного `chatId` до обработки очереди
- **THEN** в `banned_channels` существует ровно одна строка с этим `chatId`

#### Scenario: Очередь создаётся при первом обращении

- **WHEN** запись в `banned_channels` происходит впервые (таблицы ещё нет)
- **THEN** таблица создаётся идемпотентно, запись выполняется без ошибки

## RENAMED Requirements

- FROM: `### Requirement: Полная чистка данных агента по каналу`
- TO: `### Requirement: Частичная чистка данных агента по каналу`

## MODIFIED Requirements

### Requirement: Выход из забаненного канала

Скилл `leave-banned-channels` SHALL для каждого `chatId` из очереди (см.
«Очередь каналов на выход») выходить из канала через `leaveChannel` (MTProto
`channels.LeaveChannel`) до удаления данных. Между `resolveChannelUsername` и
`leaveChannel` система SHALL выдерживать случайную паузу в диапазоне 10–20
секунд. Если выход завершился ошибкой, система SHALL не удалять данные, не
помечать реестр и не изменять `status` канала, оставив его в очереди для
повторной обработки на следующем прогоне.

#### Scenario: Успешный выход предшествует удалению

- **WHEN** скилл обрабатывает `chatId` из очереди и `leaveChannel` успешен
- **THEN** далее выполняются удаление данных агента, (при возможности) пометка реестра и сброс `status` канала

#### Scenario: Пауза между resolve и leave

- **WHEN** скилл обрабатывает `chatId` из очереди
- **THEN** между вызовом `resolveChannelUsername` и вызовом `leaveChannel` проходит случайная пауза в диапазоне 10–20 секунд

#### Scenario: Выход не удался — обработка откладывается

- **WHEN** `leaveChannel` для `chatId` завершается ошибкой
- **THEN** данные не удаляются, реестр не помечается, `status` канала не изменяется, канал остаётся в очереди на выход

### Requirement: Частичная чистка данных агента по каналу

После успешного выхода система SHALL удалять из `tg-channels.db` только
`dm_candidates` (по `sourceChatId`). Строки `channels`, `channel_visits`
(`tg-channels.db`), `replies`, `group_threads`, `group_thread_agent_msgs`
(`tg-replies.db`), `send_errors` и `dm_threads` система SHALL НЕ удалять
(поведение не отличается от текущего, установлено `telegram-error-handling`).
После этого система SHALL сбросить `status`, `statusUpdatedAt`,
`statusDurationSeconds` и `status_description` канала в `NULL` — строка
`channels` сохраняется, снимается только пометка бана/выхода.

#### Scenario: dm_candidates удаляются, остальные данные и статус-строка сохраняются

- **WHEN** скилл обработал канал из очереди на выход
- **THEN** `dm_candidates` этого `sourceChatId` удалены; строки `channels`/`channel_visits`/`replies`/`group_threads`/`group_thread_agent_msgs`/`send_errors`/`dm_threads` по этому `chatId` сохранены

#### Scenario: Статус канала снимается после обработки

- **WHEN** удаление данных по `chatId` завершено
- **THEN** `status` (и связанные поля `statusUpdatedAt`/`statusDurationSeconds`/`status_description`) этого `chatId` в `channels` сброшены в `NULL`

## ADDED Requirements

### Requirement: Очередь каналов на выход

Система SHALL определять очередь каналов на выход выборкой из `channels`
(`tg-channels.db`) по условию `status IN ('banned', 'should_leave')`,
упорядоченной по `statusUpdatedAt` (по возрастанию), ограниченной лимитом
батча за один прогон. `status = 'banned'` SHALL проставляться существующим
путём (`CHAT_WRITE_FORBIDDEN`/`USER_BANNED_IN_CHANNEL`, см. capability
`group-monitoring`). Источник `status = 'should_leave'` — вне скоупа данной
способности.

#### Scenario: В очередь попадают оба статуса

- **WHEN** у агента есть канал со `status = 'banned'` и канал со `status = 'should_leave'`
- **THEN** оба канала попадают в выборку на обработку этим прогоном

#### Scenario: Лимит батча ограничивает выборку

- **WHEN** у агента больше каналов со `status IN ('banned', 'should_leave')`, чем лимит батча
- **THEN** выборка возвращает не больше лимита каналов, остальные обрабатываются на следующем прогоне

#### Scenario: Канал без нужного статуса не попадает в очередь

- **WHEN** канал имеет любой другой `status` (включая `NULL`, `'suspend'`, `'format_error'`)
- **THEN** канал не попадает в выборку на выход

### Requirement: Опциональное чтение сообщений перед выходом

Между `resolveChannelUsername` и `leaveChannel` система MAY (по случайному
гейту, определяемому для каждого канала независимо) выполнить от 1 до 3
(случайно) батчей чтения сообщений канала (`getMessages`, случайный размер
батча 7–15) с вызовом `markAsRead` после каждого батча. Между батчами SHALL
выдерживаться случайная пауза 3–7 секунд (кроме как после последнего батча).
Эта пауза MAY выполняться дополнительно к паузе 10–20 секунд между
`resolveChannelUsername` и `leaveChannel` (не вместо неё).

#### Scenario: Чтение не сработало для канала

- **WHEN** случайный гейт для канала не сработал
- **THEN** `getMessages` для этого канала не вызывается, обработка продолжается стандартной паузой перед `leaveChannel`

#### Scenario: Чтение сработало — несколько батчей с разметкой прочитанным

- **WHEN** случайный гейт для канала сработал
- **THEN** выполняется от 1 до 3 вызовов `getMessages` (7–15 сообщений каждый), после каждого — `markAsRead`, с паузой 3–7 секунд между батчами

### Requirement: Пауза между каналами очереди

Между обработкой каналов очереди (после завершения обработки одного `chatId`,
перед переходом к следующему) система SHALL выдерживать случайную паузу в
диапазоне 2–7 секунд.

#### Scenario: Пауза выдерживается между каналами

- **WHEN** скилл обработал один `chatId` из очереди и переходит к следующему
- **THEN** между обработкой каналов проходит случайная пауза в диапазоне 2–7 секунд
