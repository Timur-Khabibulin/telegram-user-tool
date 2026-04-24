# CLAUDE.md — Telegram Monitoring Agent (OpenClaw)

Этот файл содержит инструкции для Claude Code (claude.ai/code) при работе с данным репозиторием.

## Обзор проекта

Агент мониторинга Telegram-групп, работающий по расписанию через платформу **OpenClaw**. Агент читает непрочитанные сообщения из групповых чатов через реальный аккаунт Telegram (MTProto), оценивает релевантность и отвечает автономно.

---

## Структура репозитория

```
index.ts               # OpenClaw-плагин — MTProto-инструменты (5 шт.)
channels-db.ts         # DB-инструменты на SQLite для состояния батч-обработки (4 шт.)
SKILL.md               # Алгоритм работы агента (на естественном языке)
CRON_SETUP.md          # Промпт для агента при регистрации cron-задачи
```

---

## Платформа: OpenClaw (~2026.3.24)

- **Документация:** https://docs.openclaw.ai/ — прямые пути к разделам полезнее корневого индекса
- **GitHub:** https://github.com/openclaw/openclaw
- Плагины загружаются через **`jiti`** — TypeScript выполняется напрямую, без сборки
- `node_modules` должны присутствовать, устанавливать с флагом `--ignore-scripts`
    - Пакеты, требующие нативной сборки (node-gyp и др.), не работают
- Точка входа плагина объявлена в `package.json` в поле `openclaw.extensions` и в файле `openclaw.plugin.json`
- Файлы скиллов (`SKILL.md`) пишутся на естественном языке; инструменты, зарегистрированные включёнными плагинами, доступны агенту автоматически через function calling — никакого специального синтаксиса не нужно
---

## Архитектура плагина

Плагин использует `definePluginEntry` из `openclaw/plugin-sdk/plugin-entry`. Инструменты регистрируются через `api.registerTool(tool, { optional: true })` внутри колбэка `register(api)`. Каждый инструмент возвращает из `execute(_id, params)` объект вида:

```ts
{ content: [{ type: "text", text: JSON.stringify(data) }] }
```

### Конвенции SDK (openclaw 2026.3.24)

| Старый API | Текущий API |
|---|---|
| Экспорт plain-объекта | `definePluginEntry` из `openclaw/plugin-sdk/plugin-entry` |
| Raw JSON Schema | `Type.Object(...)` через `@sinclair/typebox` |
| `handler: async (params, ctx)` | `execute(_id, params)` |
| `ctx?.log` | `api.logger`, захватывается один раз в `register()` |
| `{ names: [...] }` | `{ optional: true }` |
| `configSchema` в `definePluginEntry` | перенесён в `openclaw.plugin.json` |
| Монолитный `"openclaw/plugin-sdk"` | только субпути |

---

## Telegram-инструменты (`index.ts`)

Все инструменты используют общий ленивый singleton `TelegramClient` (GramJS/MTProto) с ключом по аккаунту. Учётные данные (`apiId`, `apiHash`, `sessionString`) прописаны хардкодом в `resolveAccountConfig()`.

| Инструмент | Назначение |
|---|---|
| `telegram_get_dialogs` | Получить группы/каналы с непрочитанными сообщениями; заполняет `peerCache` |
| `telegram_get_messages` | Получить непрочитанные сообщения из чата начиная с `minId` |
| `telegram_mark_as_read` | Пометить сообщения прочитанными |
| `telegram_reply_to_message` | Отправить ответ на конкретное сообщение |
| `telegram_join_discussion_groups` | Резолвить username каналов и вступать в их группы обсуждений |

### Паттерн peerCache

```ts
const peerCache = new Map<string, Api.TypeInputPeer>();
```

- Заполняется в `telegram_get_dialogs` из `d.entity` (здесь всегда есть полный `access_hash`)
- Используется в `mark_as_read` и `reply` — никогда не использовать `client.getEntity(BigInt(...))` для восстановления пиров: in-memory кэш GramJS не переживает перезапуск процесса и возвращает невалидные `access_hash`, что приводит к `PEER_ID_INVALID`
- Кэш не переживает перезапуск процесса — на каждом прогоне нужно сначала вызывать `get_dialogs`
- `InputPeer` конструируется явно:
    - Канал/супергруппа → `new Api.InputPeerChannel({ channelId, accessHash })`
    - Базовая группа → `new Api.InputPeerChat({ chatId })`

---

## DB-инструменты каналов (`channels-db.ts`)

Управляют SQLite-базой по пути `~/.openclaw/workspace-{agentId}/tg-channels.db` через `better-sqlite3`. Хранят информацию о том, какие каналы и когда были обработаны.

| Инструмент | Назначение |
|---|---|
| `tg_channels_init` | Создать таблицу, если не существует |
| `tg_channels_sync` | Синхронизировать диалоги Telegram с БД (добавить/удалить/переименовать) |
| `tg_channels_get_batch` | Вернуть каналы, требующие обработки (никогда не обрабатывавшиеся или старше `periodSeconds`) |
| `tg_channels_mark_processed` | Обновить `lastProcessedAt` после каждого канала |

**Порядок вызовов на каждом прогоне агента описан в скилле SKILL.md:**

---

## Стратегия идемпотентности

**`telegram_mark_as_read` вызывается сразу после `telegram_get_messages`**, до любой LLM-логики и отправки ответов:

- Если агент упадёт в середине прогона, на следующем тике cron те же сообщения не будут обработаны повторно
- Отдельная база истории ответов не нужна
- Процесс идемпотентен между запусками по своей природе

---

## Полезные ссылки

- Документация OpenClaw: https://docs.openclaw.ai/
- GitHub OpenClaw: https://github.com/openclaw/openclaw
- Лимиты Telegram (2026): https://gramgpt.io/blog/telegram-limits-2026
- Что такое FLOOD_WAIT: https://gramgpt.io/blog/what-is-flood-wait-in-telegram-and-how-to-fix-it
- Как избежать заморозки аккаунта: https://gramgpt.io/blog/kak-obojti-zamorozku-telegram-akkauntov