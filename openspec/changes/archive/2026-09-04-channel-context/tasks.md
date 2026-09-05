## 1. Расширение Telegram-сервиса

- [x] 1.1 Расширить `getChannelGateInfo()` (`core/telegram/service.ts`): добавить в
  результат `pinnedMsgId: number | null` из `fullChat.pinnedMsgId` того же ответа
  `GetFullChannel` (без дополнительного вызова)
- [x] 1.2 Добавить метод получения текста сообщения по id (по образцу
  `getMessageById`, который сейчас отдаёт только `{ date }`) — вернуть `{ text }`
  или null, если сообщение недоступно/удалено
- [x] 1.3 Проверить, что `getRecentPosts(channel, 100)` пригоден для последующей
  фильтрации по дате в core-модуле (см. задачу 3.3) без изменения сигнатуры

## 2. LLM-анализ канала

- [x] 2.1 Добавить промпт в `src/llm/prompts.ts`: вход — title, about, текст закрепа
  (отдельным блоком, может отсутствовать), посты с их комментариями. Прошёл через два
  ревью оператором: v1 — развёрнутый текстовый промпт «анализ канала и построение
  контекста аудитории» (13 секций, размеченный текст без схемы); **v2 (действующая)** —
  «построение компактного профиля канала» (14 секций, JSON-схема результата вместо
  текста — позиционирование/автор/аудитория/коммуникационный код/отличительные черты/
  контентные паттерны/устойчивые мотивы с уровнем поддержки/триггеры вовлечения/слабые
  для комментирования посты/контекст для будущих постов/изменения во времени/качество
  данных). См. design.md D6.
- [x] 2.2 Функция вызова LLM (в core-модуле, п.3) — `llm.completeObject()` с
  zod-схемой `channelContextSchema` (не `llm.complete()` — обновлено вместе с 2.1 на
  v2 промпта), без персоны агента в system-промпте (по аналогии с
  `generatePostCommentV4`); результат `JSON.stringify`-ится перед записью
- [x] 2.3 Fail-soft при сбое/таймауте LLM — не обновлять `channel_context`/
  `channel_context_updated_at` этого канала, зафиксировать как пропуск с причиной
- [x] 2.4 Логирование LLM-вызовов в `llm_log` (`skillType = "channel-context"`) — по
  образцу `monitor-v3`/`monitor-v4`; обёртка `withLlmLogging` вынесена из
  `dispatcher.ts` в `core/db/llm-log.ts` (общая для диспетчера и `index.ts`), подключена
  и в периодической задаче, и в ручном туле `tg_channel_context_run`

## 3. Core-модуль анализа

- [x] 3.1 Создать модуль `core/channel-context/run.ts` (по образцу
  `core/channel-analysis/run.ts`): вход — `agentId`, `limit`, `tg`, `llm`, `log`
- [x] 3.2 Отбор каналов: `channelResolved=1 AND channelId IS NOT NULL`, без фильтра по
  `status`, `channel_context_updated_at IS NULL OR <= now - 90d`, `ORDER BY
  channel_context_updated_at ASC` (NULL первыми), `LIMIT limit`
- [x] 3.3 Сбор постов: `getRecentPosts(channel, 100)` + фильтр по `date >= now - 90d`
  в самом модуле (без изменения сигнатуры сервиса)
- [x] 3.4 Сбор комментариев к каждому отобранному посту через существующий
  `getPostComments`
- [x] 3.5 Получение about (`getChannelGateInfo`), текста закрепа (задачи 1.1-1.2,
  best-effort — отсутствие закрепа не прерывает обработку канала)
- [x] 3.6 Пересчёт `subs_count` (`getChannelSubsCount`) и `avg_views`
  (`computeAvgViews`) — запись в существующие колонки `channels`, `coverage_updated_at`
  не трогать
- [x] 3.7 Локальный flood-aware враппер (по образцу `channel-analysis/run.ts`/
  `channel-niche.ts`, НЕ импорт `withFloodRetry` из `skills/util.ts` — сохранить
  направление зависимостей core → skills недопустимо): 2 FLOOD_WAIT подряд → стоп
  обработки текущего агента
