## Why

`leave-banned-channels` сейчас запускается раз в сутки, обрабатывает всю
очередь `banned_channels` без лимита и без пауз между шагами (`resolve` →
`leave` мгновенно, без задержки между каналами) — узнаваемый машинный паттерн,
не совместимый с курсом на человекоподобное поведение аккаунтов, уже принятым
для `monitor-v5` (`monitor-v5-human-pacing-batching`). Раз в сутки также
слишком редко: канал с `CHAT_WRITE_FORBIDDEN` может продолжать копить шум до
суток. Отдельно от темпа — очередь `banned_channels` дублирует факт, который
уже пишется в `channels.status = 'banned'` в тех же двух местах кода, что
нарушает «один факт — один дом» (`docs/agent-playbook.md`).

## What Changes

- Период задачи `leave-banned` меняется с календарного (раз в сутки, 01:00
  Asia/Yekaterinburg) на периодический, 180 минут (3ч) — та же модель, что
  `join-queue`/`monitor`. Задача остаётся в `QUIET_HOURS_EXEMPT_TASKS` —
  может тикать и внутри окна 23:00–03:00 (осознанное решение, не побочный
  эффект).
- **BREAKING** (внутреннее, не публичный API): таблица `banned_channels`
  (`tg-channels.db`) и её функции (`enqueueBannedChannel`, `getBannedChannels`,
  `deleteBannedChannel`) удаляются целиком. Источник очереди на выход —
  `channels.status IN ('banned', 'should_leave')`.
- `ChannelStatus` расширяется значением `should_leave` (бессрочный статус, как
  `banned`/`format_error`). Кто проставляет `should_leave` — вне скоупа этого
  change (внешний, не связанный с этим кодом источник).
- Чтение очереди на выход получает лимит на батч (`20` каналов за прогон,
  `ORDER BY statusUpdatedAt ASC`) — раньше весь список читался без лимита.
- Скилл получает паузы между шагами (человекоподобный темп, по аналогии с
  `monitor-v5-human-pacing-batching`):
  - между `resolveChannelUsername` и `leaveChannel` — пауза `random(10,20)`с
    (всегда);
  - опционально (случайный гейт на канал) — до `leaveChannel` дополнительно
    читаются 1–3 (случайно) батча сообщений по `random(7,15)` с `markAsRead`
    после каждого батча и паузой `random(3,7)`с между батчами;
  - между обработкой каналов очереди — пауза `random(2,7)`с.
- Точки записи `banned_channels` в мониторе (`monitor-v2.ts`) и в обработке
  ошибок отправки комментариев (`post-comment-send.ts`) убираются — там
  остаётся только уже существующая запись `markChannelStatus(..., "banned")`.

## Capabilities

### New Capabilities
(нет — расширяется существующее поведение, новая способность не вводится)

### Modified Capabilities

- `leave-banned-channels`: источник очереди (`channels.status` вместо
  таблицы `banned_channels`), лимит батча, каденс запуска, человекоподобные
  паузы между шагами. Нормативная спека этой способности ещё не
  заархивирована в `openspec/specs/` — ближайший источник истины:
  `openspec/changes/leave-banned-channels/specs/leave-banned-channels/spec.md`
  (тот же приём, что уже использован в `monitor-v5-human-pacing-batching`).
- `group-monitoring`: требование «CHAT_WRITE_FORBIDDEN ставит канал в
  `banned_channels`» (delta в
  `openspec/changes/leave-banned-channels/specs/group-monitoring/spec.md`)
  меняется — постановка в очередь через отдельную таблицу убирается, остаётся
  только пометка статуса, которая уже происходит параллельно.

## Impact

- `src/skills/leave-banned-channels.ts` — переработка цикла (лимит, паузы,
  чтение батчей сообщений).
- `src/core/db/channels.ts` — удаление `banned_channels`/её функций, новая
  функция выборки по `status`, расширение `ChannelStatus`, функция сброса
  статуса после успешного выхода.
- `src/core/db/tasks.ts` — перенос `leave-banned` в `DEFAULT_PERIODIC_SCHEDULE`
  (`periodMinutes: 180`), `QUIET_HOURS_EXEMPT_TASKS` не меняется.
- `src/skills/monitor-v2.ts`, `src/core/post-comment-send.ts` — убрать вызовы
  `enqueueBannedChannel`.
- `src/core/config.ts` — новые константы пацинга и лимита батча.
- `docs/task-scheduling.md` — обновить таблицу расписаний.
- **Известный разброс, не решается в этом change**: тот же нормативный факт
  («CHAT_WRITE_FORBIDDEN → `banned_channels`») продублирован ещё в
  нескольких незаархивированных change'ах (`monitor-v5` →
  `specs/group-monitoring-v5/spec.md`, `telegram-error-handling` →
  `specs/group-monitoring/spec.md` и `specs/leave-banned-channels/spec.md`,
  `post-comment-review`). Эта спека приводит в соответствие только
  `leave-banned-channels` и базовую `group-monitoring`; согласование
  остальных копий — отдельная задача архивации, вне скоупа.
