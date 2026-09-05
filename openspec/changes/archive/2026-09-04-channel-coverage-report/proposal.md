## Why

Оператор не имеет единого взгляда на аудиторную ценность каналов: данные разбросаны
по per-agent БД, средний охват нигде не считается. Без этой метрики невозможно быстро
понять, в каких каналах сосредоточена наибольшая аудитория для DM-воронки.

## What Changes

- Новый OpenClaw-инструмент `tg_channel_coverage_report`: собирает каналы всех агентов,
  читает кэшированный `avg_views`, формирует CSV-файл и отправляет в Saved Messages агента.
- Новый OpenClaw-скилл `skills/channel-coverage-report/SKILL.md`: точка входа для
  оператора — вызов из OpenClaw, дёргает инструмент выше.
- Новый standalone-скрипт `src/scripts/channel-coverage-update.ts`: обходит все агенты,
  запрашивает последние 11 постов каждого канала через MTProto и обновляет `avg_views`
  в per-agent БД.
- Новые systemd-юниты `tg-channel-coverage-update.{service,timer}`: запускают скрипт
  пересчёта раз в месяц (1-го числа, 03:00 UTC).
- Расширение таблицы `channels`: два новых поля `avg_views` и `avg_views_updated_at`,
  добавляются аддитивной миграцией.

## Capabilities

### New Capabilities

- `channel-coverage-report`: Единый отчёт по среднему охвату каналов — генерация
  CSV-файла со всеми каналами всех агентов, отсортированными по `avg_views` DESC,
  и доставка в Saved Messages.
- `channel-avg-views-cache`: Кэш среднего охвата канала в per-agent БД — вычисление
  по последним 10 постам (пропуская самый свежий) и плановое обновление раз в месяц.

### Modified Capabilities

## Impact

- `src/core/db/channels.ts` — аддитивная миграция + 3 новые функции
- `src/core/config.ts` — новая константа `AVG_VIEWS_CACHE_TTL_SECONDS`
- `src/index.ts` — регистрация нового инструмента
- `src/core/telegram/service.ts` — использование существующего `getRecentPosts`
- Новые файлы: скрипт, два systemd-юнита, SKILL.md
- Зависимости: нет новых npm-пакетов