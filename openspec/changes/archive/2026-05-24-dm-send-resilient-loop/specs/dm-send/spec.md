## MODIFIED Requirements

### Requirement: dm-send skill runs daily
Скилл `dm-send` (SKILL.md) SHALL запускаться по расписанию. Алгоритм:
1. Проверить дневной лимит через `dm_history_count_today`; если `sentToday >= 15` — завершить
2. Загрузить аккаунт через `tg_load_account`
3. `dm_candidates_expire_old(3)` — удалить просроченные кандидаты
4. `dm_candidates_get_pending(limit: 100)` — получить очередь со статусом `pending`, отсортированную по `score DESC`
5. Для каждого кандидата: проверить cooldown; при активном cooldown — пометить `skipped`, перейти к следующему
6. Инициализировать счётчики: `sentThisRun = 0`, `floodErrors = 0`
7. Для каждого кандидата из отфильтрованного списка (score DESC):
   - Остановить цикл если `sentThisRun >= 2` или `sentToday >= 15`
   - Сформулировать DM через LLM
   - Вызвать `telegram_send_dm`
   - `ok` → записать в историю, пометить `sent`, `sentThisRun++`, `sentToday++`, подождать 30–60с
   - `peer_id_invalid` → пометить `skipped`, перейти к следующему (без паузы)
   - `peer_flood` → немедленно завершить прогон
   - `flood_wait` → `floodErrors++`; если `floodErrors >= 5` — завершить; иначе перейти к следующему
   - `privacy_blocked` → пометить `privacy_blocked`, перейти к следующему
   - `deactivated` → пометить `deactivated`, перейти к следующему
   - Любая другая ошибка → пометить `skipped`, перейти к следующему
8. Итоговое уведомление в Saved Messages

#### Scenario: Daily limit already reached
- **WHEN** `dm_history_count_today` возвращает `sentToday >= 15`
- **THEN** скилл немедленно завершает работу без отправки DM

#### Scenario: Per-run limit reached
- **WHEN** `sentThisRun` достигает 2
- **THEN** цикл останавливается; скилл переходит к итоговому уведомлению

#### Scenario: Successful send cycle
- **WHEN** `telegram_send_dm` возвращает `{ ok: true }` и оба лимита не исчерпаны
- **THEN** запись добавляется в `dm_history` со статусом `sent`, кандидат помечается `sent`, `sentThisRun` и `sentToday` увеличиваются на 1, выполняется пауза 30–60с

#### Scenario: peer_id_invalid — continue loop
- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_id_invalid' }` или иную неизвестную ошибку
- **THEN** кандидат помечается `skipped`, цикл продолжается со следующим кандидатом без паузы; `sentThisRun` не увеличивается

#### Scenario: Cooldown active
- **WHEN** `dm_history_check_cooldown` возвращает `canSend: false` для кандидата
- **THEN** кандидат помечается `skipped`, DM не отправляется

#### Scenario: Privacy blocked
- **WHEN** `telegram_send_dm` возвращает `{ error: 'privacy_blocked' }`
- **THEN** кандидат помечается `privacy_blocked`, цикл продолжается без паузы

#### Scenario: flood_wait — single occurrence
- **WHEN** `telegram_send_dm` возвращает `{ error: 'flood_wait' }` и `floodErrors < 5`
- **THEN** кандидат пропускается, `floodErrors` увеличивается на 1, цикл продолжается

#### Scenario: flood_wait — limit exceeded
- **WHEN** `floodErrors` достигает 5
- **THEN** прогон немедленно завершается, скилл переходит к итоговому уведомлению

#### Scenario: peer_flood — immediate stop
- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_flood' }`
- **THEN** прогон немедленно завершается, статус кандидата остаётся `pending`