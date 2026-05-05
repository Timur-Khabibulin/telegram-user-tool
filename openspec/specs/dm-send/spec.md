## ADDED Requirements

### Requirement: telegram_send_dm sends a direct message
Инструмент `telegram_send_dm(userId, accessHash, text)` SHALL конструировать `InputPeerUser` из переданных параметров и отправлять сообщение через MTProto. Не зависит от `peerCache`.

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
- **THEN** инструмент ждёт X секунд и делает одну повторную попытку; при повторном `FLOOD_WAIT` возвращает `{ error: 'flood_wait' }`

### Requirement: dm-send skill runs daily
Скилл `dm-send` (SKILL_DM_SEND.md) SHALL запускаться один раз в день в 10:00 UTC+5. Алгоритм:
1. Проверить дневной лимит через `dm_history_count_today`; если ≥ 15 — завершить
2. `dm_candidates_expire_old(3)` — чистит просроченные
3. `dm_candidates_get_pending(limit=100)` — получить очередь
4. Для каждого кандидата: проверить cooldown; при активном cooldown — `skipped`
5. LLM выбирает топ 10–15: учитывает `score`, не более 2–3 из одного `sourceChatId`
6. Для каждого выбранного: сформулировать DM, вызвать `telegram_send_dm`, записать результат, подождать 30–60с; вести счётчик `floodErrors` — при `flood_wait` увеличивать счётчик и пропускать кандидата; при `floodErrors ≥ 5` завершить прогон
7. Итоговое уведомление в Saved Messages

#### Scenario: Daily limit already reached
- **WHEN** `dm_history_count_today` возвращает ≥ 15
- **THEN** скилл немедленно завершает работу без отправки DM

#### Scenario: Successful send cycle
- **WHEN** в очереди есть кандидаты, лимит не исчерпан, cooldown не активен
- **THEN** DM отправляется, запись добавляется в `dm_history` со статусом `sent`, кандидат помечается `sent`

#### Scenario: Privacy blocked
- **WHEN** `telegram_send_dm` возвращает `{ error: 'privacy_blocked' }`
- **THEN** в `dm_history` добавляется запись со статусом `privacy_blocked`, кандидат помечается `skipped`

#### Scenario: Cooldown active
- **WHEN** `dm_history_check_cooldown` возвращает `false` для кандидата
- **THEN** кандидат помечается `skipped`, DM не отправляется

#### Scenario: flood_wait — single occurrence
- **WHEN** `telegram_send_dm` возвращает `{ error: 'flood_wait' }` и суммарное число таких ошибок за прогон < 5
- **THEN** кандидат пропускается, `floodErrors` увеличивается на 1, прогон продолжается со следующим кандидатом

#### Scenario: flood_wait — limit exceeded
- **WHEN** количество ошибок `flood_wait` за прогон достигает 5
- **THEN** прогон немедленно завершается, скилл переходит к итоговому уведомлению

#### Scenario: Summary notification sent
- **WHEN** цикл отправки завершён
- **THEN** в Saved Messages отправляется отчёт: отправлено / пропущено / ошибок / осталось в очереди
