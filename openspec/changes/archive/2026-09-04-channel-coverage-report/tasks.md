## 1. Модель данных — миграция channels

- [x] 1.1 Добавить функцию `migrateAvgViewsColumns(db)` в `src/core/db/channels.ts` по паттерну `migrateChannelIdentityColumns` (PRAGMA table_info + ALTER TABLE ADD COLUMN для `avg_views REAL` и `avg_views_updated_at INTEGER`)
- [x] 1.2 Вызвать `migrateAvgViewsColumns(db)` из `initChannels` третьим вызовом после `migrateChannelIdentityColumns`
- [x] 1.3 Добавить константу `AVG_VIEWS_CACHE_TTL_SECONDS = 30 * 86400` в `src/core/config.ts`

## 2. Слой данных — новые функции channels.ts

- [x] 2.1 Реализовать `getChannelsForAvgUpdate(agentId): ChannelForAvgUpdate[]` — выборка каналов с `channelResolved=1`, `channelId IS NOT NULL`, у которых TTL истёк (`avg_views_updated_at IS NULL OR avg_views_updated_at <= now() - TTL`)
- [x] 2.2 Реализовать `saveAvgViews(agentId, chatId, avgViews: number | null)` — UPDATE channels SET avg_views, avg_views_updated_at=now()
- [x] 2.3 Реализовать `getAllChannelsWithAvgViews(agentId): CoverageChannelRow[]` — SELECT всех каналов с полями для отчёта; вызывать `migrateAvgViewsColumns(db)` перед SELECT

## 3. Скрипт пересчёта avg_views

- [x] 3.1 Создать `src/scripts/channel-coverage-update.ts` по образцу `funnel-tracker.ts`: цикл по `listAgentIds()`, `initChannels`, `getChannelsForAvgUpdate`
- [x] 3.2 Реализовать вычисление avg_views: `getRecentPosts(inputChannel, 11)`, пропустить `posts[0]`, взять `posts.slice(1, 11)`, `SUM(views) / sample.length`
- [x] 3.3 Обработка FloodWaitError: sleep(seconds * 1000) → retry once → skip на повторной ошибке
- [x] 3.4 Добавить `sleep(2000ms)` между запросами каналов; `tg.disconnect()` после каждого агента

## 4. systemd-юниты

- [x] 4.1 Создать `deploy/systemd/tg-channel-coverage-update.service` (Type=oneshot, WorkingDirectory, ExecStart tsx скрипта, TimeoutStartSec=1800)
- [x] 4.2 Создать `deploy/systemd/tg-channel-coverage-update.timer` (OnCalendar=*-*-01 03:00:00 UTC, Persistent=true)

## 5. OpenClaw-инструмент

- [x] 5.1 Зарегистрировать инструмент `tg_channel_coverage_report` в `src/index.ts` без параметров
- [x] 5.2 Реализовать тело инструмента: собрать все каналы через `getAllChannelsWithAvgViews` по всем агентам, добавить поле `agentId`
- [x] 5.3 Реализовать сортировку: `avg_views DESC`, каналы с NULL — в конце
- [x] 5.4 Реализовать генерацию CSV-строки с заголовком: `Название,Ссылка,chat_id,Средний охват,Дата пересчёта,Агент`
- [x] 5.5 Записать CSV во временный файл (`os.tmpdir()`), вызвать `tg.sendSavedDocument` от agent1, удалить файл

## 6. OpenClaw-скилл

- [x] 6.1 Создать `skills/channel-coverage-report/SKILL.md` с инструкцией: вызвать `tg_channel_coverage_report`, сообщить оператору количество каналов и агентов в ответе

## 7. Деплой

- [x] 7.1 Задокументировать шаги деплоя в `docs/operation.md`: копирование юнитов, `systemctl enable --now tg-channel-coverage-update.timer`
