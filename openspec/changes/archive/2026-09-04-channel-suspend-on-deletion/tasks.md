## 1. Конфигурация

- [x] 1.1 Добавить в `src/core/config.ts` константы `MESSAGE_DELETION_CHECK_WINDOW_SECONDS` (14 * 86400), `MESSAGE_DELETION_THRESHOLD` (2), `CHANNEL_SUSPEND_DURATION_SECONDS` (259200)

## 2. Схема `channels` (`src/core/db/channels.ts`)

- [x] 2.1 Добавить `"suspend"` в тип `ChannelStatus`
- [x] 2.2 Добавить аддитивную миграцию колонок `statusDurationSeconds INTEGER` (nullable) и `status_description TEXT` (nullable), по образцу `migrateStatusColumns`
- [x] 2.3 Расширить `markChannelStatus(agentId, chatId, status, log, durationSeconds?, description?)` — записывает новые поля; существующие вызовы (без новых аргументов) сохраняют бессрочное поведение (`NULL`)
- [x] 2.4 Добавить `expireChannelStatuses(agentId, log)` — сбрасывает `status`/`statusDurationSeconds`/`statusUpdatedAt`/`status_description` в `NULL` там, где `statusDurationSeconds IS NOT NULL AND now >= statusUpdatedAt + statusDurationSeconds`
- [x] 2.5 Добавить в `getChannelsBatch` условие `AND status NOT IN ('banned', 'suspend')`
- [x] 2.6 Добавить `countChannelsSuspendedInWindow(agentId, startSec, endSec)` по образцу `countChannelsBannedInWindow`

## 3. Схема `group_thread_agent_msgs` (`src/core/db/replies.ts`)

- [x] 3.1 Добавить аддитивную колонку `sentAt INTEGER` в `group_thread_agent_msgs`
- [x] 3.2 Заполнять `sentAt` в `createThread` (используя уже вычисленный `now`)
- [x] 3.3 Заполнять `sentAt` в `updateThread` (используя уже вычисленный `now`)
- [x] 3.4 Добавить `getAgentSentMessageIds(agentId, chatId, sinceSec): number[]` — объединение `replies.replyMsgId` и `group_thread_agent_msgs.agentMsgId` по `chatId` и `sentAt >= sinceSec`

## 4. Проверка удаления в Telegram (`src/core/telegram/service.ts`)

- [x] 4.1 Добавить `getMessagesExistence(chatId, msgIds): Promise<Set<number>>` поверх `client.getMessages(peer, { ids })`, с чанкованием по 100 id за вызов

## 5. Шаг в `monitor-v2` (`src/skills/monitor-v2.ts`)

- [x] 5.1 Вызвать `expireChannelStatuses(agentId, log)` в начале прогона (рядом с `expireGroupThreads`, шаг 4.5)
- [x] 5.2 Расширить шаг 5.0: пропускать канал (`continue`) также при `status === "suspend"`, не только `"banned"`
- [x] 5.3 Добавить шаг проверки удаления после 5.0 и до проверки `unreadCount === 0`: получить `getAgentSentMessageIds(agentId, chatId, now - MESSAGE_DELETION_CHECK_WINDOW_SECONDS)`; если список не пуст — вызвать `getMessagesExistence`, посчитать `deletedCount`
- [x] 5.4 При `deletedCount > MESSAGE_DELETION_THRESHOLD` — вызвать `markChannelStatus(agentId, chatId, "suspend", log, CHANNEL_SUSPEND_DURATION_SECONDS, description)` и `recordSendError(agentId, { chatId, source: "monitor_v2", errorCode: "messages_deleted" }, log)`, затем пропустить остальную обработку канала на этом прогоне

## 6. Отчёт воронки

- [x] 6.1 Добавить поле `channelsSuspendedToday: number` в `AgentFunnelRow` (`src/core/funnel-collect.ts`)
- [x] 6.2 Заполнять поле вызовом `countChannelsSuspendedInWindow(agentId, window.startSec, window.endSec)` рядом с существующим вызовом для `channelsBannedToday`
- [x] 6.3 Добавить столбец в CSV-вывод (`src/core/funnel-report.ts`), рядом со столбцом забаненных каналов

## 7. Проверка

- [x] 7.1 Прогнать типизацию/линт проекта
