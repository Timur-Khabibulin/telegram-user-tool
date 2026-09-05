## RENAMED Requirements

- FROM: `### Requirement: Очередь каналов на выход`
- TO: `### Requirement: Очередь каналов на выход возвращает исходный триггер`

## MODIFIED Requirements

### Requirement: Частичная чистка данных агента по каналу

После успешного выхода система SHALL удалять из `tg-channels.db` только
`dm_candidates` (по `sourceChatId`). Строки `channels`, `channel_visits`
(`tg-channels.db`), `replies`, `group_threads`, `group_thread_agent_msgs`
(`tg-replies.db`), `send_errors` и `dm_threads` система SHALL НЕ удалять
(поведение не отличается от текущего, установлено `telegram-error-handling`).
Обновление `status` канала после чистки данных вынесено в отдельное
требование («Терминальный статус после выхода») — сброс в `NULL` больше не
выполняется.

#### Scenario: dm_candidates удаляются, остальные данные сохраняются

- **WHEN** скилл обработал канал из очереди на выход
- **THEN** `dm_candidates` этого `sourceChatId` удалены; строки `channels`/`channel_visits`/`replies`/`group_threads`/`group_thread_agent_msgs`/`send_errors`/`dm_threads` по этому `chatId` сохранены

### Requirement: Очередь каналов на выход возвращает исходный триггер

Система SHALL определять очередь каналов на выход выборкой из `channels`
(`tg-channels.db`) по условию `status IN ('banned', 'should_leave')`,
упорядоченной по `statusUpdatedAt` (по возрастанию), ограниченной лимитом
батча за один прогон. `status = 'banned'` SHALL проставляться существующим
путём (`CHAT_WRITE_FORBIDDEN`/`USER_BANNED_IN_CHANNEL`, см. capability
`group-monitoring`). Источник `status = 'should_leave'` — вне скоупа данной
способности. Выборка SHALL дополнительно возвращать сам `status` каждой
строки — вызывающий скилл использует его для выбора терминального статуса
(см. «Терминальный статус после выхода»).

#### Scenario: В очередь попадают оба статуса

- **WHEN** у агента есть канал со `status = 'banned'` и канал со `status = 'should_leave'`
- **THEN** оба канала попадают в выборку на обработку этим прогоном

#### Scenario: Лимит батча ограничивает выборку

- **WHEN** у агента больше каналов со `status IN ('banned', 'should_leave')`, чем лимит батча
- **THEN** выборка возвращает не больше лимита каналов, остальные обрабатываются на следующем прогоне

#### Scenario: Канал без нужного статуса не попадает в очередь

- **WHEN** канал имеет любой другой `status` (включая `NULL`, `'suspend'`, `'format_error'`)
- **THEN** канал не попадает в выборку на выход

#### Scenario: Выборка отдаёт status вместе с chatId

- **WHEN** выполняется выборка очереди на выход
- **THEN** каждая возвращённая строка содержит `chatId`, `statusUpdatedAt` и исходный `status` (`'banned'` или `'should_leave'`)

## ADDED Requirements

### Requirement: Терминальный статус после выхода

После успешного выхода из канала (см. «Выход из забаненного канала»,
`leave-banned-human-pacing`) система SHALL устанавливать `channels.status` в
значение, зависящее от исходного триггера очереди, вместо сброса в `NULL`:
`'banned'` → `'leaved_from_banned'`; `'should_leave'` → `'leaved_manual'`.
`statusUpdatedAt` SHALL быть установлен временем завершения выхода.
`statusDurationSeconds` и `status_description` SHALL быть сброшены в `NULL`.
Строка `channels` SHALL сохраняться (не удаляется этим шагом).

#### Scenario: Выход из-за бана канала

- **WHEN** `leaveChannel` успешен для `chatId`, чей исходный `status` был `'banned'`
- **THEN** `channels.status` этого `chatId` устанавливается в `'leaved_from_banned'`, `statusUpdatedAt` — время завершения выхода, `statusDurationSeconds`/`status_description` — `NULL`

#### Scenario: Выход по ручному решению

- **WHEN** `leaveChannel` успешен для `chatId`, чей исходный `status` был `'should_leave'`
- **THEN** `channels.status` этого `chatId` устанавливается в `'leaved_manual'`, `statusUpdatedAt` — время завершения выхода, `statusDurationSeconds`/`status_description` — `NULL`

#### Scenario: Неудачный выход не меняет статус

- **WHEN** `leaveChannel` завершается ошибкой
- **THEN** `channels.status` не изменяется (остаётся `'banned'`/`'should_leave'`), канал остаётся в очереди на выход (поведение не отличается от `leave-banned-human-pacing`)
