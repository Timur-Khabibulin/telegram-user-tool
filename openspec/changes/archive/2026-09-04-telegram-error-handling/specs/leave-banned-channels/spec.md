## RENAMED Requirements

- FROM: `### Requirement: Полное удаление рабочих данных агента по каналу`
- TO: `### Requirement: Полная чистка данных агента по каналу`

## MODIFIED Requirements

### Requirement: Полная чистка данных агента по каналу

**Изменено на частичную чистку.** Скилл `leave-banned-channels`, после
успешного выхода из канала (`leaveChannel`), SHALL удалять из данных агента
только `dm_candidates` (по `sourceChatId`, в `tg-channels.db`). Строки
`channels`, `channel_visits` (в `tg-channels.db`), `replies`,
`group_threads`, `group_thread_agent_msgs` (в `tg-replies.db`) SHALL
сохраняться — не удаляются. `send_errors` и `dm_threads` по-прежнему не
затрагиваются (без изменений).

#### Scenario: Канал и история треда сохраняются после выхода
- **WHEN** `leave-banned-channels` успешно выходит из канала и обрабатывает
  строку `banned_channels`
- **THEN** строка `channels` для этого `chatId` остаётся в `tg-channels.db`
  (не удаляется), `channel_visits`/`replies`/`group_threads`/
  `group_thread_agent_msgs` для этого `chatId` тоже сохраняются

#### Scenario: dm_candidates всё ещё удаляются
- **WHEN** `leave-banned-channels` обрабатывает строку `banned_channels`
- **THEN** `dm_candidates` этого `sourceChatId` удаляются — единственная
  таблица, которая по-прежнему очищается при выходе из канала

#### Scenario: send_errors и dm_threads не затрагиваются
- **WHEN** `leave-banned-channels` обрабатывает строку `banned_channels`
- **THEN** `send_errors` (история отчёта воронки) и `dm_threads` (личные
  диалоги — другой peer) не изменяются — поведение не отличается от
  текущего

#### Scenario: Очередь самоочищается
- **WHEN** удаление данных по `chatId` завершено
- **THEN** строка с этим `chatId` удалена из `banned_channels` — это
  изменение не затрагивает поведение самой очереди, только объём
  удаляемых данных
