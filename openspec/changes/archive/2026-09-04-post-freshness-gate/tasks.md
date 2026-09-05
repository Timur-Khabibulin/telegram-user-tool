## 1. TelegramService — новые поля и метод

- [x] 1.1 Добавить в `TgMessage` (`src/core/telegram/service.ts`) поля `replyToTopId?: number` (из `m.replyTo?.replyToTopId`) и `isChannelPost?: boolean` (из наличия `m.fwdFrom?.channelPost`)
- [x] 1.2 Добавить в `getMessages` опциональный параметр `opts?: { includeChannelPosts?: boolean }` (default `false`); при `true` не применять фильтр `sender instanceof Api.Channel` — вызов без параметра (v1, `monitor.ts`) не меняет поведения
- [x] 1.3 Добавить метод `getMessageById(chatId: string, msgId: number): Promise<{ date: number } | null>`

## 2. Слой данных

- [x] 2.1 Добавить таблицу `thread_post_dates` (`chatId`, `topMsgId`, `postDate`, `firstSeenAt`, PK `(chatId, topMsgId)`) в `src/core/db/replies.ts`
- [x] 2.2 Добавить функции `getThreadPostDate(agentId, chatId, topMsgId)`, `saveThreadPostDate(agentId, chatId, topMsgId, postDate, log)`, `expireOldThreadPostDates(agentId, olderThanSeconds, log)` в `src/core/db/replies.ts`
- [x] 2.3 Добавить опциональные поля `replyToTopId?: number`, `isChannelPost?: boolean` в `ClassifyInputMessage` (`src/core/db/channels.ts`)
- [x] 2.4 Добавить значение `"monitor_v2"` в `SendErrorSource` (`src/core/db/channels.ts`)
- [x] 2.5 Добавить значение `"monitor-v2"` в `TaskType` (`src/core/db/tasks.ts`)

## 3. Конфигурация

- [x] 3.1 Добавить в `src/core/config.ts`: `MONITOR_V2_CHECK_PERIOD_SECONDS = 86400`, `POST_FRESHNESS_FIRST_COMMENT_MAX_AGE_SECONDS = 24*3600`, `POST_FRESHNESS_CONTINUATION_MAX_AGE_SECONDS = 4*86400`, `THREAD_POST_DATE_TTL_SECONDS = 30*86400`

## 4. Гейт свежести

- [x] 4.1 Создать `src/core/freshness-gate.ts`: типы `FreshnessGateDeps`, `GateOutcome`, `FreshnessGateMessage`
- [x] 4.2 Реализовать `evaluateFreshness`: случай B (`isChannelPost` → дата из `msg.date`, без кеша), случай A (`replyToTopId` → кеш или один запрос через `fetchAndCachePostDate`), исход `no_thread` при отсутствии обоих признаков, `date_unresolved` при неудаче определения даты
- [x] 4.3 В `evaluateFreshness` применить порог и знак сравнения по `isContinuation`: `< POST_FRESHNESS_FIRST_COMMENT_MAX_AGE_SECONDS` (R1) или `<= POST_FRESHNESS_CONTINUATION_MAX_AGE_SECONDS` (R2), иначе исход `stale`

## 5. Скилл monitor-v2

- [x] 5.1 Создать `src/skills/monitor-v2.ts`, скопировав конвейер `src/skills/monitor.ts` (загрузка аккаунта, синхронизация каналов, кэш идентичности, батч, обработка канала, DM-кандидаты, статус-отчёт)
- [x] 5.2 Вызывать `getChannelsBatch` с `MONITOR_V2_CHECK_PERIOD_SECONDS` вместо `CHANNEL_CHECK_PERIOD_SECONDS`
- [x] 5.3 Вызывать `expireOldThreadPostDates` в начале прогона (по аналогии с `expireGroupThreads` в `monitor.ts`)
- [x] 5.4 Вызывать `getMessages(..., { includeChannelPosts: true })` вместо вызова без опций
- [x] 5.5 После `classifyMessages` последовательно (`for...of`, без `Promise.all`) применить `evaluateFreshness` к сообщениям всех трёх бакетов (`generalMessages` как `isContinuation=false`; сообщения `newThreadMessages[].messages` и `threadReplies[].newMessages` как `isContinuation=true`), исключая непрошедшие сообщения из бакета/записи; запись, лишившуюся всех сообщений, исключить целиком
- [x] 5.6 Подключить `getThreadPostDate`/`saveThreadPostDate`/`getMessageById` как реализацию `FreshnessGateDeps` при вызове `evaluateFreshness` из скилла
- [x] 5.7 Считать метрики гейта (число исключённых по `no_thread`/`date_unresolved`/`stale`) и включить их в возвращаемый статус-отчёт скилла

## 6. Регистрация и документация

- [x] 6.1 Зарегистрировать `"monitor-v2": runMonitorV2` в `SKILLS` (`src/scripts/dispatcher.ts`)
- [x] 6.2 Добавить строку `monitor-v2` в таблицу типов задач в `skills/scheduler-control/SKILL.md`
- [x] 6.3 Добавить `monitor-v2` в таблицу скиллов и реестра `docs/architecture.md`