- [x] 3.8 Изоляция сбоев: try/catch по каналу (пропуск с причиной, продолжение батча) и
  по агенту (пропуск агента, продолжение списка при ручном запуске нескольких агентов)
- [x] 3.9 Статистика прогона: агентов обработано, каналов проанализировано, пропущено
  и почему

## 4. Модель данных

- [x] 4.1 `core/db/channels.ts`: аддитивная миграция — добавить `channel_context TEXT`,
  `channel_context_updated_at INTEGER` в `channels` (по образцу
  `migrateStatusColumns`/`migratePostWatchColumns`, вызывается из `initChannels`)
- [x] 4.2 Функция отбора каналов на анализ (запрос из задачи 3.2) в `core/db/channels.ts`
- [x] 4.3 Функция записи результата: `channel_context`, `channel_context_updated_at`,
  `subs_count`, `avg_views` по `chatId` (без изменения `coverage_updated_at`) —
  реализовано как новая `saveChannelContext` (текст канала) + переиспользование уже
  существующей `saveCoverage` (subs_count/avg_views), раздельно — чтобы сбой LLM не
  терял уже пересчитанные подписчики/охват (см. 2.3)
- [x] 4.4 Обновить `docs/db-schema.puml`: новые колонки `channels`

## 5. Периодическая задача диспетчера

- [x] 5.1 Создать `skills/channel-context.ts`: тонкая обёртка над
  `core/channel-context/run.ts` с `limit=20`, `agentId` из `SkillContext`
  (`(ctx: SkillContext) => Promise<SkillStatus>`)
- [x] 5.2 Зарегистрировать новый тип задачи в `core/db/tasks.ts`
  (`DEFAULT_PERIODIC_SCHEDULE`) с периодом 8 часов
- [x] 5.3 Зарегистрировать скилл в реестре диспетчера (`scripts/dispatcher.ts`,
  `TaskType → скилл`)
- [x] 5.4 Обновить `docs/task-scheduling.md`: новая строка в таблице периодических задач

## 6. Ручной запуск оператором

- [x] 6.1 Зарегистрировать инструмент в `index.ts` (по образцу
  `tg_channel_content_analysis`): параметры `agents: string[]`, `count: number`;
  валидация (`agents` непуст, `count > 0`); последовательный вызов ядра по каждому
  агенту (своя MTProto-сессия, отключение между агентами) — `tg_channel_context_run`;
  также добавлен литерал `channel-context` в `taskTypeParam` планировщика
  (`tg_scheduler_upsert_task`/`tg_scheduler_trigger_now`)
- [x] 6.2 Создать операторский `skills/channel-context/SKILL.md` (по образцу
  `skills/channel-content-analysis/SKILL.md`): сбор параметров у оператора → вызов
  инструмента → короткий отчёт по прогону

## 7. Проверка

- [x] 7.1 Прогнать typecheck по затронутым файлам — `tsc --noEmit` (с рабочим
  `moduleResolution: bundler`, т.к. закоммиченный `tsconfig.json` сейчас сломан
  независимо от этого change: `module: commonjs` + `moduleResolution: bundler`
  несовместимы, было так уже на начало сессии). Новые/изменённые файлы ошибок не
  дают; все оставшиеся ошибки — предсуществующие и не связаны с этим change
  (отсутствующие `@types/better-sqlite3`, несовпадения `bigint`/`BigInteger` в
  нетронутом коде `telegram/service.ts`/`tdata/client.ts`, отсутствующие типы
  `openclaw/plugin-sdk`)
- [x] 7.2 Убедиться, что существующие вызывающие `getRecentPosts`/`getChannelGateInfo`/
  `getMessageById` (`channel-content-analysis`, `channel-niche.ts`,
  post-freshness-gate) не сломаны расширением сигнатур (задачи 1.1-1.3) — оба
  изменения аддитивны (новое поле `pinnedMsgId`, новый метод `getChannelMessageText`),
  существующие вызывающие деструктурируют только нужные им поля, не ссылаются на
  точный тип объекта — проверено `grep` по всем вызывающим
