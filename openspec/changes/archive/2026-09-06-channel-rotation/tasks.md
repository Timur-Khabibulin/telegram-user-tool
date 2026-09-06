## 1. Примитивы в `core/db/channels.ts`

- [x] 1.1 Добавить `getRotationCandidates(agentId, log)` — выборка `chatId`,
      `channelUsername`, `statusUpdatedAt` из `channels` со
      `status='leaved_from_banned' AND channelUsername IS NOT NULL`,
      сортировка по `statusUpdatedAt ASC`.
- [x] 1.2 Добавить `countSkippedNoUsername(agentId)` (или расширить выборку
      1.1 счётчиком) — количество каналов `leaved_from_banned` без
      `channelUsername`, для сводки прогона.
- [x] 1.3 Добавить `countActiveChannels(agentId)` — `COUNT(*)` по `channels`
      с тем же фильтром статусов, что использует `getChannelsBatch`
      (`status IS NULL OR status NOT IN ('banned','suspend',
      'leaved_from_banned','leaved_manual','should_leave')`).
- [x] 1.4 Добавить `deleteChannelRow(agentId, chatId, log)` — `DELETE FROM
      channels WHERE chatId=?` на конкретном агенте.

## 2. Логика распределения (новый модуль)

- [x] 2.1 Создать `src/features/channel-rotation/` (или аналогичное
      расположение среди `features/`) с функцией `planRotation(candidates,
      activeAgents, loadByAgent)`, реализующей алгоритм из design.md:
      сортировка активных агентов по возрастанию нагрузки один раз, round-robin
      по кругу с пропуском агента-источника для его собственного кандидата,
      случайный тай-брейк при равной нагрузке.
- [x] 2.2 Функция должна быть чистой (принимает готовые списки/карты, не
      обращается к БД напрямую) — чтобы алгоритм распределения был
      тестируемым независимо от I/O.
- [x] 2.3 Реализовать сборку списка активных агентов-целей: `listAgentIds()`,
      отфильтрованный по `!getActiveRestriction(adminAgentId, agentId) &&
      isAgentActive(agentId)`.

## 3. Оркестрация переноса

- [x] 3.1 Для каждого назначенного кандидата: вычислить `link =
      normalizeChannelLink(channelUsername)`.
- [x] 3.2 Вызвать `forceAssignChannel(adminAgentId, link, targetAgent)`.
- [x] 3.3 Вызвать `addJoinQueue(targetAgent, [link], log)`.
- [x] 3.4 Вызвать `deleteChannelRow(sourceAgentId, chatId, log)` только после
      успешного выполнения 3.2 и 3.3 (не терять канал при частичном сбое).
- [x] 3.5 Собрать сводку прогона: число перенесённых каналов, число
      `skipped_no_username`, разбивка перенесённых каналов по целевым
      агентам.

## 4. Точка входа скрипта

- [x] 4.1 Создать `src/scripts/periodic/channel-rotation.ts` по образцу
      `daily-summary.ts`/`funnel-tracker.ts`: `main()`, сбор кандидатов по
      всем агентам, вызов планировщика (раздел 2), оркестрация переноса
      (раздел 3), вывод сводки в лог.
- [x] 4.2 Обработать случай отсутствия активных агентов-целей вообще —
      прогон логирует это и завершается без ошибок (кандидаты остаются
      нетронутыми до следующего прогона).

## 5. Деплой (systemd)

- [x] 5.1 Добавить unit-файлы `tg-channel-rotation.service` /
      `tg-channel-rotation.timer` (по образцу существующих periodic-таймеров),
      время запуска — с отступом ≥12 часов от цикла `leave-banned-channels`.

## 6. Документация

- [x] 6.1 Обновить `docs/architecture.md` (таблица модулей `core/db/`, раздел
      про periodic-скрипты) — добавить `channel-rotation`.
- [x] 6.2 Обновить `docs/task-scheduling.md`, если в нём перечислены
      periodic-задачи и их дефолтное расписание.
- [x] 6.3 Обновить `docs/operation.md` — добавить новый systemd timer/service
      в описание эксплуатации.
