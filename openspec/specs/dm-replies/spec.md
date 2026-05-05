## ADDED Requirements

### Requirement: telegram_get_dm_replies reads incoming DMs
Инструмент `telegram_get_dm_replies(entries)` SHALL принимать массив `{ userId, userAccessHash, lastAgentMsgAt }`, для каждого конструировать `InputPeerUser` из `userId` и `userAccessHash`, читать последние 20 сообщений и возвращать только сообщения от пользователя с `date > lastAgentMsgAt`.

#### Scenario: Returns only new user messages
- **WHEN** у пользователя есть сообщения до и после `lastAgentMsgAt`
- **THEN** возвращаются только сообщения с `date > lastAgentMsgAt` от пользователя (не от агента)

#### Scenario: No new messages
- **WHEN** пользователь не отвечал после `lastAgentMsgAt`
- **THEN** для этого пользователя возвращается пустой массив

### Requirement: dm-replies skill handles incoming DMs
Скилл `dm-replies` (SKILL_DM_REPLIES.md) SHALL запускаться каждые 30 минут. Работает только с 08:00 до 01:00 UTC+5. Алгоритм:
1. Проверить время; вне диапазона — завершить
2. `dm_history_get_active` → активные диалоги
3. `telegram_get_dm_replies(entries)` → новые сообщения
4. Для каждого пользователя с новыми сообщениями: проверить негатив (LLM), ответить, обновить статус
5. Активные записи без новых сообщений старше 48ч → `done`

#### Scenario: Out of hours — no action
- **WHEN** текущее время UTC+5 вне диапазона 08:00–01:00
- **THEN** скилл завершает работу без каких-либо действий

#### Scenario: First reply from user
- **WHEN** статус диалога `sent` (replyCount=0) и пользователь прислал сообщение
- **THEN** агент отвечает, `status` → `in_dialogue`, `replyCount` → 1, `lastAgentMsgAt` обновляется

#### Scenario: Second reply from user — dialogue closes
- **WHEN** статус диалога `in_dialogue` (replyCount=1) и пользователь прислал сообщение
- **THEN** агент отвечает финальной фразой, `status` → `done`, `replyCount` → 2

#### Scenario: Negative sentiment detected
- **WHEN** LLM определяет негатив в сообщении пользователя
- **THEN** агент не отвечает, `status` → `done`

#### Scenario: 48h timeout
- **WHEN** `now - lastAgentMsgAt > 172800` (48ч) и нет новых сообщений от пользователя
- **THEN** `status` → `done` без отправки сообщения

#### Scenario: Notification after reply
- **WHEN** агент отправил ответ в диалоге
- **THEN** в Saved Messages отправляется уведомление с текстом пользователя, ответом агента и текущим статусом
