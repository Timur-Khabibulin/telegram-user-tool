## 1. Классификатор ошибок

- [x] 1.1 В `core/telegram/errors.ts` добавить классы `AccountBannedError` (USER_DEACTIVATED, USER_DEACTIVATED_BAN, FROZEN_PARTICIPANT_MISSING, FROZEN_METHOD_INVALID) — наследник общего абстрактного маркера, сообщение = сырой код+текст
- [x] 1.2 Расширить условие броска `SessionRevokedError` в `ensureClient` на `API_ID_INVALID` (код 400) — сегодня только код 401
- [x] 1.3 Добавить в `errors.ts` функцию классификации операционных ошибок join/send/dm по `errorMessage` (`USERNAME_NOT_OCCUPIED`, `CHANNEL_PRIVATE`, `USER_BANNED_IN_CHANNEL`, `CHAT_WRITE_FORBIDDEN`, `CHAT_SEND_PLAIN_FORBIDDEN`, `CHAT_SEND_MEDIA_FORBIDDEN`, `ALLOW_PAYMENT_REQUIRED`, `CHANNELS_TOO_MUCH`, `USERS_TOO_MUCH`, и т.д.) — возвращает строку-тег, не бросает
- [x] 1.4 Различить `FROZEN_METHOD_INVALID` от `FLOOD_WAIT_N`/`SLOWMODE_WAIT_N` по `errorMessage` при коде 420 (оба кода общие)
## 2. Единая точка перехвата в TelegramService

- [x] 2.1 Добавить внутреннюю обёртку вокруг MTProto-вызовов в `TelegramService` (`invokeChecked`), классифицирующую ошибку и бросающую `AccountBannedError`/расширенный `SessionRevokedError` для аккаунтных случаев
- [x] 2.2 Провести через обёртку вызовы, где сегодня ошибки аккаунтного уровня не ловятся вовсе: `markAsRead`, `getMessages`, `getMessageById`, `getRecentPosts` (channel-coverage-update/channel-content-analysis — история чата)
- [x] 2.3 `sendDm`/`joinDiscussionGroups` продолжают возвращать типизированный результат для операционных ошибок — не проходят через `invokeChecked` (не тронуты этой группой)

## 3. Общий ретрай флуда

- [x] 3.1 Реализовать единую функцию ретрая с политикой «до 2 повторов, порог 2 мин перепроверяется на каждом шаге» — **уточнение по месту**: `retryOnFloodWait` размещена в `core/telegram/errors.ts`, не в `service.ts` — там уже живут `parseFloodWait`/`MAX_INLINE_FLOOD_WAIT_SECONDS`, от которых функция зависит; design.md ошибочно называл `service.ts` их домом
- [x] 3.2 Заменить встроенный ретрай в `sendDm` на вызов общей функции
- [x] 3.3 Заменить `callWithFloodHandling` в `joinDiscussionGroups` на вызов общей функции (со своим `floodWaits`-трекингом поверх)
- [x] 3.4 **Уточнение по месту**: вместо удаления `withFloodRetry` из `skills/util.ts` и переключения `monitor.ts`/`monitor-v2.ts` на прямой импорт — `withFloodRetry` оставлена в `skills/util.ts`, но её тело теперь делегирует в `retryOnFloodWait`. Причина: `skills/util.ts` уже был единственной точкой, разделяемой между `monitor.ts` и `monitor-v2.ts` (дублирования между ними не было); удаление функции заставило бы оба файла заново дублировать конвертацию исчерпанного ретрая в `FloodAbortError` — то есть создало бы новое дублирование вместо устранения старого. `monitor.ts`/`monitor-v2.ts` не тронуты этой группой.
- [x] 3.5 Ретрай той же политики для `markAsRead` (`SLOWMODE_WAIT`/`FLOOD_WAIT` при отметке прочитанным) — применимо, добавлено

## 4. `agent_restrictions` (платформенная БД)

