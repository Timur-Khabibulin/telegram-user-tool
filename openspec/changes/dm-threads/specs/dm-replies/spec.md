## MODIFIED Requirements

### Requirement: dm-replies skill handles incoming DMs
Скилл `dm-replies` (SKILL.md) SHALL запускаться каждые 30 минут. Работает только с 08:00 до 01:00 UTC+5. Алгоритм:
1. Проверить время UTC+5; вне диапазона 08:00–01:00 → завершить
2. Загрузить аккаунт через `tg_load_account`
3. `telegram_get_dm_dialogs()` → список DM-чатов с `unreadCount > 0`; заполняет `peerCache`
4. Если список пуст → завершить
5. `dm_threads_get_by_users(users: [...])` → совпадения с тредами (+ обновление `accessHash`/`userName`); `notFound` — игнорировать (DM от незнакомых пользователей без тредов)
6. Если `threads` пуст → завершить
7. Для каждого совпадения:
   - 7.1 `telegram_get_messages(chatId=userId, minId=<последний msgId из thread.messages>)` → новые сообщения пользователя
   - 7.2 Sentiment analysis (LLM): оценить тональность последнего сообщения пользователя → `positive` / `negative`
   - 7.3 Если `negative` → `telegram_mark_as_read(chatId=userId)`, перейти к следующему (тред сохраняется)
   - 7.4 LLM генерирует ответ с полным контекстом: `triggerMessage` + `thread.messages` (до 50 сообщений) + новые сообщения пользователя
   - 7.5 `telegram_send_dm(userId, text)` → отправить ответ
   - 7.6 `dm_threads_update_msgs(userId, newMessages=[...userMsgs, agentMsg])` → обновить `messages` JSON и `lastActivityAt`
   - 7.7 `telegram_mark_as_read(chatId=userId)` — последний шаг обработки

#### Scenario: Out of hours — no action
- **WHEN** текущее время UTC+5 вне диапазона 08:00–01:00
- **THEN** скилл завершает работу без каких-либо действий

#### Scenario: No unread DMs
- **WHEN** `telegram_get_dm_dialogs` возвращает пустой список
- **THEN** скилл завершает работу без дальнейших действий

#### Scenario: Unread DM from unknown user (no thread)
- **WHEN** `telegram_get_dm_dialogs` возвращает userId, для которого нет треда в `dm_threads`
- **THEN** этот userId попадает в `notFound` и игнорируется; тред создаётся только через `dm-send`

#### Scenario: Positive reply — full context response
- **WHEN** пользователь прислал сообщение с позитивной/нейтральной тональностью
- **THEN** агент генерирует ответ с контекстом (`triggerMessage` + полная цепочка `messages` + новые сообщения), отправляет через `telegram_send_dm`, обновляет тред через `dm_threads_update_msgs`, затем вызывает `telegram_mark_as_read`

#### Scenario: Negative sentiment — mark as read and skip
- **WHEN** LLM определяет негативную тональность (агрессия, просьба не писать, оскорбления, "спам", "отпишись")
- **THEN** вызывается `telegram_mark_as_read(chatId=userId)`, ответ не отправляется, тред сохраняется (cooldown продолжает работать)

#### Scenario: Multiple messages from user in one run
- **WHEN** пользователь отправил несколько сообщений между прогонами
- **THEN** все новые сообщения добавляются в `messages`, агент отвечает одним сообщением, учитывающим все новые реплики

#### Scenario: mark_as_read called last
- **WHEN** обработка пользователя завершена (ответ отправлен и тред обновлён)
- **THEN** `telegram_mark_as_read` вызывается последним шагом, гарантируя что сообщение не потеряется при сбое на предыдущих шагах

#### Scenario: privacy_blocked during reply
- **WHEN** `telegram_send_dm` возвращает `{ error: 'privacy_blocked' }` на шаге 7.5
- **THEN** вызывается `telegram_mark_as_read`, обработка переходит к следующему пользователю (тред сохраняется)

#### Scenario: flood_wait during reply
- **WHEN** `telegram_send_dm` возвращает `{ error: 'flood_wait' }` на шаге 7.5
- **THEN** прогон немедленно прерывается

#### Scenario: peer_id_invalid during reply
- **WHEN** `telegram_send_dm` возвращает `{ error: 'peer_id_invalid' }` на шаге 7.5
- **THEN** вызывается `telegram_mark_as_read`, обработка переходит к следующему пользователю; `accessHash` обновится на следующем прогоне через `dm_threads_get_by_users`

## REMOVED Requirements

### Requirement: telegram_get_dm_replies reads incoming DMs
**Reason**: Заменён на push-модель: `telegram_get_dm_dialogs` + `telegram_get_messages`. Poll-модель с `telegram_get_dm_replies` создавала O(N) API-вызовов на каждый прогон.
**Migration**: Использовать `telegram_get_dm_dialogs()` для получения чатов с непрочитанными, затем `telegram_get_messages(chatId=userId, minId=...)` для получения новых сообщений.
