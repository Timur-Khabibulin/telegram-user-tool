## 1. Подготовка: подтвердить API GramJS

- [x] 1.1 Проверить по документации GramJS точный API постраничного вызова
      `getDialogs` (параметры курсора — `offsetDate`/`offsetId`/`offsetPeer`,
      признак конца списка) — design.md Decision 2.
- [x] 1.2 Проверить по документации GramJS способ получить сообщения от
      старых к новым начиная с `minId` (параметр `reverse` или эквивалент) —
      design.md Decision 4.

## 2. БД: состояние полной синхронизации

- [x] 2.1 Добавить таблицу `sync_state` (синглтон-строка, `lastFullSyncAt`) в
      `initChannels()` (`src/core/db/channels.ts`), тем же паттерном
      `CREATE TABLE IF NOT EXISTS`, что у существующих таблиц.
- [x] 2.2 Добавить функции чтения/обновления `lastFullSyncAt` в
      `src/core/db/channels.ts` (получить текущее значение; проверить due по
      `V5_FULL_SYNC_PERIOD_SECONDS`; обновить текущим временем).

## 3. Конфигурация

- [x] 3.1 Добавить в `src/core/config.ts`: `V5_FULL_SYNC_PERIOD_SECONDS=86400`,
      `V5_SYNC_PAGE_SIZE=100`, `V5_SYNC_PAGE_DELAY_MIN_SEC=4`,
      `V5_SYNC_PAGE_DELAY_MAX_SEC=7`, `V5_WAVE_MIN=10`, `V5_WAVE_MAX=15`,
      `V5_WAVE_DELAY_MIN_SEC=3`, `V5_WAVE_DELAY_MAX_SEC=10`,
      `V5_MSG_CHUNK_MIN=7`, `V5_MSG_CHUNK_MAX=12`,
      `V5_MSG_MARK_DELAY_MIN_SEC=1`, `V5_MSG_MARK_DELAY_MAX_SEC=7`,
      `V5_MSG_CHUNK_DELAY_MIN_SEC=7`, `V5_MSG_CHUNK_DELAY_MAX_SEC=15`,
      `V5_TYPING_MIN_SEC=60`.
- [x] 3.2 Переопределить `V5_TYPING_MAX_SEC` = 120 (было — потолок расчёта по
      скорости печати; станет — верхняя граница фиксированного диапазона).
- [x] 3.3 Переопределить назначение `V5_GET_MESSAGES_LIMIT` (было — лимит
      одного вызова `getMessages`; станет — суммарный потолок сообщений на
      канал за прогон, защита от аномального backlog) — значение (200)
      не меняется.
- [x] 3.4 Удалить константы: `V5_READ_TAIL_MESSAGES`,
      `V5_READ_CHARS_PER_SEC_MIN`, `V5_READ_CHARS_PER_SEC_MAX`,
      `V5_READ_MIN_SEC`, `V5_READ_MAX_SEC`, `V5_THINK_MIN_SEC`,
      `V5_THINK_MAX_SEC`, `V5_TYPING_CHARS_PER_SEC_MIN`,
      `V5_TYPING_CHARS_PER_SEC_MAX`.

## 4. `core/telegram/service.ts`: постраничный `listGroupChannels`

- [x] 4.1 Переписать `listGroupChannels()` на постраничный обход
      `client.getDialogs({...})` (размер страницы `V5_SYNC_PAGE_SIZE`, курсор
      по итогам п.1.1) вместо одного вызова `getDialogs({})` без лимита.
      Реализовано через `client.iterDialogs({})` (сам пагинирует чанками по
      100 внутри GramJS) с паузой каждые `V5_SYNC_PAGE_SIZE` диалогов — не
      руками через `offsetDate`/`offsetId`/`offsetPeer`, см. комментарий у
      `listGroupChannels`.
- [x] 4.2 Добавить паузу `random(V5_SYNC_PAGE_DELAY_MIN_SEC,
      V5_SYNC_PAGE_DELAY_MAX_SEC)` между страницами.
- [x] 4.3 Убедиться, что `cachePeerForDialog` по-прежнему вызывается для
      каждого диалога каждой страницы (поведение кэша peer не должно
      измениться).

## 5. `src/skills/monitor-v5.ts`: гейт полной синхронизации

- [x] 5.1 Заменить безусловный вызов шагов 3/3b (`listGroupChannels` →
      `syncChannels` → `cacheChannelIdentities`) на условный: выполнять
      только если due по `lastFullSyncAt` (п.2.2); иначе — пропустить и
      перейти сразу к отбору волн.
- [x] 5.2 После успешной полной синхронизации обновить `lastFullSyncAt`
      текущим временем.

## 6. `src/skills/monitor-v5.ts`: волновой отбор каналов

