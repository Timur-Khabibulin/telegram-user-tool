## 1. Подготовка (проверить перед кодированием)

- [x] 1.1 Подтвердить по документации GramJS поведение `getMessages` без общего курсора между независимыми батчами (design.md Decision 4 / Open Questions) — не возвращает ли повторный вызов один и тот же срез сообщений; при необходимости ввести минимальный курсор (`minId` = `id` последнего сообщения предыдущего батча). Решено: подтверждено по исходникам GramJS, используется `reverse: true` + растущий курсор (design.md Decision 4 обновлён).
- [x] 1.2 Проверить фактическое состояние `banned_channels` на проде (есть ли накопленные необработанные строки на момент деплоя) — определить, нужен ли разовый проход синхронизации в `channels.status` перед удалением таблицы (design.md Migration Plan п.2). Решено без прямой проверки прод-таблицы: оба писателя (`monitor-v2.ts`, `post-comment-send.ts`) всегда ставили `status='banned'` синхронно с `enqueueBannedChannel` — расхождений в коде никогда не было, значит все ожидающие каналы уже отражены в `channels.status`. Синхронизация не требуется.

## 2. Модель данных (`src/core/db/channels.ts`)

- [x] 2.1 Добавить `"should_leave"` в тип `ChannelStatus`.
- [x] 2.2 Добавить функцию выборки очереди на выход: `SELECT chatId FROM channels WHERE status IN ('banned', 'should_leave') ORDER BY statusUpdatedAt ASC LIMIT ?`. (`getLeaveQueue`)
- [x] 2.3 Добавить функцию сброса статуса канала после успешной обработки (`status`/`statusUpdatedAt`/`statusDurationSeconds`/`status_description` → `NULL`), симметрично `expireChannelStatuses`. (`resetChannelStatus`)
- [x] 2.4 Удалить `banned_channels`: `ensureBannedChannelsTable`, `enqueueBannedChannel`, `getBannedChannels`, `deleteBannedChannel`, `CREATE TABLE banned_channels` из `initChannels`. (таблица никогда не создавалась в `initChannels` — только лениво через `ensureBannedChannelsTable` в самих функциях, все убраны)

## 3. Константы пацинга (`src/core/config.ts`)

- [x] 3.1 Добавить константы по конвенции `LEAVE_BANNED_*` (design.md Decision 6): `LEAVE_BANNED_BATCH_LIMIT`, `LEAVE_BANNED_RESOLVE_DELAY_MIN/MAX_SEC`, `LEAVE_BANNED_CHANNEL_DELAY_MIN/MAX_SEC`, `LEAVE_BANNED_READ_GATE_PROBABILITY`, `LEAVE_BANNED_READ_BATCHES_MIN/MAX`, `LEAVE_BANNED_MSG_BATCH_MIN/MAX`, `LEAVE_BANNED_MSG_BATCH_DELAY_MIN/MAX_SEC`.

## 4. Скилл (`src/skills/leave-banned-channels.ts`)

- [x] 4.1 Заменить источник очереди: `getBannedChannels` → новая функция выборки по `channels.status` (лимит `LEAVE_BANNED_BATCH_LIMIT`).
- [x] 4.2 Добавить паузу `random(LEAVE_BANNED_RESOLVE_DELAY_MIN_SEC, LEAVE_BANNED_RESOLVE_DELAY_MAX_SEC)` между `resolveChannelUsername` и `leaveChannel`.
- [x] 4.3 Добавить опциональное чтение батчей сообщений между `resolveChannelUsername` и паузой перед `leaveChannel`: случайный гейт (`LEAVE_BANNED_READ_GATE_PROBABILITY`), при срабатывании — `random(LEAVE_BANNED_READ_BATCHES_MIN, LEAVE_BANNED_READ_BATCHES_MAX)` батчей `getMessages(random(LEAVE_BANNED_MSG_BATCH_MIN, LEAVE_BANNED_MSG_BATCH_MAX))` + `markAsRead` на каждый батч + пауза `random(LEAVE_BANNED_MSG_BATCH_DELAY_MIN_SEC, LEAVE_BANNED_MSG_BATCH_DELAY_MAX_SEC)` между батчами (не после последнего).
- [x] 4.4 Заменить `deleteBannedChannel` на сброс статуса канала (задача 2.3) после успешного `purgeChannelData`.
- [x] 4.5 Добавить паузу `random(LEAVE_BANNED_CHANNEL_DELAY_MIN_SEC, LEAVE_BANNED_CHANNEL_DELAY_MAX_SEC)` между обработкой каналов очереди (не после последнего).
- [x] 4.6 Убедиться, что при ошибке `leaveChannel` статус канала не изменяется (данные/реестр/статус не трогаются, как и раньше для строки `banned_channels`).

## 5. Источники записи статуса (убрать дубль очереди)

- [x] 5.1 `src/skills/monitor-v2.ts`: убрать вызов `enqueueBannedChannel` при `CHAT_WRITE_FORBIDDEN`/`USER_BANNED_IN_CHANNEL`, оставить `markChannelStatus(..., "banned", ...)`.
- [x] 5.2 `src/core/post-comment-send.ts`: убрать вызов `enqueueBannedChannel` в `handlePostCommentSendError`, оставить `markChannelStatus(..., "banned", ...)`. Актуальный путь для активных `monitor-v4`/`monitor-v5` (оба идут через `handlePostCommentSendError`).
- [x] 5.3 `src/skills/monitor.ts` (v1, неактивен): убрать вызов `enqueueBannedChannel` (единственное использование в файле, `markChannelStatus` там не вызывается и не добавляется — v1 не используется ни одним агентом, обнаружено и решено пользователем во время apply).

## 6. Расписание (`src/core/db/tasks.ts`)

- [x] 6.1 Перенести `"leave-banned"` из `DEFAULT_CALENDAR_SCHEDULE` в `DEFAULT_PERIODIC_SCHEDULE`, `periodMinutes: 180`.
- [x] 6.2 Убедиться, что `"leave-banned"` остаётся в `QUIET_HOURS_EXEMPT_TASKS` (без изменений) — проверено, `QUIET_HOURS_EXEMPT_TASKS = ["leave-banned"]` не менялся.

## 7. Миграция существующих агентов

- [x] 7.1 По итогам задачи 1.2 — перенос не потребовался (см. 1.2).
- [x] 7.2 Обнаружено на проде (142 агента): у 118 агентов строки `leave-banned` не было вообще (никогда не запускалась); у 24 (`agent1`, `agent4`–`agent26`) — была, но `enabled=0` и на старом дефолте `0 5 * * *`. По решению пользователя (только 37 агентов, которым проставлен `should_leave`) создан и выполнен разовый скрипт `src/scripts/activate-leave-banned-for-agents.ts` (`createOrUpdateTask`, round-robin фаза, при необходимости — `systemctl enable --now`) — все 37 подтверждены: `enabled=1`, периодическое расписание 180 мин. Остальные 105 агентов (включая 24 с выключенной старой задачей) намеренно не тронуты — отдельное решение.

## 8. Документация

- [x] 8.1 Обновить `docs/task-scheduling.md`: перенести `leave-banned` из таблицы «Календарные задачи» в «Периодические задачи» (180 мин).
- [x] 8.2 Обновить/дополнить `docs/design/leave-banned-channels/leave-banned-channels-v1.md` описанием нового источника очереди, лимита батча и пацинга (или завести `-v2`). Заведён `leave-banned-channels-v2.md` (по конвенции версионирования docs/design, v1 не трогали).

