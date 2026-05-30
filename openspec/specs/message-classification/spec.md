## ADDED Requirements

### Requirement: tg_classify_messages classifies raw messages into three categories

Инструмент `tg_classify_messages` SHALL принимать массив сырых сообщений из `telegram_get_messages` и возвращать объект с тремя категориями: `generalMessages`, `newThreadMessages`, `threadReplies`. Все необходимые DB-запросы выполняются внутри инструмента — LLM не делает никаких дополнительных запросов для классификации.

#### Входные данные инструмента

Параметры вызова:

| Параметр | Тип | Описание |
|---|---|---|
| agentId | string | ID агента из раздела Runtime системного промпта |
| chatId | string | ID Telegram-чата, из которого получены сообщения |
| messages | Message[] | Массив сообщений из `telegram_get_messages` |

Структура `Message`:

| Поле | Тип | Описание |
|---|---|---|
| id | number | ID сообщения в чате |
| fromId | string | Telegram user ID отправителя |
| fromName | string | Имя отправителя |
| text | string | Текст сообщения |
| date | number | Unix timestamp сообщения |
| userAccessHash | string? | Access hash пользователя (отсутствует для min-сущностей) |
| replyToMsgId | number? | ID сообщения, на которое это является ответом |

#### Выходные данные инструмента

Возвращаемый объект:

| Поле | Тип | Описание |
|---|---|---|
| generalMessages | Message[] | Сообщения, не связанные с тредами агента |
| newThreadMessages | NewThreadEntry[] | Первые ответы пользователей на сообщения агента (T2) |
| threadReplies | ThreadReplyEntry[] | Продолжения существующих тредов |

Структура `NewThreadEntry`:

| Поле | Тип | Описание |
|---|---|---|
| agentReplyRecord | AgentReplyRecord | Запись об ответе агента (T1→T2), на который отвечают |
| messages | Message[] | Сообщения пользователей, отвечающих на T2 (могут быть от разных людей) |

Структура `AgentReplyRecord` (данные из таблицы `tg_replies`):

| Поле | Тип | Описание |
|---|---|---|
| msgId | number | ID оригинального сообщения пользователя (T1) |
| msgText | string | Текст T1 |
| replyMsgId | number | ID ответа агента (T2) |
| replyText | string | Текст T2 |

Структура `ThreadReplyEntry`:

| Поле | Тип | Описание |
|---|---|---|
| threadId | number | ID треда в таблице `tg_group_threads` |
| threadStatus | string | Статус треда: `'active'` или `'expired'` |
| threadMessages | ThreadMessage[] | Полная история переписки треда из поля `messages` |
| newMessages | Message[] | Новые сообщения, пришедшие в этом прогоне |

Структура `ThreadMessage` (элемент из JSON-поля `messages` таблицы `tg_group_threads`):

| Поле | Тип | Описание |
|---|---|---|
| role | `'user'` или `'agent'` | Роль отправителя |
| msgId | number | ID сообщения |
| fromName | string? | Имя отправителя (только для `role='user'`) |
| fromId | string? | Telegram user ID (только для `role='user'`) |
| text | string | Текст сообщения |

#### Scenario: Message without replyToMsgId goes to generalMessages

- **WHEN** входящее сообщение не имеет поля `replyToMsgId`
- **THEN** сообщение попадает в `generalMessages`, DB-запросы не выполняются для этого сообщения

#### Scenario: replyToMsgId matches agentMsgId in tg_group_threads

- **WHEN** входящее сообщение имеет `replyToMsgId` И в таблице `tg_group_threads` существует запись с `agentMsgId = replyToMsgId` и `chatId = chatId`
- **THEN** сообщение попадает в `threadReplies`, сгруппированное по `threadId`; возвращается `threadStatus`, полная история `threadMessages` и список `newMessages` этого прогона

#### Scenario: replyToMsgId matches replyMsgId in tg_replies (new thread)

- **WHEN** входящее сообщение имеет `replyToMsgId` И в `tg_group_threads` записи не найдено И в таблице `tg_replies` существует запись с `replyMsgId = replyToMsgId` и `chatId = chatId`
- **THEN** сообщение попадает в `newThreadMessages` вместе с `AgentReplyRecord` из `tg_replies`

#### Scenario: replyToMsgId not found in any DB table

- **WHEN** входящее сообщение имеет `replyToMsgId` И ни в `tg_group_threads`, ни в `tg_replies` нет записи для этого ID
- **THEN** сообщение попадает в `generalMessages` (это ответ на чужое сообщение, не связанный с агентом)

#### Scenario: Multiple messages reply to the same agent reply (newThreadMessages grouping)

- **WHEN** несколько входящих сообщений имеют одинаковый `replyToMsgId`, и этот ID найден в `tg_replies`
- **THEN** все эти сообщения объединяются в один `NewThreadEntry` с одним `agentReplyRecord` и массивом `messages` из всех ответивших

#### Scenario: Multiple messages continue the same thread (threadReplies grouping)

- **WHEN** несколько входящих сообщений имеют `replyToMsgId`, ведущие к одному и тому же `threadId` в `tg_group_threads`
- **THEN** все эти сообщения объединяются в один `ThreadReplyEntry` с одним `threadId` и массивом `newMessages`

#### Scenario: Thread with status expired is returned in threadReplies

- **WHEN** входящее сообщение имеет `replyToMsgId`, найденный в `tg_group_threads` с `status = 'expired'`
- **THEN** сообщение попадает в `threadReplies` с `threadStatus = 'expired'`; скилл самостоятельно решает, как обрабатывать expired-треды

### Requirement: tg_group_thread_find and tg_replies_find_by_reply_msg_id are removed from plugin API

Инструменты `tg_group_thread_find` и `tg_replies_find_by_reply_msg_id` SHALL быть удалены из регистрации через `api.registerTool`. Их внутренние функции-реализации в `src/replies-db.ts` остаются и используются внутри `tg_classify_messages`.

#### Scenario: Removed tools are not available to LLM

- **WHEN** агент запущен после применения изменения
- **THEN** инструменты `tg_group_thread_find` и `tg_replies_find_by_reply_msg_id` отсутствуют в списке доступных function calls
