---
name: dm-send
description: "Daily DM outreach: send direct messages to top-scored candidates from dm_candidates. Use when the agent needs to run the daily DM sending routine. Triggers: 'send DMs', 'dm outreach', 'run dm-send', 'daily dm'."
---

# DM Send — Ежедневная отправка личных сообщений

## Цель

Ежедневно отправлять DM топ-кандидатам из очереди `dm_candidates`. Отправляет не более 15 DM в день. Записывает каждую отправку в `dm_history`.


## Ограничения

- Не более 15 DM в сутки (UTC).
- Cooldown на пользователя: 7 дней.
- Не более 2–3 кандидатов из одного `sourceChatId` за один прогон.
- Пауза 30–60 секунд между отправками.

---

## Основной алгоритм

Выполнять **строго по шагам**:

### Шаг 0 — Проверить дневной лимит

```
dm_history_count_today(agentId: <agentId>)
```

Если `count >= 15` — перейти сразу к **Шагу 6** (уведомление), затем завершить.

---

### Шаг 1 — Загрузить аккаунт

```
tg_load_account(agentId: <agentId>)
```

Если ошибка — завершить выполнение.

---

### Шаг 2 — Истечь старые кандидаты

```
dm_candidates_expire_old(agentId: <agentId>, olderThanDays: 3)
```

---

### Шаг 3 — Получить очередь кандидатов

```
dm_candidates_get_pending(agentId: <agentId>, limit: 100)
```

Результат: список кандидатов со статусом `pending`, отсортированных по `score DESC`.

---

### Шаг 4 — Отфильтровать по cooldown

Для каждого кандидата:

```
dm_history_check_cooldown(agentId: <agentId>, userId: <candidate.userId>)
```

- Если `canSend: false` → пометить кандидата как `skipped` (`dm_candidates_update_status`) и добавить в счётчик «пропущено».
- Если `canSend: true` → кандидат проходит дальше.

---

### Шаг 5 — Выбрать топ и отправить DM (LLM)

Перед началом цикла отправки завести счётчик `floodErrors = 0`.

Из кандидатов, прошедших cooldown, выбрать **топ 10–15** по правилам:

```
Из списка кандидатов выбери 10–15 лучших для отправки DM сегодня.

Правила:
- Приоритет: наивысший score
- Не более 2–3 кандидатов из одного sourceChatId
- Учитывай оставшийся дневной лимит: уже отправлено сегодня <N>, лимит 15

Кандидаты:
<список: id, userId, sourceChatId, msgText, score, scoreReason>

Верни JSON-массив id выбранных кандидатов: [<id>, ...]
```

Для каждого выбранного кандидата выполнить:

#### 5a — Сформулировать DM (LLM)

```
Напиши короткое личное сообщение (DM) пользователю в Telegram.

Контекст: пользователь написал в групповом чате следующее сообщение:
"<candidate.msgText>"

Требования:
- стиль для формирования сообщения возьми из своей личности
- Персональное, не шаблонное
- Упоминает конкретику из сообщения
- Не рекламное
- До 3 предложений
- На том же языке, что и сообщение пользователя
```

#### 5b — Отправить DM (с атомарной записью в историю)

```
telegram_send_dm(
  userId:     <candidate.userId>,
  accessHash: <candidate.userAccessHash>,
  text:       <DM из 5a>,
  agentId:    <agentId>,
  historyRecord: {
    userAccessHash: <candidate.userAccessHash>,
    username:       null,
    triggerText:    <candidate.msgText>,
    dmText:         <DM из 5a>,
    sentAt:         <текущий unix timestamp>,
    lastAgentMsgAt: <текущий unix timestamp>,
    replyCount:     0,
    status:         'sent'
  }
)
```

Инструмент записывает `dm_history` **внутри себя**, строго после получения подтверждения от Telegram. Отдельный вызов `dm_history_insert` больше **не нужен и не должен выполняться**.

Обработка результатов — действует немедленно, до любых других шагов:

- `{ ok: true, messageId }` → перейти к шагу 5c (обновить статус кандидата)
- `{ error: 'peer_flood' }` → **немедленно прервать цикл** (не выполнять 5c), перейти к Шагу 6. PEER_FLOOD означает временный бан аккаунта на отправку DM. Оставить статус кандидата `pending`.
- `{ error: 'flood_wait' }` → увеличить `floodErrors` на 1; если `floodErrors >= 5` — прервать цикл, перейти к Шагу 6; иначе — пропустить этого кандидата (не выполнять 5c), перейти к следующему
- `{ error: 'privacy_blocked' }` → вызвать `dm_candidates_update_status(status: 'privacy_blocked')`, не выполнять 5c, перейти к следующему кандидату
- `{ error: 'deactivated' }` → вызвать `dm_candidates_update_status(status: 'deactivated')`, не выполнять 5c, перейти к следующему кандидату
- Любой другой `{ error: '...' }` (включая `peer_id_invalid`) → вызвать `dm_candidates_update_status(status: 'skipped')`, не выполнять 5c, перейти к следующему кандидату. Не считать за успешную отправку.

#### 5c — Обновить статус кандидата (только после `{ ok: true }`)

```
dm_candidates_update_status(agentId: <agentId>, id: <candidate.id>, status: 'sent')
```

#### 5d — Пауза

Подождать **30–60 секунд** (случайно) перед следующей отправкой.


---

## Инструменты

| Инструмент | Шаг | Файл |
|------------|-----|------|
| `dm_history_count_today` | 0 | channels-db.ts |
| `tg_load_account` | 1 | index.ts |
| `dm_candidates_expire_old` | 2 | channels-db.ts |
| `dm_candidates_get_pending` | 3 | channels-db.ts |
| `dm_history_check_cooldown` | 4 | channels-db.ts |
| `dm_candidates_update_status` | 4, 5c | channels-db.ts |
| `telegram_send_dm` | 5b | index.ts — записывает dm_history атомарно при успехе |
