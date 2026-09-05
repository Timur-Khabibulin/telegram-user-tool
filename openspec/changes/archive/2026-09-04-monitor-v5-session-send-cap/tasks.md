## 1. Конфигурация

- [x] 1.1 Добавить константу `V5_SESSION_SEND_CAP = 3` в `src/core/config.ts`
      рядом с остальными `V5_*` (`V5_BATCH_LIMIT` и соседи).

## 2. Счётчик каналов с отправкой

- [x] 2.1 В `runMonitorV5` (`src/skills/monitor-v5.ts`) завести
      `const sentChannels = new Set<string>()` перед волновым циклом (рядом
      с `processedThisRun`).
- [x] 2.2 После успешного `sendReply` в блоке `newThreadMessages`
      (`monitor-v5.ts:502`) добавлять `chatId` в `sentChannels`.
- [x] 2.3 После успешного `sendReply` в блоке `threadReplies`
      (`monitor-v5.ts:534`) добавлять `chatId` в `sentChannels`.
- [x] 2.4 После успешного `sendReply` в блоке `generalMessages`
      (`monitor-v5.ts:576`) добавлять `chatId` в `sentChannels`.
- [x] 2.5 Убедиться, что ветки `suppressRefusal` (continue до `sendReply`) и
      `ChannelSkipError` (перехватывается в catch, `monitor-v5.ts:606-611`)
      НЕ добавляют `chatId` в `sentChannels` — по текущему месту вставки (2.2-2.4)
      это уже так, отдельного кода не требуется, только проверить в 4.1.

## 3. Остановка прогона

- [x] 3.1 После `markChannelProcessed`/`channelsProcessed += 1` в конце
      per-channel цикла (`monitor-v5.ts:617-618`) добавить проверку: если
      `sentChannels.size >= V5_SESSION_SEND_CAP`, вернуть
      `{ status: "success", details: { reason: "session_send_cap",
      sentChannels: sentChannels.size, channelsProcessed, candidatesAdded } }`
      (согласовать точную форму `details` с уже существующим финальным
      `return` функции — не дублировать поля).
- [x] 3.2 Убедиться, что `return` происходит именно после завершения текущего
      канала целиком (после всех его тредов/general-ответа), не посреди
      обработки одного канала.

## 4. Деплой

- [x] 4.1 Задеплоить `core/config.ts` и `skills/monitor-v5.ts` на VPS (`scp`
      + `chown root:root`, тот же путь, что и предыдущие правки
      `monitor-v5.ts` в этой сессии).
