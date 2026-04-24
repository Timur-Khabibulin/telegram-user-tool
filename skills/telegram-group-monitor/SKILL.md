---
name: telegram-group-monitor
description: "Telegram group monitoring algorithm. Initializes and syncs the channels database, then reads unread messages from due chats, analyzes topics against the agent's persona, and replies to relevant messages. Use this skill when the agent needs to monitor telegram groups, read unread messages, analyze chat topics, or reply to group messages on behalf of the agent's persona. Triggers: 'monitor telegram groups', 'read telegram groups', 'reply to telegram messages', 'check telegram chats', 'telegram group agent'."
---

# Telegram Group Monitor

## Алгоритм выполнения

Выполнять **строго по шагам**:

### Шаг 1 — Загрузить конфигурацию аккаунта

```
tg_load_account(
  agentId: <agentId из раздела Runtime системного промпта>
)
```

Читает учётные данные из `~/.openclaw/workspace-<agentId>/tg-account.json`.
Если инструмент вернул ошибку — **завершить выполнение**.

---

### Шаг 2 — Инициализация таблицы

Вызвать `tg_channels_init(agentId: <agentId>)`.

---

### Шаг 3 — Синхронизация каналов

Вызвать `tg_channels_sync(agentId: <agentId>)`.

---

### Шаг 4 — Получить батч

```
tg_channels_get_batch(
  agentId:       <agentId>,
  periodSeconds: 259200
)
```

Результат: список `{ chatId, title, lastProcessedAt }`.

Если список пустой — **завершить выполнение**.

---

### Шаг 5 — Обработать каждый канал из батча

Для **каждого** канала выполнить шаги 5.1–5.7 последовательно.

#### 5.1 Получить непрочитанные сообщения

```
telegram_get_messages(
  chatId: <chatId>,
  minId:  <readInboxMaxId>,
  limit:  100
)
```

При `FLOOD_WAIT_X` — подождать X секунд, повторить один раз. Если ошибка повторилась — **завершить весь прогон**.

При других ошибках — пропустить канал, перейти к шагу 5.7.

Если сообщений нет — перейти к шагу 5.7.

Подождать **1 секунду** перед вызовом для следующего канала.

#### 5.2 Пометить как прочитанные

Вызвать **немедленно** после получения сообщений, независимо от дальнейших шагов:

```
telegram_mark_as_read(
  chatId: <chatId>,
  maxId:  max(message.id)
)
```

#### 5.3 Определить темы обсуждения (LLM)

```
Перечисли основные темы обсуждения в этих сообщениях.
Ответь кратко — список тем без пояснений.

Сообщения:
<список сообщений: fromName + text>
```

Если темы не соотносятся с личностью агента — перейти к шагу 5.7.

#### 5.4 Отобрать релевантные сообщения (LLM)

```
Из списка ниже выбери 2–3 сообщения, на которые тебе есть что ответить
исходя из своей личности и экспертизы.

Верни ТОЛЬКО JSON-массив:
[{ "id": <message_id>, "text": "<текст сообщения>" }]

Если подходящих сообщений нет — верни пустой массив [].

Сообщения:
<список сообщений: id + fromName + text>
```

Если массив пустой — перейти к шагу 5.7.

#### 5.5 Сгенерировать ответы (LLM)

Для каждого отобранного сообщения:

```
Напиши ответ на следующее сообщение в групповом чате Telegram.

Сообщение: "<text>"
```

#### 5.6 Отправить ответы

```
telegram_reply_to_message(
  chatId:           <chatId>,
  replyToMessageId: <id из шага 5.4>,
  text:             <ответ из шага 5.5>,
  originalText:     <text оригинального сообщения из шага 5.4>
)
```

При `FLOOD_WAIT_X` — подождать X секунд, повторить один раз. Если ошибка повторилась — **завершить весь прогон**.

Между отправками — подождать **5 секунд**.

#### 5.7 Сохранить прогресс

```
tg_channels_mark_processed(
  agentId: <agentId>,
  chatId:  <chatId>
)
```

Вызвать сразу после завершения канала — не в конце батча.

---

## Правила

- Не отправлять ответы, если LLM вернула пустой массив.
- Вызывать `tg_channels_mark_processed` сразу после каждого канала — не в конце батча.

---

## Инструменты

| Инструмент | Шаг | Файл |
|------------|-----|------|
| `tg_load_account` | 1 | index.ts |
| `tg_channels_init` | 2 | channels-db.ts |
| `tg_channels_sync` | 3 | channels-db.ts |
| `tg_channels_get_batch` | 4 | channels-db.ts |
| `telegram_get_messages` | 5.1 | index.ts |
| `telegram_mark_as_read` | 5.2 | index.ts |
| `telegram_reply_to_message` | 5.6 | index.ts |
| `tg_channels_mark_processed` | 5.7 | channels-db.ts |