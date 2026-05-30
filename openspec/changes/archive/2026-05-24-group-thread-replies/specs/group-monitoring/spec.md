## MODIFIED Requirements

### Requirement: Agent processes unread messages in two passes
После получения непрочитанных сообщений из группы агент SHALL разделить их на два потока до любой LLM-логики:
1. **Thread-replies** — сообщения с `replyToMsgId`, чей ID найден в `group_thread_agent_msgs` для данного chatId (или в `replies` как первый ответ)
2. **General messages** — все остальные сообщения

Thread-replies обрабатываются первыми с полным контекстом треда. General messages обрабатываются по существующему алгоритму (выбор одного релевантного, ответ).

#### Scenario: Mix of thread-replies and general messages
- **WHEN** в батче непрочитанных сообщений присутствуют как ответы на сообщения агента, так и обычные сообщения
- **THEN** сначала обрабатываются thread-replies (с контекстом треда), затем general messages (существующий флоу — одно сообщение, ответ)

#### Scenario: Only general messages
- **WHEN** ни одно из непрочитанных сообщений не является ответом на сообщение агента
- **THEN** выполняется только существующий флоу обработки general messages без изменений

#### Scenario: Only thread-replies
- **WHEN** все непрочитанные сообщения являются ответами на сообщения агента
- **THEN** обрабатываются только thread-replies; шаги выбора и ответа на general message не выполняются