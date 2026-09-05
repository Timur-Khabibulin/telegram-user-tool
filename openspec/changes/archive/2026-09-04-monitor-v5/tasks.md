## 1. Схема данных

- [x] 1.1 `core/db/channels.ts`: `SendErrorSource` += `"monitor_v5"`.
- [x] 1.2 ~~`channel_context` в `getChannelsBatch`/`ChannelRow`~~ — не
      понадобилось: ветка `generatePostCommentV5` для общих сообщений
      отклонена (design.md, Context), решение по общим сообщениям осталось
      на `analyzeChannelMessages`, которому описание канала не нужно; поле
      было добавлено и затем откачено.

## 2. Конфигурация

- [x] 2.1 `core/config.ts`: `MONITOR_V5_CHECK_PERIOD_SECONDS` — новая
      константа, равная по значению `CHANNEL_CHECK_PERIOD_SECONDS` (72ч),
      физически отдельная (design.md, Decision 5).
- [x] 2.2 `core/db/tasks.ts`: `TaskType` += `"monitor-v5"`;
      `DEFAULT_PERIODIC_SCHEDULE["monitor-v5"]` = `{ periodMinutes: 180, tz:
      "Asia/Yekaterinburg" }` (тот же каданс, что у `"monitor"`).
- [x] 2.3 `core/db/tasks.ts`: `isAgentActive` — добавить `"monitor-v5"` в
      список типов, считающихся активностью агента (funnel-tracking).

## 3. Скилл monitor-v5

- [x] 3.1 Создать `src/skills/monitor-v5.ts` (`runMonitorV5`) — копия §1-§4.5
      `monitor.ts` (загрузка аккаунта, синхронизация каналов, кэш
      идентичности, `getChannelsBatch(MONITOR_V5_CHECK_PERIOD_SECONDS)`,
      `expireGroupThreads`) без изменений по существу.
- [x] 3.2 §5.1-5.3 (получение непрочитанных, обработка `dialog_status_unknown`/
      `get_messages_error`, `markAsRead`, `classifyMessages`) — без изменений
      от `monitor.ts`.
- [x] 3.3 §5.4 (`newThreadMessages` → `generateThreadReply`) и §5.5
      (`threadReplies` → `generateThreadContinuation`) — без изменений от
      `monitor.ts`, кроме обёртки отправки (3.5).
- [x] 3.4 §5.6 общие сообщения — **без изменений от `monitor.ts`** (после
      пересмотра, design.md Context): `passesPrefilter` → один вызов
      `analyzeChannelMessages` на весь отфильтрованный список → при
      `ответитьНа` — `generateReply` → отправка. Ранняя версия через
      поштучный вызов `generatePostCommentV5` на каждое сообщение
      реализована и затем отклонена — теряла видимость модели всего батча
      сразу, которую даёт `analyzeChannelMessages`.
- [x] 3.5 Обёртка отправки (`sendReply`) — заменена инлайн-обработка v1 на
      `handlePostCommentSendError`/`PeerFloodError`/`ChannelSkipError`
      (design.md Decision 1, `core/post-comment-send.ts`, `source:
      "monitor_v5"`) во всех трёх путях отправки (3.3 оба, 3.4).
- [x] 3.6 §5.7-5.8 (сохранение прогресса, запись DM-кандидатов, порог
      `DM_SCORE_THRESHOLD`) — без изменений от `monitor.ts`.
- [x] 3.7 Итоговый статус-отчёт скилла — по аналогии с `monitor.ts`, те же
      русские ключи, без изменений.

## 4. Регистрация задачи

- [x] 4.1 `scripts/dispatcher.ts`: `SKILLS["monitor-v5"] = runMonitorV5`;
      расширено условие LLM-логирования (`withLlmLogging`) на
      `"monitor-v5"`. Заодно поправлен обнаруженный попутно баг — вызов
      `withLlmLogging` не хватало 4-го аргумента (`log`), из-за чего
      логирование LLM для `monitor-v3`/`monitor-v4`/`channel-context` не
      компилировалось бы вовсе.
- [x] 4.2 `index.ts`: `taskTypeParam` (OpenClaw-тул `tg_scheduler_*`) +=
      `"monitor-v5"` — тот же пробел, что уже находили и чинили для
      `monitor-v3`/`monitor-v4`, не повторён для v5.

## 5. Документация

- [x] 5.1 `skills/scheduler-control/SKILL.md` — строка `monitor-v5` в
      таблице типов задач.
- [x] 5.2 `docs/task-scheduling.md` — строка каданса `monitor-v5` (180 мин,
      Asia/Yekaterinburg, как у `monitor`).
- [x] 5.3 `docs/architecture.md` — упомянуть `monitor-v5` в списке скиллов.

## 6. Проверка

- [x] 6.1 `npx tsc --noEmit` — типы проходят без ошибок в новых/изменённых
      файлах (только предсуществующие несвязанные ошибки конфигурации).
