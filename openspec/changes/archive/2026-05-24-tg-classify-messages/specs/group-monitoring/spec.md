## MODIFIED Requirements

### Requirement: Agent scores and queues DM candidates

После обработки каждой группы агент SHALL оценивать интересные сообщения на потенциал для DM по шкале 0.0–1.0 и записывать кандидатов в `dm_candidates`, если `score >= 0.6`. Запись происходит в конце шага обработки группы, после отправки ответов в группу.

Критерии оценки:
- 0.9–1.0: сильный личный вопрос, явная экспертиза, живой интерес к теме канала
- 0.6–0.8: есть зацепка, но повод для DM не очевиден
- ниже 0.6: пропустить, не записывать

Поля для записи: `userId`, `userAccessHash` (из поля сообщения, только если не min-entity), `sourceChatId`, `msgId`, `msgText`, `score`, `scoreReason`.

Агент SHALL НЕ отправлять DM непосредственно из этого скилла.

#### Scenario: High-score message queued

- **WHEN** агент нашёл сообщение с оценкой ≥ 0.6 и у пользователя есть `userAccessHash`
- **THEN** вызывается `dm_candidates_insert` с полными данными; DM не отправляется

#### Scenario: Low-score message skipped

- **WHEN** агент оценил сообщение ниже 0.6
- **THEN** `dm_candidates_insert` не вызывается для этого сообщения

#### Scenario: min-entity user — queued without accessHash

- **WHEN** `userAccessHash` отсутствует (min-entity)
- **THEN** запись всё равно создаётся, но `userAccessHash` = null; Cron 2 не сможет отправить DM такому кандидату

#### Scenario: Duplicate message not duplicated

- **WHEN** одно и то же сообщение встречается на двух прогонах (одинаковые `sourceChatId`, `msgId`)
- **THEN** второй вызов `dm_candidates_insert` молча игнорируется (ON CONFLICT IGNORE)

## ADDED Requirements

### Requirement: Agent uses tg_classify_messages to split messages into categories

После вызова `telegram_mark_as_read` агент SHALL вызывать `tg_classify_messages` для разбивки входящих сообщений на категории. Агент SHALL НЕ вызывать `tg_group_thread_find` или `tg_replies_find_by_reply_msg_id` напрямую — эти инструменты больше не доступны.

Порядок обработки для каждого канала:
1. `telegram_get_messages` → сырые сообщения
2. `telegram_mark_as_read`
3. `tg_classify_messages` → `{ generalMessages, newThreadMessages, threadReplies }`
4. Обработать `newThreadMessages` (создать треды, ответить)
5. Обработать `threadReplies` (ответить, включая expired)
6. Обработать `generalMessages` (анализ тем, ответы, DM-кандидаты)

#### Scenario: tg_classify_messages called after mark_as_read

- **WHEN** агент получил непустой список сообщений из `telegram_get_messages`
- **THEN** агент вызывает `telegram_mark_as_read`, затем вызывает `tg_classify_messages` с теми же сообщениями; результат классификации используется для дальнейшей обработки

#### Scenario: expired thread reply is handled by skill

- **WHEN** `tg_classify_messages` возвращает `ThreadReplyEntry` с `threadStatus = 'expired'`
- **THEN** агент отвечает на сообщения в этом записанном треде (обрабатывает как продолжение диалога), не перекладывает их в `generalMessages`

#### Scenario: Empty category is skipped

- **WHEN** одна из категорий (`generalMessages`, `newThreadMessages`, или `threadReplies`) пуста
- **THEN** агент пропускает шаг обработки этой категории без ошибок

## REMOVED Requirements

### Requirement: Agent manually checks replyToMsgId per message using separate DB tools

**Reason**: Заменено инструментом `tg_classify_messages`, который выполняет все DB-запросы внутри. LLM больше не должна итерировать по сообщениям и вызывать `tg_group_thread_find` / `tg_replies_find_by_reply_msg_id` вручную.

**Migration**: Заменить шаги 5.2.6–5.2.9 скилла на вызов `tg_classify_messages(agentId, chatId, messages)` и обработку трёх возвращённых категорий.