---
name: join-queue-run
description: "Cron skill: processes one batch from the join queue. Joins channels, updates statuses, self-deletes the cron job when queue is exhausted."
---

# Join Queue Run

## Алгоритм выполнения

### Шаг 1 — Загрузить конфигурацию аккаунта

```
tg_load_account(agentId: <agentId из промпта>)
```

Если ошибка — завершить выполнение.

---

### Шаг 2 — Взять батч из очереди

```
tg_join_queue_get_batch(
  agentId: <agentId>,
  limit:   15
)
```

**Если `links` пустой** — очередь исчерпана. Перейти к шагу 4 (самоудаление).

---

### Шаг 3 — Обработать батч целиком

Передать **все** ссылки из батча одним вызовом:

```
telegram_join_discussion_groups(links: <все links из батча>)
```

Инструмент сам делает паузы между ссылками и обрабатывает FLOOD_WAIT с повторной попыткой. Ждать его завершения.

#### 3.1 Обновить статусы

Для каждой записи из `results`:

- `status = "joined"` →
  ```
  tg_join_queue_update(agentId: <agentId>, link: <link>, status: "joined")
  ```
- `status = "skipped"` И `reason` НЕ содержит `"FLOOD_WAIT"` →
  ```
  tg_join_queue_update(agentId: <agentId>, link: <link>, status: "skipped")
  ```
- `status = "skipped"` И `reason` содержит `"FLOOD_WAIT"` →
  ```
  tg_join_queue_update(agentId: <agentId>, link: <link>, status: "error", error: <reason>)
  ```

#### 3.2 При FLOOD_WAIT

Если в ответе `hadFloodWait = true` — Telegram начал ограничивать запросы. **Завершить прогон** после обновления всех статусов. Следующий батч обработается при очередном запуске cron через 3 часа.

---

### Шаг 4 — Самоудаление кроны (только если батч был пустой)

```
CronList()
```

Найти задачу с именем `tg-join-queue-<agentId>`, взять её `id`.

```
CronDelete(id: <jobId>)
```

Завершить выполнение.
