## ADDED Requirements

### Requirement: Agent detects replies to its own group messages
Когда агент читает непрочитанные сообщения группы, он SHALL проверять для каждого сообщения наличие поля `replyToMsgId`. Если поле присутствует, агент SHALL искать этот ID в таблице `group_thread_agent_msgs` (по chatId + agentMsgId). Если найдено — сообщение классифицируется как thread-reply и обрабатывается отдельно от общих сообщений.

#### Scenario: Incoming message is a reply to agent
- **WHEN** входящее сообщение имеет `replyToMsgId` равный ID одного из сообщений агента в этом чате
- **THEN** сообщение добавляется в список thread-replies для текущего чата и исключается из потока general messages

#### Scenario: Incoming message is not a reply to agent
- **WHEN** входящее сообщение не имеет `replyToMsgId`, или `replyToMsgId` не найден в `group_thread_agent_msgs` для данного chatId
- **THEN** сообщение обрабатывается как general message по существующему алгоритму

#### Scenario: replyToMsgId found in replies but no thread yet
- **WHEN** `replyToMsgId` найден в таблице `replies` (агент ранее отвечал), но запись в `group_thread_agent_msgs` отсутствует
- **THEN** это первый ответ пользователя — создаётся новый тред (см. требование "Thread is created lazily")

---

### Requirement: Thread is created lazily on first user reply
Тред SHALL создаваться только при первом ответе пользователя на сообщение агента. До этого момента детекция осуществляется через таблицу `replies`.

#### Scenario: First reply triggers thread creation
- **WHEN** входящее сообщение имеет `replyToMsgId = T2`, и в `replies` найдена запись (T1→T2), но в `group_thread_agent_msgs` запись для T2 отсутствует
- **THEN** создаётся запись в `group_threads` с `messages = [T1, T2, T3(новое)]`, `startMsgId = T1`, `status = 'active'`, `lastActivityAt = now`; в `group_thread_agent_msgs` регистрируются agentMsgId=T2

#### Scenario: Thread not created if no matching reply record
- **WHEN** `replyToMsgId` не найден ни в `replies`, ни в `group_thread_agent_msgs`
- **THEN** тред не создаётся; сообщение обрабатывается как general message

---

### Requirement: Agent responds to thread replies with full chain context
Для каждого активного треда с новыми сообщениями агент SHALL генерировать один ответ, используя полную цепочку сообщений из `group_threads.messages` в качестве контекста.

#### Scenario: Single new message in thread
- **WHEN** в активном треде появилось одно новое сообщение от пользователя
- **THEN** агент получает JSON-цепочку треда, добавляет новое сообщение, генерирует ответ учитывая весь контекст, отправляет reply через `telegram_reply_to_message`

#### Scenario: Multiple new messages from different users in one run
- **WHEN** в активном треде за один прогон появилось несколько новых сообщений (от одного или разных пользователей)
- **THEN** все новые сообщения добавляются в цепочку; агент генерирует один ответ, учитывая все новые сообщения

#### Scenario: Thread is expired
- **WHEN** тред имеет `status = 'expired'` (lastActivityAt < now - 4 дней)
- **THEN** агент не отвечает на новые сообщения в этом треде; сообщения пропускаются

---

### Requirement: Agent message IDs are registered after each reply in thread
После каждой успешной отправки ответа в треде агент SHALL регистрировать ID отправленного сообщения в `group_thread_agent_msgs` и обновлять `group_threads` (добавлять в messages JSON, обновлять lastActivityAt).

#### Scenario: Successful reply sent in thread
- **WHEN** агент успешно отправил ответ в тред (получен messageId от Telegram)
- **THEN** выполняется INSERT в `group_thread_agent_msgs` (agentMsgId = новый messageId, threadId = текущий), UPDATE `group_threads` (messages += agent reply, lastActivityAt = now)

#### Scenario: Send fails
- **WHEN** отправка ответа завершилась ошибкой (FLOOD_WAIT или другая)
- **THEN** `group_thread_agent_msgs` и `group_threads` не обновляются; тред остаётся в прежнем состоянии

---

### Requirement: Threads expire after 4 days of inactivity
Агент SHALL помечать треды как `expired` если `lastActivityAt < now - 4 * 86400 секунд`.

#### Scenario: Expiration check runs each cycle
- **WHEN** начинается обработка thread-replies для любого чата
- **THEN** перед обработкой вызывается `tg_group_thread_expire`, который переводит устаревшие треды в status='expired'

#### Scenario: Expired thread not processed
- **WHEN** найден тред с status='expired'
- **THEN** новые сообщения в этом треде пропускаются, ответ не генерируется

---

### Requirement: telegram_get_messages returns replyToMsgId
Инструмент `telegram_get_messages` SHALL включать в каждый объект сообщения необязательное поле `replyToMsgId: number | undefined` — ID сообщения, на которое данное сообщение является ответом.

#### Scenario: Message is a reply
- **WHEN** сообщение в Telegram имеет заполненный `replyTo.replyToMsgId`
- **THEN** в результате `telegram_get_messages` для этого сообщения присутствует поле `replyToMsgId` с соответствующим числовым значением

#### Scenario: Message is not a reply
- **WHEN** сообщение в Telegram не является ответом (`replyTo` отсутствует)
- **THEN** поле `replyToMsgId` отсутствует в объекте сообщения