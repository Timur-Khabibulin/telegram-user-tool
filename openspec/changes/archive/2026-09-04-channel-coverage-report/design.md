## Context

Каналы агентов хранятся в per-agent SQLite БД (`tg-channels.db`). Идентичность
канала (`channelId`, `channelAccessHash`) уже резолвится монитором через
`cacheChannelIdentities`. Метод `TelegramService.getRecentPosts(inputChannel, n)`
уже существует в `service.ts`. Отправка файлов в Saved Messages — через
`TelegramService.sendSavedDocument`, уже используется в `funnel-tracker.ts`.

## Goals / Non-Goals

**Goals:**
- Кэшировать `avg_views` в per-agent БД, обновлять раз в месяц через systemd
- Инструмент в `index.ts` читает кэш, формирует CSV, отправляет в Saved Messages agent1
- SKILL.md — точка входа оператора для ручного запуска

**Non-Goals:**
- Пересчёт avg_views при добавлении канала — будет захвачен плановым прогоном (новый канал получает `avg_views_updated_at IS NULL`, что попадает в условие пересчёта)
- Excel-формат — CSV достаточно для v1
- Фильтрация в отчёте по агенту или порогу охвата
- Группировка по агентам в отчёте

## Decisions

### D1. Кэш avg_views — в таблице `channels`, не в отдельной таблице

`avg_views` — атрибут канала. Добавляем два поля (`avg_views REAL`,
`avg_views_updated_at INTEGER`) аддитивной миграцией по паттерну
`migrateChannelIdentityColumns` — идемпотентный `PRAGMA table_info` + `ALTER TABLE ADD
COLUMN`. Миграция вызывается из `initChannels`, что гарантирует наличие колонок до
первого обращения скрипта.

Альтернатива (отдельная таблица): добавила бы JOIN без пользы.

### D2. Скрипт пересчёта — standalone, не расширение диспетчера

Диспетчер (`dispatcher.ts`) — per-agent, запускается каждые ~3 часа. Пересчёт раз в
месяц по всем агентам в одном прогоне — другой паттерн. Эталон: `funnel-tracker.ts`
(тоже обходит всех агентов, тоже monthly). Скрипт живёт в
`src/scripts/channel-coverage-update.ts`.

### D3. Telegram-сессия — одна на агента, disconnect после каждого

Скрипт обходит агентов последовательно, после каждого вызывает `tg.disconnect()`.
Это предотвращает накопление открытых сессий. `sleep(2000ms)` между каналами — защита
от FLOOD_WAIT внутри одной сессии.

### D4. Агент-отправитель отчёта — всегда agent1

Хардкод `FUNNEL_ADMIN_AGENT_ID` из конфига (тот же агент, что держит `funnel.db`).
Параметр `agentId` в инструменте не нужен — это упрощает SKILL.md до одного вызова
без диалога с оператором.

Альтернатива (параметр agentId): усложнила бы скилл без видимой пользы, т.к. отчёт
всегда нужен одному оператору.

### D5. MTProto-запрос — `getRecentPosts(inputChannel, 11)`

Метод уже есть в `service.ts`. Принимает `Api.InputChannel` из `channelId` +
`channelAccessHash` (строки из БД конвертируются в `bigInt`). `peerCache` не нужен.
Каналы с `channelResolved = 0` исключаются условием запроса — у них нет access hash.

### D6. Константа TTL — в `config.ts`

`AVG_VIEWS_CACHE_TTL_SECONDS = 30 * 86400` рядом с `CHANNEL_CHECK_PERIOD_SECONDS`.
Единый источник истины — используется и в скрипте пересчёта, и в `getChannelsForAvgUpdate`.

## Risks / Trade-offs

- **FLOOD_WAIT при большом числе каналов** → `sleep(2000ms)` между запросами + retry
  при FloodWaitError. Прогон на ~100 каналах займёт ~3-4 минуты — укладывается в
  `TimeoutStartSec=1800`.
- **Новый канал ждёт до месяца до первого avg_views** → Приемлемо: в отчёте канал
  виден с пустым охватом, оператор понимает «ещё не посчитано». При необходимости
  можно запустить `systemctl start tg-channel-coverage-update.service` вручную.
- **Каналы с `channelResolved=0`** → Пропускаются в скрипте; в отчёт попадают с
  `avg_views = NULL`.

## Migration Plan

1. Деплой кода — миграция колонок выполняется автоматически при следующем запуске
   монитора (`initChannels`).
2. Включить systemd-таймер: `systemctl enable --now tg-channel-coverage-update.timer`.
3. Первый пересчёт — 1-го следующего месяца или вручную через `systemctl start`.
4. Rollback: `ALTER TABLE channels DROP COLUMN` не поддерживается в SQLite < 3.35,
   но поля nullable — их наличие не ломает существующую логику.