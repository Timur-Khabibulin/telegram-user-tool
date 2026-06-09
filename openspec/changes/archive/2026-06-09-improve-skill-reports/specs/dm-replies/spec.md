## MODIFIED Requirements

### Requirement: dm-replies skill handles incoming DMs via push-model
Скилл `dm-replies` (SKILL.md) SHALL запускаться каждые 30 минут.
Работает только с 08:00 до 01:00 UTC+5. Алгоритм:
1. Проверить время UTC+5; вне диапазона 08:00–01:00 → завершить
2. Загрузить аккаунт через `tg_load_account`
3. `telegram_get_dm_dialogs()` → список DM-чатов с `unreadCount > 0`; заполняет `peerCache`
4. Если список пуст → завершить
5. `dm_threads_get_by_users(users)` → совпадения с тредами (+ обновление accessHash/userName);
   `notFound` — игнорировать (DM от пользователей без тредов)
6. Если `threads` пуст → завершить
7. Для каждого совпадения:
   - 7.1 `telegram_get_messages(chatId=userId, minId=<последний msgId>)` → новые сообщения
   - 7.2 **Один структурированный LLM-вызов**: тональность последнего сообщения + ответ с контекстом (`triggerMessage` + `thread.messages` до 50 + новые сообщения) → `{ sentiment: positive | negative, ответ: string | null }`. При `negative` ответ не генерируется (поле пустое).
   - 7.3 Если `sentiment = negative` → `telegram_mark_as_read(chatId=userId)`, перейти к следующему
   - 7.4 `telegram_send_dm(userId, text=ответ)` → отправить сгенерированный ответ
   - 7.5 `dm_threads_update_msgs(userId, newMessages)` → обновить messages и lastActivityAt
   - 7.6 `telegram_mark_as_read(chatId=userId)` — последний шаг обработки

#### Scenario: Out of hours — no action
- **WHEN** текущее время UTC+5 вне диапазона 08:00–01:00
- **THEN** скилл завершает работу без каких-либо действий

#### Scenario: No unread DMs
- **WHEN** `telegram_get_dm_dialogs` возвращает пустой список
- **THEN** скилл завершает работу без дальнейших действий

#### Scenario: Unread DM from unknown user (no thread)
- **WHEN** `telegram_get_dm_dialogs` возвращает userId без треда в `dm_threads`
- **THEN** userId попадает в `notFound` и игнорируется; тред создаётся только через `dm-send`

#### Scenario: Positive reply — full context response
- **WHEN** пользователь прислал сообщение с позитивной/нейтральной тональностью
- **THEN** один структурированный вызов возвращает `sentiment=positive` и готовый `ответ`; агент отправляет его через `telegram_send_dm`, обновляет тред, вызывает `mark_as_read`

#### Scenario: Negative sentiment — mark as read and skip
- **WHEN** структурированный вызов возвращает `sentiment=negative` (агрессия, "спам", "отпишись")
- **THEN** `ответ` пуст, `telegram_mark_as_read`, ответ не отправляется, тред сохраняется

#### Scenario: One LLM call per thread
- **WHEN** для треда есть новые сообщения пользователя
- **THEN** анализ тональности и генерация ответа выполняются одним LLM-вызовом, а не двумя

#### Scenario: Multiple messages from user in one run
- **WHEN** пользователь отправил несколько сообщений между прогонами
- **THEN** все добавляются в `messages`, агент отвечает одним сообщением

#### Scenario: mark_as_read called last
- **WHEN** обработка пользователя завершена
- **THEN** `telegram_mark_as_read` вызывается последним шагом

#### Scenario: privacy_blocked during reply
- **WHEN** `telegram_send_dm` возвращает `{ error: 'privacy_blocked' }`
- **THEN** `mark_as_read`, переход к следующему (тред сохраняется)

#### Scenario: flood_wait during reply
- **WHEN** `telegram_send_dm` возвращает `{ error: 'flood_wait' }`
- **THEN** прогон немедленно прерывается

#### Scenario: peer_id_invalid during reply
- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_id_invalid' }`
- **THEN** `mark_as_read`, переход к следующему; accessHash обновится на следующем прогоне