- [x] 6.1 Заменить единичный вызов `getChannelsBatch(limit=V5_BATCH_LIMIT,
      period=...)` на цикл: пока суммарно обработано < `V5_BATCH_LIMIT`,
      вызывать `getChannelsBatch(limit=random(V5_WAVE_MIN, V5_WAVE_MAX),
      period=...)`; прекратить цикл, если волна пустая.
- [x] 6.2 Добавить паузу `random(V5_WAVE_DELAY_MIN_SEC,
      V5_WAVE_DELAY_MAX_SEC)` сразу после каждого вызова `getChannelsBatch`,
      перед обработкой каналов волны.
- [x] 6.3 Убедиться, что `expireGroupThreads` вызывается один раз за прогон
      (не на каждую волну), как и сейчас.

## 7. `src/skills/monitor-v5.ts`: чанкинг чтения сообщений

- [x] 7.1 Заменить одиночный вызов `getMessages(chatId, readInboxMaxId,
      V5_GET_MESSAGES_LIMIT)` + одиночный `markAsRead` на цикл чанков:
      курсор = `readInboxMaxId`, на каждой итерации —
      `getMessages(chatId, cursor, random(V5_MSG_CHUNK_MIN, V5_MSG_CHUNK_MAX))`
      в режиме "от старых к новым" (по итогам п.1.2). Потребовало добавить
      опцию `reverse` в `TelegramService.getMessages()` (core/telegram/service.ts)
      — не было в исходном tasks.md явно, но прямо следовало из design.md
      Decision 4.
- [x] 7.2 После получения чанка — пауза `random(V5_MSG_MARK_DELAY_MIN_SEC,
      V5_MSG_MARK_DELAY_MAX_SEC)`, затем `markAsRead(chatId, maxId чанка)`.
- [x] 7.3 Между чанками — пауза `random(V5_MSG_CHUNK_DELAY_MIN_SEC,
      V5_MSG_CHUNK_DELAY_MAX_SEC)`; прекратить цикл при пустом чанке, при
      достижении `V5_GET_MESSAGES_LIMIT` суммарно на канал, или когда чанк
      короче запрошенного лимита (хвост вычитан).
- [x] 7.4 Собрать все чанки в единый `messages[]` — дальнейшая обработка
      (5.3 классификация и всё последующее) остаётся без изменений.
- [x] 7.5 Удалить `readingSeconds()` и её вызов.

## 8. `src/skills/monitor-v5.ts`: typing

- [x] 8.1 В `sendReply` заменить `sleepRandom(V5_THINK_MIN_SEC,
      V5_THINK_MAX_SEC)` + расчёт `typingSeconds` по скорости печати на
      единый `randomBetween(V5_TYPING_MIN_SEC, V5_TYPING_MAX_SEC)`, без
      зависимости от длины `text`.
- [x] 8.2 Убедиться, что `showTypingFor` вызывается без изменений в своей
      реализации (только с новым значением длительности).

## 9. Проверка

- [x] 9.1 Прогнать типы (`tsc`/`tsx` проверка компиляции проекта). Полный
      `tsc --noEmit` по проекту сейчас не проходит независимо от этого
      change — `tsconfig.json` в рабочем дереве содержит несовместимую пару
      `module: commonjs` + `moduleResolution: bundler` (уже была в рабочем
      дереве до этого change, TS5095) и в кодовой базе есть предсуществующие
      ошибки типов (`better-sqlite3` без деклараций, `bigint`/`EntityLike` в
      других не тронутых местах `service.ts`). Точечная проверка (`tsc
      --noEmit --module esnext`) подтвердила: новый/изменённый код
      (`monitor-v5.ts`, добавления в `config.ts`/`channels.ts`) не вносит
      новых ошибок сверх уже существующих в файле `service.ts` (тот же класс
      ошибки `bigint`/`EntityLike`, воспроизводится и в нетронутых функциях
      вроде `getMessageById`).
- [x] 9.4 Обновить `docs/` при необходимости (если каденс/таймауты monitor-v5
      описаны где-то в `docs/operation.md`/`docs/task-scheduling.md`).
      `docs/operation.md` — уточнена строка про модель батча (50 каналов/3ч
      относится только к `monitor`/`monitor-v2`; `monitor-v5` описан отдельно
      с актуальными `V5_BATCH_LIMIT`/суточным full-sync).
      `docs/task-scheduling.md` — не тронут: описывает внешний каданс
      прогонов диспетчера (там уже задокументирована как минимум одна
      расходящаяся с кодом деталь, `V5_WAKE_GAP`/`randomNextRun` против
      таблицы периодов, — предсуществующее расхождение вне скоупа этого
      change, не про то, что происходит внутри одного прогона).
