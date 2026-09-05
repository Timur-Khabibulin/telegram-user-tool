## 1. Миграция БД — coverage_updated_at и subs_count

- [x] 1.1 В `src/core/db/channels.ts` реализовать `migrateCoverageColumns`: RENAME COLUMN `avg_views_updated_at` → `coverage_updated_at` (если существует), ADD COLUMN `subs_count INTEGER` (если не существует)
- [x] 1.2 Заменить вызов `migrateAvgViewsColumns` на `migrateCoverageColumns` в `initChannels`
- [x] 1.3 Обновить интерфейс `CoverageChannelRow`: `avg_views_updated_at` → `coverage_updated_at`, добавить `subs_count: number | null`
- [x] 1.4 Переименовать `saveAvgViews` → `saveCoverage(agentId, chatId, avgViews, subsCount)`: обновляет оба поля + `coverage_updated_at`
- [x] 1.5 Переименовать `getChannelsForAvgUpdate` → `getChannelsForCoverageUpdate`: фильтр по `coverage_updated_at`
- [x] 1.6 Обновить `getAllChannelsWithAvgViews`: SELECT добавить `subs_count`, вызов `migrateCoverageColumns`, обновить возвращаемый тип
- [x] 1.7 Добавить функцию `getChannelsForCleanup(agentId): CleanupChannelRow[]` — SELECT всех каналов с полями `chatId, title, avg_views, subs_count, channelUsername, channelResolved`
- [x] 1.8 В `index.ts` (корневой) в инструменте `tg_channel_coverage_report` исправить локальный тип `Row` и обращения: `avg_views_updated_at` → `coverage_updated_at`

## 2. channel-coverage-update — сбор subs_count

- [x] 2.1 В `src/scripts/channel-coverage-update.ts` заменить импорты: `getChannelsForAvgUpdate` → `getChannelsForCoverageUpdate`, `saveAvgViews` → `saveCoverage`
- [x] 2.2 После расчёта `avg_views` добавить вызов `tg.getChannelSubsCount(inputChannel)` с паузой 500 мс; обработать `FloodWaitError` — ждать `waitSeconds`, ретрай один раз; при повторной ошибке `subsCount=null`
- [x] 2.3 Передавать оба значения в `saveCoverage(agentId, chatId, avgViews, subsCount)`

## 3. discovery.ts — удаление канала

- [x] 3.1 В `src/core/db/discovery.ts` добавить функцию `deleteDiscoveredChannel(adminAgentId, canonicalLink): { deleted: boolean }` — DELETE строки из `discovered_channels`

## 4. Инструмент и скилл channel-cleanup

- [x] 4.1 Создать `src/skills/channel-cleanup.ts` с типами `ChannelCleanupParams`, `ChannelCleanupResult`, `AgentResult`, `ChannelResult`
- [x] 4.2 Реализовать `filterCandidates(channels, params)` — AND-логика с `NULL → 0`
- [x] 4.3 Реализовать `formatReport(agentId, result)` — формат сообщения для Saved Messages
- [x] 4.4 Реализовать `runChannelCleanup(params, tg, log)`: loadAccount → getDialogs → getChannelsForCleanup → filterCandidates → leaveChannel → purgeChannelData → deleteDiscoveredChannel → sendSavedMessage
- [x] 4.5 В `index.ts` (корневой) зарегистрировать инструмент `tg_channel_cleanup` с параметрами `agents`, `minSubsCount`, `minAvgViews`; валидация — ошибка если оба фильтра не заданы; вызывает `runChannelCleanup`
- [x] 4.6 Создать `skills/channel-cleanup/SKILL.md` — скилл собирает у оператора параметры (`agents`, `minSubsCount`, `minAvgViews`), затем вызывает один инструмент `tg_channel_cleanup(agents, minSubsCount, minAvgViews)` и сообщает итог; по образцу `skills/channel-discovery/SKILL.md`
