# dm-send Specification

## Purpose
TBD - normalized from legacy archive format. Update Purpose after archive.
## Requirements
### Requirement: telegram_send_dm sends a direct message
Инструмент `telegram_send_dm(userId, accessHash, text)` SHALL конструировать `InputPeerUser`
из переданных параметров и отправлять сообщение через MTProto. Не зависит от `peerCache`.

#### Scenario: Successful DM
- **WHEN** `telegram_send_dm` вызывается с валидными `userId`, `accessHash` и `text`
- **THEN** возвращается `{ ok: true, messageId: <id> }`

#### Scenario: Privacy restricted
- **WHEN** пользователь запретил входящие сообщения (ошибка `USER_PRIVACY_RESTRICTED`)
- **THEN** возвращается `{ error: 'privacy_blocked' }`

#### Scenario: Deactivated user
- **WHEN** аккаунт пользователя деактивирован (`USER_DEACTIVATED`)
- **THEN** возвращается `{ error: 'deactivated' }`

#### Scenario: FLOOD_WAIT handled
- **WHEN** Telegram возвращает `FLOOD_WAIT_X`
- **THEN** инструмент ждёт X секунд и делает одну повторную попытку;
  при повторном `FLOOD_WAIT` возвращает `{ error: 'flood_wait' }`

### Requirement: dm-send skill runs daily
Скилл `dm-send` (SKILL.md) SHALL запускаться по расписанию. Алгоритм:
1. Проверить дневной лимит через `dm_threads_count_today`; если `count >= 15` — завершить
2. Загрузить аккаунт через `tg_load_account`
3. `dm_candidates_expire_old(3)` — удалить просроченные кандидаты
4. `dm_candidates_get_pending(limit: 100)` — получить очередь со статусом `pending`, отсортированную по `score DESC`
5. Инициализировать счётчики: `sentThisRun = 0`, `floodErrors = 0`
6. Для каждого кандидата из списка (score DESC):
   - Остановить цикл если `sentThisRun >= 2` или `sentToday >= 15`
   - Вызвать `dm_threads_exists(userId)`:
     - `exists: true, cooldownActive: true` → пометить кандидата `skipped`, перейти к следующему
     - `exists: true, cooldownActive: false` → вызвать `dm_threads_delete(userId)`, продолжить отправку
     - `exists: false` → продолжить отправку
   - Сформулировать DM через LLM
   - Вызвать `telegram_send_dm`
   - `ok` → `dm_threads_create(userId, userAccessHash, userName, fromChatId, triggerMessage, firstMessage)`, пометить кандидата `sent`, `sentThisRun++`, `sentToday++`, подождать 30–60с
   - `peer_id_invalid` → пометить `skipped`, перейти к следующему (без паузы)
   - `peer_flood` → немедленно завершить прогон; **дополнительно** создать/обновить `agent_restrictions(suspend, restriction_duration=86400)` и запись в `error_log` (`skill_type='dm-send'`) — см. `agent-restrictions` Requirement «Триггеры создания ограничения»
   - `flood_wait` → до 2 повторов ожидания (см. `group-monitoring` Requirement «Политика повтора FLOOD_WAIT/SLOWMODE_WAIT»); если исчерпаны — `floodErrors++`; если `floodErrors >= 5` — завершить; иначе перейти к следующему
   - `deactivated` → пометить `deactivated`, **дополнительно** создать/обновить `agent_restrictions(banned)` и запись в `error_log` (`skill_type='dm-send'`) — ошибка одного получателя останавливает весь агент до ручного снятия ограничения; перейти к следующему кандидату (в рамках уже начатого прогона — прогон не прерывается этим шагом, ограничение блокирует только СЛЕДУЮЩИЕ прогоны)
   - `privacy_blocked` → пометить `privacy_blocked`, перейти к следующему
   - Любая другая ошибка → пометить `skipped`, перейти к следующему
7. Итоговое уведомление в Saved Messages

#### Scenario: Daily limit already reached
- **WHEN** `dm_threads_count_today` возвращает `count >= 15`
- **THEN** скилл немедленно завершает работу без отправки DM

#### Scenario: Per-run limit reached
- **WHEN** `sentThisRun` достигает 2
- **THEN** цикл останавливается; скилл переходит к итоговому уведомлению

