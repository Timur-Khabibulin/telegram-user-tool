## 1. Схема данных

- [x] 1.1 Добавить в `src/core/db/channels.ts` аддитивную миграцию `migrateActivityColumns` (`active_writers_p50 REAL`, `active_writers_p90 REAL`, `activity_updated_at INTEGER`), вызвать из `initChannels`
- [x] 1.2 Добавить `getChannelsForActivityUpdate(agentId, ttlSeconds): { chatId }[]` — все строки `channels` (без исключения `banned`/`suspend`) с `activity_updated_at IS NULL OR` истёкшим TTL, по образцу `getChannelsForCoverageUpdate`
- [x] 1.3 Добавить `getAllChannels(agentId): { chatId, channelId, channelAccessHash, channelResolved }[]` для ручного режима (все каналы агента, TTL не учитывается; поля идентичности — чтобы ручной режим мог форсировать пересчёт и `avg_views`/`subs_count` там, где применимо)
- [x] 1.4 Добавить `saveActivityPercentiles(agentId, chatId, p50: number | null, p90: number | null): void`
- [x] 1.5 Добавить `getActivityPercentilesByChatIds(agentId, chatIds: string[]): Map<string, { p50: number | null; p90: number | null }>` — для резолва в CSV-разбивке (по образцу `getChatTitlesAndUsernames`)

## 2. Чтение истории и расчёт перцентиля

- [x] 2.1 В `src/core/telegram/service.ts` добавить метод чтения полной истории чата за датное окно (например `getChatHistorySince(chatId, sinceSec): TgMessage[]`), с пагинацией GramJS, возвращающий `{ fromId, date }` по каждому сообщению; FLOOD_WAIT → `FloodWaitError` (как у существующих методов)
- [x] 2.2 Добавить чистую функцию расчёта перцентиля (например `src/core/activity-percentile.ts`): вход — список `{ date }` сообщений за окно, строит ряд из 30 суточных `COUNT(DISTINCT fromId)` (граница суток — UTC+5, `startOfUtcPlus5Day`), сутки без сообщений = 0, возвращает `{ p50, p90 }` линейной интерполяцией по отсортированному ряду
- [x] 2.3 Юнит-тест функции перцентиля: постоянная активность, тихие дни, пустой канал (все 0), сверка p50/p90 с эталонным расчётом (numpy/Excel-совместимым) — `node --import tsx --test src/core/activity-percentile.test.ts`, 5/5 pass

## 3. Скрипт планового и ручного пересчёта (слияние с `channel-coverage-report`)

- [x] 3.1 Создать `src/scripts/channel-activity-update.ts` по образцу `channel-coverage-update.ts`: один `TelegramService`, последовательный цикл по агентам
- [x] 3.2 Перенести в него существующую логику `channel-coverage-update.ts` (`getChannelsForCoverageUpdate`, `getRecentPosts`+`computeAvgViews`, `getChannelSubscribers`, `saveCoverage`, retry на FLOOD_WAIT) как есть, без изменения контракта БД
- [x] 3.3 Плановый режим (без `--agents`): на канал агента — независимо проверить оба TTL (`coverage_updated_at` для avg_views/subs_count, `activity_updated_at` для перцентилей) и выполнить то, что просрочено; ошибка канала (в любой из двух групп метрик) — пропуск с логом, не блокирует вторую группу метрик того же канала и остальные каналы
- [x] 3.4 Ручной режим: флаг `--agents a1,a2,...` — список агентов явный, TTL игнорируется для ОБЕИХ групп метрик, берутся все каналы через `getAllChannels`; опциональный `--limit N` — обрезать список каналов агента до N перед обработкой
- [x] 3.5 FLOOD_WAIT retry на каждый MTProto-вызов (историю чата, посты канала, подписчиков) — тот же паттерн, что в `channel-coverage-update.ts`
- [x] 3.6 Без потолка на объём истории, без ограничения времени прогона, без параллелизма между агентами (design.md, Decisions 2-3)
- [x] 3.7 Удалить `src/scripts/channel-coverage-update.ts`

## 4. Systemd-юнит планового прогона (замена coverage-юнита)

- [x] 4.1 Создать `deploy/systemd/tg-channel-activity-update.service` (oneshot) по образцу `tg-channel-coverage-update.service`
- [x] 4.2 Создать `deploy/systemd/tg-channel-activity-update.timer` — ежедневно 03:00 UTC (это фактическое расписание `tg-channel-coverage-update.timer`; таблица в `docs/operation.md`, называющая его месячным, устарела — TTL 30 дней проверяется скриптом на канал, ежедневный тик лишь быстрее подхватывает новые/просроченные каналы)
- [x] 4.3 Удалить `deploy/systemd/tg-channel-coverage-update.service`, `deploy/systemd/tg-channel-coverage-update.timer` из репозитория. VPS-часть (`systemctl disable --now tg-channel-coverage-update.timer`, убрать файлы из `/etc/systemd/system/`, `daemon-reload`) — деплой-шаг, выполняется при развёртывании этого изменения на сервере, не при разработке
- [x] 4.4 Обновить `docs/operation.md` (таблица systemd-юнитов, команды установки/включения — заменить строку coverage-update на activity-update; заодно поправлено неверное «1-е число» на фактическое ежедневное расписание) и `docs/configuration.md` (упоминание юнита в списке `EnvironmentFile`)

