## Why

Отчёт-воронка показывает, в какие каналы агенты отправили сообщения за день, но не даёт понять, насколько эти каналы вообще живые — сколько разных людей пишет там в обычные сутки. Без этой метрики нельзя отличить канал с активным ежедневным обсуждением от канала, где пишут два человека раз в неделю: обе ситуации сейчас выглядят в отчёте одинаково (просто «сообщение отправлено»). p50/p90 уникальных отправителей в сутки за последний месяц — устойчивая (percentile, не среднее) характеристика реальной жизни канала, нужная для оценки качества площадок в отчёте по каналам.

## What Changes

- Новые колонки `channels.active_writers_p50`, `channels.active_writers_p90`, `channels.activity_updated_at` (per-agent `tg-channels.db`) — аддитивная миграция.
- Новый скрипт `channel-activity-update.ts` читает историю сообщений каждого канала (`channels.chatId`) за последние 30 календарных суток (UTC+5), считает `COUNT(DISTINCT fromId)` по суткам (сутки без сообщений = 0), сохраняет p50/p90 (линейная интерполяция) с TTL-отбором каналов — по образцу `channel-coverage-update.ts`.
- **Слияние с существующим `channel-coverage-report`**: тот же новый скрипт берёт на себя и уже существующий пересчёт `avg_views`/`subs_count` (сейчас — отдельный `channel-coverage-update.ts`), в одном проходе по каналам агента. Старый скрипт и его systemd-юнит (`tg-channel-coverage-update.service`/`.timer`) удаляются — иначе два похожих джоба независимо обходили бы одни и те же каналы (таймер триггерится ежедневно, TTL 30 дней проверяется на канал).
- Новый systemd-юнит (`.service`+`.timer`) для планового прогона объединённого скрипта, по образцу `tg-channel-coverage-update.timer`.
- Ручной режим того же скрипта: явный список `agentId` на входе, TTL игнорируется (пересчитываются все каналы каждого указанного агента), опциональный `--limit N` — обработать только первые N каналов у каждого агента.
- Две новые колонки (p50, p90) в существующей CSV-таблице «разбивка отправленных сообщений по каналам» дневного funnel-отчёта (`buildFunnelCsv`) — значения подтягиваются по `chatId` из `channels`.
- Ручной пересчёт доступен и интерактивно через OpenClaw: новый инструмент `tg_channel_activity_update` (`agentIds` + опциональный `limit`) запускает `tg-channel-activity-update-manual@<instance>.service` (новый шаблонный systemd-юнит) через `systemctl start` и не дожидается завершения — прогон может идти минуты-часы, инструмент возвращает только факт запуска. Скилл `channel-activity-update` описывает, когда и как его вызывать.

## Capabilities

### New Capabilities
- `channel-activity-percentiles`: расчёт и хранение p50/p90 уникальных отправителей сообщений в сутки за скользящий месяц на канал (плановый TTL-пересчёт + ручной запуск).
- `channel-coverage-report`: формализация уже существующего поведения (расчёт `avg_views`/`subs_count` по TTL) как spec-капабилити — впервые описывается нормативно, т.к. ранее было реализовано без spec-дельты; одновременно фиксируется перенос его исполнения в объединённый скрипт.

### Modified Capabilities
- `funnel-report`: CSV-разбивка по каналам дополняется колонками p50/p90 активности канала.

## Impact

- `src/core/db/channels.ts` — новые колонки/миграция, TTL-выборка каналов (активность + coverage), сохранение результатов, геттер p50/p90 по списку `chatId`.
- Новый `src/scripts/channel-activity-update.ts` (плановый + ручной режим; активность + `avg_views`/`subs_count`).
- Удаляются `src/scripts/channel-coverage-update.ts`, `deploy/systemd/tg-channel-coverage-update.service`, `deploy/systemd/tg-channel-coverage-update.timer`.
- `src/core/telegram/service.ts` — метод чтения истории чата по датному окну (если существующего `getMessages` недостаточно для выборки «все сообщения за 30 суток», без ограничения по `minId`/непрочитанным).
- `src/core/funnel-collect.ts` — резолв p50/p90 по `chatId` при сборке `channelBreakdown`.
- `src/core/funnel-report.ts` — новые колонки в `buildFunnelCsv`.
- `deploy/systemd/` — новый `.service`+`.timer` (плановый) и новый шаблонный `tg-channel-activity-update-manual@.service` (ручной запуск из OpenClaw), удаление старых coverage-юнитов.
- `docs/operation.md`, `docs/db-schema.puml` — фиксация нового юнита (и удаления старого), колонок схемы.
- `src/core/scheduler-control.ts` — `triggerActivityUpdate` (валидация agentIds/limit, сборка instance, `systemctl start`).
- `index.ts` — инструмент `tg_channel_activity_update`.
- Новый `skills/channel-activity-update/SKILL.md`.
