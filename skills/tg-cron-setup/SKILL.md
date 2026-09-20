---
name: tg-cron-setup
description: "DEPRECATED — выведен из эксплуатации. Creates a cron job for periodic Telegram group chat monitoring for a given agent. Use when the user wants to set up a scheduled monitoring task for a specific agent."
---

# Telegram Cron Setup

> **DEPRECATED.** Скилл выведен из эксплуатации, использовать не нужно.

## Шаг 1 — Определить agentId

`agentId` находится в разделе **Runtime** системного промпта (поле `agentId`). Использовать это значение во всех последующих вызовах инструментов.

---

## Шаг 2 — Создать cron-задачу

```bash
openclaw cron add \
  --name "tg-group-monitor-cron-<agentId>" \
  --cron "0 */3 * * *" \
  --tz "Asia/Yekaterinburg" \
  --session isolated \
  --enabled true \
  --agent <agentIdты > \
  --message "Запусти скилл telegram-group-monitor. После каждого завершения работы задачи пиши мне в этот чат результат выполнения, который включает: 1. результат выполнения. Были ли ошибка во время выполнения или нет, если да, то какие; 2. сколько и какие чаты обработаны; 3. Список чатов, для каждого: - сколько сообщений обработано - основные темы - отобранные для ответа сообщения и ответы на них"
```

---

## Итог

Сообщить пользователю job id и подтверждение успешного создания:

```
Cron-задача создана.
- Имя: tg-group-monitor-cron-<agentId>
- Агент: <agentId>
- Расписание: каждые 3 часа
- Job ID: <job_id>
```
