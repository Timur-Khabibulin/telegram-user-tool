## MODIFIED Requirements

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