#### Scenario: Successful send cycle
- **WHEN** `telegram_send_dm` возвращает `{ ok: true }` и оба лимита не исчерпаны
- **THEN** создаётся тред через `dm_threads_create` с первым сообщением агента, кандидат помечается `sent`, `sentThisRun` и `sentToday` увеличиваются на 1, выполняется пауза 30–60с

#### Scenario: Cooldown active — skip candidate
- **WHEN** `dm_threads_exists` возвращает `{ exists: true, cooldownActive: true }`
- **THEN** кандидат помечается `skipped`, DM не отправляется

#### Scenario: Cooldown expired — delete old thread and send
- **WHEN** `dm_threads_exists` возвращает `{ exists: true, cooldownActive: false }`
- **THEN** старый тред удаляется через `dm_threads_delete(userId)`, затем DM отправляется и создаётся новый тред с чистым контекстом

#### Scenario: No existing thread — send normally
- **WHEN** `dm_threads_exists` возвращает `{ exists: false }`
- **THEN** DM отправляется и создаётся новый тред через `dm_threads_create`

#### Scenario: peer_id_invalid — continue loop
- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_id_invalid' }` или иную неизвестную ошибку
- **THEN** кандидат помечается `skipped`, цикл продолжается со следующим кандидатом без паузы; `sentThisRun` не увеличивается

#### Scenario: Privacy blocked
- **WHEN** `telegram_send_dm` возвращает `{ error: 'privacy_blocked' }`
- **THEN** кандидат помечается `privacy_blocked`, цикл продолжается без паузы

#### Scenario: flood_wait — исчерпаны повторы
- **WHEN** `telegram_send_dm` вернул `{ error: 'flood_wait' }` после исчерпания
  повторов ожидания и `floodErrors < 5`
- **THEN** кандидат пропускается, `floodErrors` увеличивается на 1, цикл продолжается

#### Scenario: flood_wait — limit exceeded
- **WHEN** `floodErrors` достигает 5
- **THEN** прогон немедленно завершается, скилл переходит к итоговому уведомлению

#### Scenario: peer_flood — immediate stop и ограничение агента
- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_flood' }`
- **THEN** прогон немедленно завершается, статус кандидата остаётся `pending`;
  создаётся/обновляется `agent_restrictions(suspend, restriction_duration=86400)`
  и запись в `error_log`

#### Scenario: deactivated — пометка кандидата и ограничение агента
- **WHEN** `telegram_send_dm` возвращает `{ error: 'deactivated' }`
- **THEN** кандидат помечается `deactivated`; создаётся/обновляется
  `agent_restrictions(banned)` и запись в `error_log`; текущий прогон
  продолжается (ограничение блокирует только следующие прогоны диспетчера)

### Requirement: Запись ошибки отправки DM

Скилл `dm-send` SHALL записывать в таблицу `send_errors` (`chatId =
candidate.sourceChatId`, `occurredAt`, `source = 'dm_send'`, `errorCode`)
каждый исход ошибки `telegram_send_dm` (`peer_flood`, `flood_wait`,
`privacy_blocked`, `deactivated`, `peer_id_invalid` и любой иной), не изменяя
существующую логику управления потоком (`stopReason`, `floodErrors`,
переходы `break`/`continue`).

#### Scenario: peer_flood записывается перед остановкой прогона

- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_flood' }`
- **THEN** ошибка записывается в `send_errors` с `errorCode = 'peer_flood'`, после чего прогон завершается как и прежде (кандидат остаётся `pending`)

#### Scenario: flood_wait записывается на каждое повторение

- **WHEN** `telegram_send_dm` возвращает `{ error: 'flood_wait' }`
- **THEN** ошибка записывается в `send_errors` с `errorCode = 'flood_wait'` при каждом таком исходе, `floodErrors` увеличивается как и прежде

#### Scenario: privacy_blocked и deactivated записываются

- **WHEN** `telegram_send_dm` возвращает `{ error: 'privacy_blocked' }` или `{ error: 'deactivated' }`
- **THEN** ошибка записывается в `send_errors` с соответствующим `errorCode`, кандидат помечается как и прежде, цикл продолжается без паузы

#### Scenario: peer_id_invalid и прочие ошибки записываются

- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_id_invalid' }` или иную неизвестную ошибку
- **THEN** ошибка записывается в `send_errors` с этим `errorCode`, кандидат помечается `skipped` как и прежде

#### Scenario: Успешная отправка не пишет ошибку

- **WHEN** `telegram_send_dm` возвращает `{ ok: true }`
- **THEN** в `send_errors` ничего не записывается

