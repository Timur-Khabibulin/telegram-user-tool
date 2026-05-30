## Context

Агент `telegram-group-monitor` получает из `telegram_get_messages` плоский массив сообщений одного чата. Среди них могут быть:

1. Обычные сообщения (не являются ответом ни на что)
2. Ответы пользователей на предыдущий ответ агента (первый ответ — нужно создать тред)
3. Продолжение уже существующего треда (повторный ответ в уже созданном треде)

Чтобы различить категории 2 и 3, агенту нужно выполнять до 2 DB-запросов на каждое сообщение с `replyToMsgId`. Проблема: LLM не делает эти запросы надёжно — итерирует по массиву непоследовательно, пропускает сообщения или игнорирует поле.

Текущие инструменты `tg_group_thread_find` и `tg_replies_find_by_reply_msg_id` зарегистрированы как отдельные публичные инструменты, что требует от LLM самостоятельного принятия решений о вызове и интерпретации результатов.

### Существующие DB-таблицы

#### tg_group_threads (в `tg-replies.db`)

| Поле | Тип | Описание |
|---|---|---|
| id | INTEGER PK | Внутренний ID треда |
| agentId | TEXT | ID агента-владельца |
| chatId | TEXT | ID Telegram-чата |
| startMsgId | INTEGER | ID первого сообщения пользователя (T1) |
| startMsgText | TEXT | Текст T1 |
| agentMsgId | INTEGER | ID ответа агента (T2) — ключ поиска при классификации |
| agentMsgText | TEXT | Текст T2 |
| messages | TEXT | JSON-массив `ThreadMessage[]` — полная история переписки |
| status | TEXT | `'active'` или `'expired'` |
| lastActivityAt | INTEGER | Unix timestamp последней активности |
| createdAt | INTEGER | Unix timestamp создания |

#### tg_replies (в `tg-replies.db`)

| Поле | Тип | Описание |
|---|---|---|
| id | INTEGER PK | Внутренний ID записи |
| agentId | TEXT | ID агента-владельца |
| chatId | TEXT | ID Telegram-чата |
| msgId | INTEGER | ID оригинального сообщения пользователя (T1) |
| msgText | TEXT | Текст T1 |
| replyMsgId | INTEGER | ID ответа агента (T2) — ключ поиска при классификации |
| replyText | TEXT | Текст T2 |
| createdAt | INTEGER | Unix timestamp |

### Существующий вспомогательный код

В `src/replies-db.ts` уже реализованы функции:
- `findThreadByAgentMsgId(agentId, chatId, agentMsgId)` — поиск в `tg_group_threads`
- `findReplyByReplyMsgId(agentId, chatId, replyMsgId)` — поиск в `tg_replies`

Они остаются без изменений и используются внутри нового инструмента.

## Goals / Non-Goals

**Goals:**
- Перенести логику классификации сообщений из LLM-слоя в детерминированный TypeScript-код
- Предоставить LLM один инструмент `tg_classify_messages` с готовым результатом вместо двух отдельных DB-инструментов
- Убрать из plugin API инструменты, которые LLM не должна вызывать самостоятельно (`tg_group_thread_find`, `tg_replies_find_by_reply_msg_id`)
- Обновить скилл `telegram-group-monitor` для использования нового инструмента

**Non-Goals:**
- Изменение схемы DB-таблиц `tg_group_threads`, `tg_replies`
- Изменение инструментов `tg_group_thread_create`, `tg_group_thread_update`, `tg_group_thread_expire`
- Изменение алгоритма обработки каждой категории после классификации (шаги 5.2.7–5.8)
- Добавление персистентности классификации (результат не кэшируется в DB)

## Decisions

### Решение 1: Классификация целиком в одном инструменте

Инструмент `tg_classify_messages` принимает весь массив сообщений и возвращает уже сгруппированный результат трёх категорий. Альтернатива — классификация одного сообщения за вызов. 

Выбрано батчевое решение: один вызов → меньше context window LLM расходуется на tool calls, меньше вероятность частичной обработки при прерывании.

### Решение 2: Группировка threadReplies по threadId, newThreadMessages по replyToMsgId

Несколько пользователей могут ответить на один и тот же T2 агента (один `replyToMsgId`) — они попадают в один `NewThreadEntry.messages[]`. Несколько сообщений могут продолжить один тред — они попадают в один `ThreadReplyEntry.newMessages[]`. Это уменьшает количество LLM-итераций при обработке.

### Решение 3: expired-треды попадают в threadReplies, не в generalMessages

Логика из текущего скилла (`status == 'expired'` → general messages) переносится в уровень скилла, а не в инструмент. Инструмент возвращает `threadStatus` в `ThreadReplyEntry` — скилл сам решает, как обрабатывать expired-треды. Это сохраняет гибкость: будущие версии скилла могут обрабатывать expired иначе.

### Решение 4: Удаление инструментов из plugin API, а не deprecation

`tg_group_thread_find` и `tg_replies_find_by_reply_msg_id` удаляются из `registerTool`, но их реализующие функции в `replies-db.ts` остаются. Это breaking change, но он намеренный: присутствие инструментов в API провоцировало LLM их использовать.

## Risks / Trade-offs

**[Риск: потеря гибкости]** → Инструмент `tg_classify_messages` делает все DB-запросы внутри. Если логика классификации изменится, нужно менять TypeScript-код, а не скилл. Это приемлемо — классификация должна быть детерминированной, не LLM-управляемой.

**[Риск: breaking change скилла]** → Любой скилл или агент, вызывавший `tg_group_thread_find` или `tg_replies_find_by_reply_msg_id` напрямую, перестанет находить эти инструменты. Митигация: скилл `telegram-group-monitor` обновляется в рамках этого же изменения.

**[Риск: размер payload]** → `tg_classify_messages` возвращает полные `threadMessages[]` (всю историю треда) для каждого `ThreadReplyEntry`. Для длинных тредов это может быть большой объём данных. Принято как приемлемое — LLM в любом случае нужна эта история для генерации ответа.

## Migration Plan

1. Добавить `tg_classify_messages` в `src/channels-db.ts`
2. Удалить `registerTool` для `tg_group_thread_find` и `tg_replies_find_by_reply_msg_id` из `src/channels-db.ts`
3. Обновить `skills/telegram-group-monitor/SKILL.md` — заменить шаги 5.2.6–5.2.9 на вызов `tg_classify_messages`

Откат: восстановить регистрацию удалённых инструментов и откатить скилл.

## Open Questions

- Нужно ли оставить `tg_group_thread_find` как deprecated (с пометкой в description) на случай, если другие скиллы его используют? Текущее решение — полное удаление, т.к. явных других потребителей нет.