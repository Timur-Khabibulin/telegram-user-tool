---
name: dm-send
description: "Daily DM outreach: send direct messages to top-scored candidates from dm_candidates. Uses dm_threads for cooldown tracking and thread creation. Use when the agent needs to run the daily DM sending routine. Triggers: 'send DMs', 'dm outreach', 'run dm-send', 'daily dm'."
---

# DM Send — Ежедневная отправка личных сообщений

## Цель

Ежедневно отправлять DM топ-кандидатам из очереди `dm_candidates`. Отправляет не более 15 DM в день. Создаёт тред в `dm_threads` для каждой успешной отправки.


## Ограничения

- Не более 15 DM в сутки (UTC). Считаются только **новые треды** (по `createdAt` сегодня).
- Не более 2 DM за один прогон (`sentThisRun`).
- Cooldown на пользователя: **14 дней** по `lastActivityAt`.
- Пауза 30–60 секунд между отправками (только при успехе).

---

## Основной алгоритм

Выполнять **строго по шагам**:
а
### Шаг 0 — Проверить дневной лимит

```
dm_threads_count_today(agentId: <agentId>)
```

Если `count >= 15` — перейти сразу к **Шагу 6** (уведомление), затем завершить.

---

### Шаг 1 — Загрузить аккаунт

```
tg_load_account(agentId: <agentId>)
```

Если ошибка — завершить выполнение.

---

### Шаг 1.5 — Заполнить peerCache

```
telegram_get_dialogs()
```

Обязательный шаг: заполняет внутренний кэш групп (chatId → InputPeer с accessHash).
Без него `telegram_send_dm` не сможет резолвить пользователя через `InputPeerUserFromMessage`.

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

### Шаг 4 — Проверить cooldown через dm_threads

Для каждого кандидата:

```
dm_threads_exists(agentId: <agentId>, userId: <candidate.userId>)
```

Обработка результата:

- `{ exists: true, cooldownActive: true }` → пометить кандидата `skipped` (`dm_candidates_update_status`) и перейти к следующему. Тред ещё активен (менее 14 дней с последней активности).

- `{ exists: true, cooldownActive: false }` → cooldown истёк (прошло более 14 дней). Удалить старый тред:
  ```
  dm_threads_delete(agentId: <agentId>, userId: <candidate.userId>)
  ```
  Затем кандидат проходит дальше на отправку.

- `{ exists: false }` → треда нет, кандидат проходит дальше на отправку.

---

### Шаг 5 — Отправить DM

Инициализировать счётчики перед началом цикла: `sentThisRun = 0`, `floodErrors = 0`, `sentToday = <count из Шага 0>`.

Использовать весь список кандидатов, прошедших cooldown-фильтр (Шаг 4), отсортированный по `score DESC`.

Для каждого кандидата выполнить:

**В начале каждой итерации:** остановить цикл и перейти к Шагу 6 если `sentThisRun >= 2` или `sentToday >= 15`.

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

#### 5b — Отправить DM

```
telegram_send_dm(
  userId:  <candidate.userId>,
  chatId:  <candidate.sourceChatId>,
  msgId:   <candidate.msgId>,
  text:    <DM из 5a>,
  agentId: <agentId>
)
```

Передаём `chatId` + `msgId` (группа и сообщение, где пользователь писал) — инструмент использует `InputPeerUserFromMessage`, что устраняет `PEER_ID_INVALID` для min-сущностей.

**НЕ передавать `historyRecord`** — запись треда делается отдельным вызовом на шаге 5c.

Обработка результатов — действует немедленно, до любых других шагов:

- `{ ok: true, messageId }` → перейти к шагу 5c (создать тред)
- `{ error: 'peer_flood' }` → **немедленно прервать цикл** (не выполнять 5c), перейти к Шагу 6. PEER_FLOOD означает временный бан аккаунта на отправку DM. Оставить статус кандидата `pending`.
- `{ error: 'flood_wait' }` → увеличить `floodErrors` на 1; если `floodErrors >= 5` — прервать цикл, перейти к Шагу 6; иначе — пропустить этого кандидата (не выполнять 5c), перейти к следующему
- `{ error: 'privacy_blocked' }` → вызвать `dm_candidates_update_status(status: 'privacy_blocked')`, не выполнять 5c, перейти к следующему кандидату
- `{ error: 'deactivated' }` → вызвать `dm_candidates_update_status(status: 'deactivated')`, не выполнять 5c, перейти к следующему кандидату
- `{ error: 'peer_id_invalid' }` → вызвать `dm_candidates_update_status(status: 'skipped')`, не выполнять 5c, перейти к следующему кандидату **без паузы**. Не считать за успешную отправку. `sentThisRun` не увеличивать.
- Любой другой `{ error: '...' }` → вызвать `dm_candidates_update_status(status: 'skipped')`, не выполнять 5c, перейти к следующему кандидату. Не считать за успешную отправку.

#### 5c — Создать тред (только после `{ ok: true }`)

```
dm_threads_create(
  agentId:        <agentId>,
  userId:         <candidate.userId>,
  userAccessHash: <candidate.userAccessHash>,
  userName:       null,
  fromChatId:     <candidate.sourceChatId>,
  triggerMessage: <candidate.msgText>,
  firstMessage: {
    role:   "agent",
    msgId:  <messageId из ответа telegram_send_dm>,
    text:   <DM из 5a>,
    sentAt: <текущий unix timestamp>
  }
)
```

#### 5d — Обновить статус кандидата (только после 5c)

```
dm_candidates_update_status(agentId: <agentId>, id: <candidate.id>, status: 'sent')
```

Увеличить `sentThisRun` и `sentToday` на 1.

#### 5e — Пауза (только после успешной отправки)

Подождать **30–60 секунд** (случайно) перед следующей итерацией. Выполняется только при `ok: true` (шаги 5a–5d). При любой ошибке — переходить к следующему кандидату без паузы.

---

### Шаг 6 — Итоговое уведомление

Отправить сообщение в Saved Messages с итогами прогона.

---

## Инструменты

| Инструмент | Шаг | Файл |
|------------|-----|------|
| `dm_threads_count_today` | 0 | dm-threads-db.ts |
| `tg_load_account` | 1 | index.ts |
| `telegram_get_dialogs` | 1.5 | index.ts |
| `dm_candidates_expire_old` | 2 | channels-db.ts |
| `dm_candidates_get_pending` | 3 | channels-db.ts |
| `dm_threads_exists` | 4 | dm-threads-db.ts |
| `dm_threads_delete` | 4 | dm-threads-db.ts |
| `dm_candidates_update_status` | 4, 5d | channels-db.ts |
| `telegram_send_dm` | 5b | index.ts |
| `dm_threads_create` | 5c | dm-threads-db.ts |