- [x] 4.1 Добавить `agentRestrictionsDbPath(adminAgentId)` в `core/config.ts`
- [x] 4.2 Создать `core/db/agent-restrictions.ts` — **уточнение**: отдельной экспортируемой `ensureAgentRestrictionsSchema` нет, схема создаётся неявно при каждом открытии БД (`openDb` → `ensureSchema`), по прецеденту `funnel.ts`
- [x] 4.3 Функция `upsertRestriction(adminAgentId, agentId, type, reason, durationSeconds | null)`
- [x] 4.4 Функция `getActiveRestriction(adminAgentId, agentId)` — для истёкшего `suspend` удаляет строку и возвращает `null`
- [x] 4.5 Функция `clearRestriction(adminAgentId, agentId)` — снятие вручную

## 5. `error_log` (per-agent, в tasks.db)

- [x] 5.1 Схема `error_log` — **уточнение**: отдельный модуль `core/db/error-log.ts` (не внутри `tasks.ts`), переиспользующий `tasksDbPath`, по прецеденту `runs.ts`/`dispatcher-runs.ts` (тоже отдельные модули на общем файле)
- [x] 5.2 Функция `recordAccountError(agentId, skillType, errorMessage)`

## 6. Диспетчер: gate + замена disableAllTasks

- [x] 6.1 В `dispatcher.ts`, сразу после проверки назревших задач — `getActiveRestriction`; при активной записи — холостой выход без подключения к Telegram
- [x] 6.2 В catch-блоке диспетчера заменить `disableAllTasks` на `upsertRestriction(..., 'need_update_session', ...)` при `SessionRevokedError`
- [x] 6.3 Добавлена обработка `AccountBannedError` в том же catch-блоке → `upsertRestriction(..., 'banned', ...)`
- [x] 6.4 При срабатывании 6.2/6.3 — дополнительно `recordAccountError`
- [x] 6.5 `disableAllTasks` удалена из `core/db/tasks.ts` — подтверждено, единственный вызывающий был `dispatcher.ts`

## 7. `channels.status` (group-monitoring)

- [x] 7.1 Колонки `status`, `statusUpdatedAt` в `channels` (аддитивная миграция)
- [x] 7.2 Функция `markChannelStatus(agentId, chatId, status, log)`
- [x] 7.3 Чтение статуса перед обработкой канала — **уточнение**: не отдельная функция, `status` добавлен в SELECT `getChannelsBatch` и в `ChannelRow` (монитор уже получает его в батче, без лишнего запроса на канал)
- [x] 7.4 В `monitor-v2.ts`: `CHAT_WRITE_FORBIDDEN`/`USER_BANNED_IN_CHANNEL` → `markChannelStatus(banned)` + `enqueueBannedChannel`; `CHAT_SEND_PLAIN_FORBIDDEN`/`CHAT_SEND_MEDIA_FORBIDDEN`/`ALLOW_PAYMENT_REQUIRED` → `markChannelStatus(format_error)`, без `enqueueBannedChannel`
- [x] 7.5 В `monitor-v2.ts`: канал пропускается, если `status === 'banned'`; `format_error` не влияет
- [x] 7.6 `PEER_FLOOD` на отправке ответа — прогон останавливается (`PeerFloodError`), `upsertRestriction(suspend, 86400)`, `recordAccountError`, `channels.status` не трогается
- [x] 7.7 Подсчёт «2 канала banned за 2 дня» в той же точке — `countRecentlyBannedChannels`; при ≥2 → `upsertRestriction(suspend, 259200, 'channels_banned')` + `recordAccountError`

## 8. `dm-send`: побочные эффекты deactivated/peer_flood

- [x] 8.1 Ветка `error === 'deactivated'` — `upsertRestriction(..., 'banned', ...)` + `recordAccountError`, помимо пометки кандидата
- [x] 8.2 Ветка `error === 'peer_flood'` — `upsertRestriction(..., 'suspend', 86400, ...)` + `recordAccountError`, помимо остановки прогона

## 9. `join_queue`: статусная модель

- [x] 9.1 Выборка батча: `error` больше не попадает в батч; `skipped` переводится в `pending` перед формированием батча
- [x] 9.2 `CHANNELS_TOO_MUCH` → `status='skipped'` + `error_log`, без `agent_restrictions`; отделено от `USERS_TOO_MUCH` (→ `error`, через `JOIN_ERROR_TAGS`)
- [x] 9.3 `USER_BANNED_IN_CHANNEL` в контексте вступления — на общей ветке `error` (в `JOIN_ERROR_TAGS`, без выделения)
- [x] 9.4 При исчерпании повторов флуда (структурный признак `floodWaits`) — `status='skipped'`, не `error`; заодно `service.ts`'s `joinDiscussionGroups` переведён на общий `classifyTelegramErrorTag` вместо локального списка кодов