## 5. Отчёт

- [x] 5.1 В `src/core/funnel-collect.ts` при сборке `channelBreakdown` резолвить p50/p90 через `getActivityPercentilesByChatIds` по списку `chatId` разбивки, добавить поля в `ChannelSendBreakdownRow`
- [x] 5.2 В `src/core/funnel-report.ts` (`buildFunnelCsv`) добавить колонки `active_writers_p50`/`active_writers_p90` в `breakdownHeader`/`breakdownRows`, пустая строка при `null`

## 6. Документация схемы

- [x] 6.1 Обновить `docs/db-schema.puml` — новые колонки `channels` (+ описательная заметка)
- [x] 6.2 Проверено: `docs/architecture.md`/`docs/README.md` скрипт/юнит не упоминают, правка не нужна; `docs/architecture-diagrams.md` и `docs/telegram-errors.md` упоминали старое имя скрипта — обновлены на `channel-activity-update`

## 7. Проверка

- [x] 7.3 `npx tsc --noEmit` — новых ошибок в затронутых файлах нет (только пре-существующие несвязанные: `better-sqlite3` без типов, `bigint`/`EntityLike` в service.ts, `index.ts`/`join-queue.ts`); юнит-тесты перцентиля — 5/5 pass

## 8. Интерактивный запуск через OpenClaw

- [x] 8.1 Добавить `TimeoutStartSec=infinity` в `tg-channel-activity-update.service` (баг: без этого дефолтный таймаут systemd убил бы длинный прогон)
- [x] 8.2 Создать шаблонный `deploy/systemd/tg-channel-activity-update-manual@.service` (`%i` = agentId1-agentId2-...[.limitN]) с тем же `TimeoutStartSec=infinity`
- [x] 8.3 Добавить `triggerActivityUpdate(agentIds, limit, log)` в `src/core/scheduler-control.ts` — валидация agentId/limit, сборка instance, `systemctl start` через существующий приватный помощник
- [x] 8.4 Зарегистрировать инструмент `tg_channel_activity_update` в `index.ts` (agentIds обязателен, limit опционален) — вызывает `triggerActivityUpdate`, не использует общий `tg` плагина
- [x] 8.5 Создать `skills/channel-activity-update/SKILL.md`
- [x] 8.6 `npx tsc --noEmit` — новых ошибок нет

## 9. Устранение OOM (прод-инциденты 2026-08-23/25)

- [x] 9.1 `TelegramService.getChatHistorySince` → `iterChatHistorySince` (async-генератор поверх GramJS `iterMessages`), без накопления сообщений в массиве
- [x] 9.2 `ActivityAccumulator` (`activity-percentile.ts`) — потоковый приёмник сообщений (раскладывает по суткам инкрементально), `computeActivityPercentiles` переиспользует его как обёртку для тестов
- [x] 9.3 `channel-activity-update.ts` — `updateActivity` читает через `iterChatHistorySince`/`ActivityAccumulator`, не собирает массив; проверено на канале со 104234 сообщениями/30д без падения
- [x] 9.4 Юнит-тесты перцентиля обновлены под новую сигнатуру (не менялись по сути) — 5/5 pass
- [x] 9.5 Новый `deploy/systemd/tg-channel-activity-update.slice` (`MemoryMax=1G`); плановый и ручной юниты переключены с `tg-agents.slice`
- [x] 9.6 Задержки пейсинга (`sleep(500)`/`sleep(2000)` между MTProto-вызовами охвата) заменены на `sleepRandom` (`skills/util.ts`) — `FLOOD_WAIT`-ожидание осталось детерминированным (время задаёт Telegram)
- [x] 9.7 Окно активности сокращено с 30 до 7 дней (`WINDOW_DAYS` в `activity-percentile.ts`) — меньше сырых сообщений на канал при том же классе риска; TTL пересчёта (`ACTIVITY_CACHE_TTL_SECONDS`) осознанно остался 30 дней
- [x] 9.8 Деплой всех изменений на VPS, повторный прогон на ранее упавших агентах — прогресс подтверждён (17/20 агентов полностью пересчитаны за один прогон, падение на оставшихся — из-за общего слайса, устранено п.9.5)

## 10. Человеческий темп чтения MTProto

- [x] 10.1 `TelegramService.iterChatHistorySince` переведён на ручную пагинацию (`getMessages` + `offsetId`, без `iterMessages`) — батч 5-10 сообщений (рандомно на батч), пауза 10-20с между батчами; остановка по пустому батчу либо по выходу за `untilSec` окна
- [x] 10.2 Новый метод `TelegramService.getPostsOneByOne` — по одному посту за вызов (`offsetId`-пагинация), пауза 10-30с между постами; общий маппер `mapMessageToPost` вынесен, чтобы не дублировать с `getRecentPosts`
- [x] 10.3 `channel-activity-update.ts` переключён на `getPostsOneByOne` (было `getRecentPosts`) и на новую сигнатуру `iterChatHistorySince(chatId, startSec, endSec)` — остальные потребители `getRecentPosts` (`channel-metrics`, `channel-discovery`, `channel-content-analysis`, `channel-niche`) не тронуты
- [x] 10.4 `npx tsc --noEmit` — новых ошибок нет; юнит-тесты перцентиля не затронуты (5/5 pass)
- [x] 10.5 Деплой на VPS, рестарт gateway
