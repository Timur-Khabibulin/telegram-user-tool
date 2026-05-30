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

## ADDED Requirements

### Requirement: SKILL document uses flat step numbering with one parent for generalMessages handling

Файл `skills/telegram-group-monitor/SKILL.md` SHALL использовать плоскую сквозную нумерацию шагов уровня `5.x`: классификация (`tg_classify_messages`), обработка `newThreadMessages`, обработка `threadReplies` — каждая как самостоятельный шаг без точечного префикса вида `5.2.6`. Шаги, относящиеся к обработке `generalMessages` (определение тем, отбор релевантных, генерация ответов, отправка), SHALL быть сгруппированы под одним родительским шагом `5.6 Обработать generalMessages` с подшагами `5.6.1–5.6.4`.

Целевая структура:

```
5.1   Получить непрочитанные сообщения        (telegram_get_messages)
5.2   Пометить как прочитанные                (telegram_mark_as_read)
5.3   Классифицировать сообщения              (tg_classify_messages)
5.4   Обработать newThreadMessages
5.5   Обработать threadReplies
5.6   Обработать generalMessages
      5.6.1 Определить темы обсуждения        (LLM)
      5.6.2 Отобрать релевантные сообщения    (LLM)
      5.6.3 Сгенерировать ответы              (LLM)
      5.6.4 Отправить ответы                  (telegram_reply_to_message)
5.7   Сохранить прогресс                      (tg_channels_mark_processed)
5.8   Оценить сообщения для DM-кандидатов     (dm_candidates_insert)
```

Поведенческие требования (какие инструменты вызываются, в каком порядке, с какими параметрами) NOT changed — структурное изменение касается только нумерации и группировки в SKILL-документе.

#### Scenario: Steps for classification and thread handling are flat
- **WHEN** агент читает `SKILL.md`
- **THEN** шаги классификации и обработки тредов имеют номера `5.3`, `5.4`, `5.5` соответственно, без точечной вложенности типа `5.2.x`

#### Scenario: GeneralMessages handling has one parent step with substeps
- **WHEN** агент достигает обработки `generalMessages`
- **THEN** в `SKILL.md` это один родительский шаг `5.6` с подшагами `5.6.1` (определить темы), `5.6.2` (отобрать), `5.6.3` (сгенерировать), `5.6.4` (отправить)

#### Scenario: Intro range matches actual step set
- **WHEN** агент читает вводную строку перед перечислением шагов 5.x
- **THEN** диапазон шагов в intro соответствует реальному перечню (включая 5.8)

#### Scenario: Forward references point to current numbering
- **WHEN** в тексте шага встречается ссылка на номер другого шага (например, «из результата шага N»)
- **THEN** N соответствует текущей нумерации (`5.3` для классификации, `5.6.2/5.6.3` для отбора/генерации внутри родителя 5.6, и т. д.) — никаких упоминаний устаревших `5.2.6/5.2.7/5.2.8`

#### Scenario: Tools table uses new step numbers
- **WHEN** агент смотрит таблицу «Инструменты» в конце `SKILL.md`
- **THEN** колонка «Шаг» для `tg_classify_messages` содержит `5.3`, для `tg_group_thread_create` — `5.4`, для `tg_group_thread_update` — `5.4, 5.5`, для `telegram_reply_to_message` — `5.4, 5.5, 5.6.4`

#### Scenario: Behavior is unchanged
- **WHEN** агент проходит ренумерованный SKILL шаг за шагом
- **THEN** последовательность вызовов инструментов, параметры и LLM-промпты остаются такими же, как до изменения — меняется только то, как пронумерованы шаги в документе