## 10. `leave-banned-channels`: сужение purge

- [x] 10.1 `purgeChannelData` — убрано удаление `channels`/`channel_visits`, оставлено только `dm_candidates`
- [x] 10.2 Убран вызов очистки `replies`/`group_threads`/`group_thread_agent_msgs` из `purgeChannelData`; неиспользуемая `purgeChannelThreads` удалена из `core/db/replies.ts`
- [x] 10.3 Комментарии `purgeChannelData` обновлены

## 11. Проверка

- [x] 11.1 `tsc --noEmit` — среда изначально сломана (несовместимые `module`/`moduleResolution` в `tsconfig.json`, отсутствует `@types/better-sqlite3` — подтверждено `git diff HEAD`, не связано с этим change). Проверено с обходом: новых ошибок в изменённых/новых файлах нет, только уже существовавшие (bigint/BigInteger в нетронутых местах `service.ts`, отсутствие типов `better-sqlite3` во всех `core/db/*`, включая давно существующие модули)
- [x] 11.8 `docs/architecture.md` (новые модули `error-log.ts`/`agent-restrictions.ts`) и `docs/db-schema.puml` (новые таблицы/колонки, обновлённые статусные модели `channels`/`join_queue`) обновлены

## 12. Пробел №5/6/11/12 «в любом месте» — обнаружен при сверке с доком после первого прохода (см. design.md, «Дополнение после первичной реализации»)

- [x] 12.1 Расширить `invokeChecked` в `service.ts` на все вызовы, которыми пользуются семь диспетчерских скиллов (проверено по `grep tg\.\w+\( src/skills` — не по памяти): `replyToMessage`, `leaveChannel`, `getDialogs`, `getDialogsForBatch`, `listGroupChannels`, `getDmDialogs`, `resolveChannelUsername`, три MTProto-вызова внутри `joinDiscussionGroups` (`ResolveUsername`/`GetFullChannel`/`JoinChannel`). `channel-cleanup.ts` не диспетчерский (не в `dispatcher.ts` `SKILLS`) — не трогается, как и `populatePeerCacheForIds`, используемый только им
- [x] 12.10 Полный аудит (`grep "catch (err" src/skills`, не по памяти) всех catch-блоков во всех семи диспетчерских скиллах — 31 блок проверен построчно; из них требовали правки 14 (перечислены 12.3-12.9), остальные — либо `tg.loadAccount` (синхронное чтение конфига, не сетевая ошибка), либо уже корректно пробрасывают неизвестную ошибку дальше (`getDialogsForBatch`'ы catch в `monitor.ts`/`monitor-v2.ts`, верхнеуровневый catch вокруг блока LLM/reply в обоих файлах — оба уже кончаются `throw err`), либо `channel-cleanup.ts` (не диспетчерский, не в `dispatcher.ts` `SKILLS`)
- [x] 12.11 При аудите (12.10) найдена ещё одна протечка вне `src/skills/*.ts`: `core/channel-sync.ts` (`cacheChannelIdentities`, используется `monitor.ts`+`monitor-v2.ts`) сама вызывает `tg.listDialogChannels`/`tg.resolveChannelIdentityForDialog` (были не обёрнуты) и глушит любую ошибку кроме `FloodWaitError`; внешний catch вокруг `cacheChannelIdentities` в обоих `monitor*.ts` тоже глушил всё. Все три места исправлены (обёрнуты `listDialogChannels`/`resolveLinkedBroadcast` в `invokeChecked`, добавлена проверка `instanceof ClientNotConnectedError` в `channel-sync.ts` и в обоих `monitor*.ts`)
- [x] 12.12 Проверить чтением кода трассировку каждого пути 12.3-12.9/12.11 до `dispatcher.ts`'s catch-блока — включая случай, когда скилл `return`-ил `{status:"error"}` вместо `throw` (`account-warmup.ts`, реплай-катч) — исправлено на `throw`, иначе `instanceof`-проверка была бы бессмысленной
