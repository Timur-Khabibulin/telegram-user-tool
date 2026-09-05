## Why

`docs/telegram-errors.md` каталогизирует 35 ошибок MTProto/GramJS и целевое
поведение системы на них, но большая часть этого поведения ещё не
реализована: сессионные/аккаунтные ошибки (бан, заморозка, отзыв сессии,
`PEER_FLOOD`) сегодня либо не ловятся вне `connect()`, либо ловятся, но не
приводят ни к какой платформенной реакции; забаненные и format-error каналы
не различаются статусом; join-очередь не различает временные и постоянные
отказы так, как требует дока. Без этого агент продолжает тратить флуд-бюджет
и токены на каналы/операции, которые заведомо не дадут результата, а
человеку приходится обнаруживать деградацию аккаунта вручную по логам.

## What Changes

- Новая таблица `agent_restrictions` (одна БД на всю платформу, в workspace
  админ-агента) — активное ограничение агента (`banned` /
  `need_update_session` / `suspend`), с TTL для `suspend`. Диспетчер проверяет
  её перед запуском задач агента.
- Новый append-only лог ошибок аккаунта (`error_log`, per-agent, в
  `tasks.db`) — фиксирует срабатывания ошибок №1-6, №8, №11, №12, №21, №29 и
  правила «2 канала banned за 2 дня».
- Ошибки аккаунтного уровня (деактивация, бан, заморозка, `PEER_FLOOD`)
  начинают ловиться в любом месте вызова Telegram API, не только при
  `connect()` — заменяют текущий `disableAllTasks`/`enabled=0` как механизм
  остановки задач агента на запись в `agent_restrictions`.
- `channels.status` (`banned` | `format_error`) + время обновления:
  `monitor-v2` ставит статус сразу при получении соответствующей ошибки при
  отправке ответа; `banned` дополнительно проверяется перед обработкой канала
  (пропуск), `format_error` — нет (канал продолжает обрабатываться).
- `USER_BANNED_IN_CHANNEL` различается по контексту: при вступлении — не
  меняет поведение; при отправке — как `CHAT_WRITE_FORBIDDEN`.
- Правило «2 забаненных канала за 2 дня» → `agent_restrictions(suspend, 3
  дня)`.
- `join_queue.status`: `error` перестаёт быть автоматически ретраящимся
  (сейчас — до `MAX_ATTEMPTS`), `skipped` перестаёт быть постоянным —
  переводится обратно в `pending` перед каждым следующим батчем.
  `CHANNELS_TOO_MUCH` получает отдельную ветку (`skipped` + запись в
  `error_log`, без записи в `agent_restrictions`), отдельно от
  `USERS_TOO_MUCH` (`error`).
- Политика повтора `FLOOD_WAIT`/`SLOWMODE_WAIT_N`: до 2 повторов подряд
  (порог 2 минуты перепроверяется на каждом шаге), единая для подключения,
  вступления и отправки — расширяет текущую политику в одну попытку.
- `leave-banned-channels`: `purgeChannelData` сужается — удаляет только
  `dm_candidates`; `channels`, `channel_visits`, `replies`, `group_threads`,
  `group_thread_agent_msgs` сохраняются (**BREAKING** по отношению к текущему
  поведению полной очистки).
- `dm-send`: `USER_DEACTIVATED`/`USER_DEACTIVATED_BAN` и `PEER_FLOOD`
  дополнительно к текущей пометке кандидата вызывают запись в
  `agent_restrictions` (новый побочный эффект, наблюдаемый статус кандидата
  не меняется).

## Capabilities

### New Capabilities

- `agent-restrictions`: платформенная таблица ограничений агента —
  жизненный цикл (`banned` / `need_update_session` / `suspend`), проверка
  диспетчером перед запуском задач, все триггеры создания/снятия.
- `account-error-log`: per-agent append-only лог срабатываний ошибок
  аккаунта — схема, точки записи.
- `join-queue`: статусная модель очереди вступления (`pending` /
  `processing` / `joined` / `skipped` / `error`) и обработка ошибок
  Telegram при попытке вступления — capability раньше не была формализована
  отдельным спеком.

### Modified Capabilities

- `telegram-connection-errors`: аккаунтные ошибки (`USER_DEACTIVATED`,
  `USER_DEACTIVATED_BAN`, `FROZEN_PARTICIPANT_MISSING`,
  `FROZEN_METHOD_INVALID`, `API_ID_INVALID`) классифицируются не только на
  `connect()`, но в любом MTProto-вызове; реакция на все аккаунтные ошибки
  (включая уже существующие `SessionRevokedError`/`MissingAccountConfigError`)
  меняется с `disableAllTasks` на запись в `agent_restrictions`.
- `task-scheduler`: диспетчер SHALL проверять `agent_restrictions` перед
  подключением к Telegram; при активном ограничении — не запускать задачи
  агента (холостой выход, аналогично пустому расписанию).
- `group-monitoring`: `channels.status` (постановка и проверка), различение
  `USER_BANNED_IN_CHANNEL` по контексту, `PEER_FLOOD` при отправке ответа,
  политика повтора флуда до 2 раз.
- `dm-send`: `USER_DEACTIVATED`/`USER_DEACTIVATED_BAN` и `PEER_FLOOD`
  дополнительно пишут в `agent_restrictions`.
- `leave-banned-channels`: сужение `purgeChannelData` — не удаляет
  `channels`/`channel_visits`/`replies`/`group_threads`/
  `group_thread_agent_msgs`, только `dm_candidates`.

## Impact

- Код: `src/core/telegram/errors.ts` (классификация всех 35 ошибок),
  `src/core/telegram/service.ts` (единая точка перехвата MTProto-вызовов,
  расширение флуд-ретрая до 2 попыток), `src/scripts/dispatcher.ts` (gate по
  `agent_restrictions`, замена `disableAllTasks` на запись ограничения),
  `src/core/db/agent-restrictions.ts` (новый), `src/core/db/tasks.ts`
  (`error_log`), `src/core/db/channels.ts` (`channels.status`, сужение
  `purgeChannelData`), `src/core/db/join-queue.ts` (статусная модель),
  `src/skills/monitor-v2.ts`, `src/skills/dm-send.ts`,
  `src/skills/join-queue.ts`, `src/skills/leave-banned-channels.ts`,
  `src/core/config.ts` (`agentRestrictionsDbPath`).
- Данные: новая платформенная БД `agent-restrictions.db` в workspace
  админ-агента; новая таблица `error_log` в `tasks.db` каждого агента; новые
  колонки `channels.status`/`channels.statusUpdatedAt` в `tg-channels.db`
  (аддитивно). Поведение `purgeChannelData` меняется без миграции данных
  (сохраняет больше, чем раньше — обратной несовместимости в схеме нет).
- Зависимости: расширяет незавершённый `leave-banned-channels`
  (19/23 задачи) и не заархивированный `deterministic-connection-errors`
  (код задеплоен, спеки ещё не перенесены в `openspec/specs/` — трактуются
  здесь как текущее поведение).
- Необратимость: выход из канала (`leaveChannel`) остаётся необратимым
  действием — не меняется этим change. Снятие `banned`/`need_update_session`
  в `agent_restrictions` — только вручную человеком.
