## Why

Оператору регулярно нужно оценить произвольный список Telegram-каналов (например, найденных вручную по теме) по числу подписчиков, среднему охвату поста, наличию комментариев и типу (broadcast/группа) — прежде чем решать, добавлять ли их агенту. Сейчас это делается вручную через SQL-запросы к `tg-channels.db` уже отслеживаемых каналов конкретного агента — способа посчитать метрики для произвольного списка ссылок, включая каналы, которые ни один агент ещё не отслеживает, нет.

## What Changes

- Новый standalone-скрипт `src/scripts/channel-metrics.ts`: читает CSV со списком ссылок (колонка `link`), для каждой через MTProto (сессия агента, заданного оператором) определяет число подписчиков, средний охват последних постов, открыты ли комментарии (привязана ли группа обсуждения) и является ли канал broadcast-каналом; результат построчно (инкрементально) дописывает в выходной CSV.
- Резюмируемость: повторный запуск с тем же `--output` пропускает ссылки, уже присутствующие в файле (успешные и завершившиеся ошибкой) — так прогон на сотнях ссылок переживает обрыв (`FLOOD_WAIT`-стоп, ошибка сети) без потери прогресса.
- `TelegramService.resolveChannelByUsername` (`src/core/telegram/service.ts`) дополняется полем `isBroadcast` в возвращаемом `ChannelHandle` — сейчас `channel.broadcast` из ответа Telegram отбрасывается.
- Формула среднего охвата (`getRecentPosts(11)` → среднее по постам с индекса 1 по 10, пропуская самый свежий) выносится из `src/scripts/channel-coverage-update.ts` в переиспользуемую функцию и используется в обоих местах — без изменения поведения `channel-coverage-update.ts`.
- Новый Claude Code skill `.claude/skills/channel-metrics/SKILL.md` — инструктирует, как залить входной CSV на VPS, запустить скрипт с нужным `--agent` и скачать результат обратно (по аналогии с `.claude/skills/vps`, `.claude/skills/funnel-stats`). Это интерфейс для оператора, не способность рантайм-агента (не размещается в `skills/`, не проходит через `dispatcher`).

## Capabilities

### New Capabilities

- `channel-metrics`: расчёт метрик произвольного списка Telegram-каналов (подписчики, средний охват, комментарии, тип канала) по CSV-списку ссылок через MTProto одной сессией агента, с построчной записью результата и резюмируемостью прогона.

### Modified Capabilities

<!-- Нет: channel-coverage-update.ts меняется только по составу кода (вынесенная формула), формула и её результат не меняются — не behavior-level изменение существующей способности, delta spec не нужен. -->

## Impact

- `src/scripts/channel-metrics.ts` — новый файл, standalone-скрипт (`tsx`, ручной запуск оператором, без systemd/dispatcher).
- `src/core/telegram/service.ts` — `ChannelHandle` получает поле `isBroadcast`; `resolveChannelByUsername` заполняет его из `channel.broadcast`.
- `src/scripts/channel-coverage-update.ts` — использует вынесенную функцию среднего охвата вместо инлайн-формулы; поведение не меняется.
- `src/core/db/discovery.ts` — переиспользуется существующая `normalizeChannelLink` (без изменений в самой функции).
- `.claude/skills/channel-metrics/SKILL.md` — новый Claude Code skill.
- `docs/operation.md` — раздел про ручные операторские скрипты дополняется `channel-metrics.ts` (если такой раздел есть; иначе — короткая заметка).
- Зависимости: Telegram MTProto (`channels.GetFullChannel`, `getMessages`, `contacts.ResolveUsername`) через уже существующие методы `TelegramService`; без новых внешних сервисов (TGStat сознательно не используется).
