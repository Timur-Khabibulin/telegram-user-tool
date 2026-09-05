## Why

У агентов накапливаются сотни каналов с низким охватом и малым числом подписчиков — они расходуют флуд-бюджет и засоряют воронку без пользы. Нужен ручной инструмент, чтобы оператор мог очистить слабые каналы одной командой.

## What Changes

- Новый OpenClaw-инструмент `tg_channel_cleanup`: принимает список агентов и пороги фильтрации, выходит из слабых каналов и удаляет все данные по ним из всех БД
- Таблица `channels` расширяется полем `subs_count INTEGER` и `avg_views_updated_at` переименовывается в `coverage_updated_at`
- Скрипт `channel-coverage-update` дополняется сбором `subs_count` при ежемесячном обходе каналов
- Инструмент отправляет итоговый отчёт в Saved Messages каждого агента

## Capabilities

### New Capabilities

- `channel-cleanup`: ручная очистка слабых каналов у агентов по порогам `avg_views` и `subs_count` с полным удалением данных из всех БД

### Modified Capabilities

- `channel-coverage`: скрипт `channel-coverage-update` теперь также сохраняет `subs_count`; поле `avg_views_updated_at` переименовывается в `coverage_updated_at`

## Impact

- `src/core/db/channels.ts` — миграция схемы, новые/переименованные функции (`saveCoverage`, `getChannelsForCoverageUpdate`, `getChannelsForCleanup`)
- `src/core/db/discovery.ts` — новая функция `deleteDiscoveredChannel`
- `src/scripts/channel-coverage-update.ts` — добавить сбор `subs_count`
- `src/skills/channel-cleanup.ts` — новый файл
- `src/index.ts` — регистрация инструмента + правка локального типа `Row` в `tg_channel_coverage_report`
