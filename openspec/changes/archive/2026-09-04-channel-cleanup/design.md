## Context

У каждого агента накапливается 200–1000+ каналов в `tg-channels.db`. Данные `avg_views` уже есть в таблице `channels` и обновляются ежемесячно скриптом `channel-coverage-update.ts`. Данных `subs_count` нет — нужно добавить в ту же ежемесячную процедуру. Скилл `purgeChannelData` уже существует и удаляет все рабочие данные агента по каналу.

Инструмент вызывается оператором вручную через OpenClaw — не диспетчером. Обрабатывает несколько агентов последовательно.

## Goals / Non-Goals

**Goals:**
- Выйти из каналов, прошедших фильтрацию, через Telegram API
- Удалить все рабочие данные агента по каналу из всех БД (включая `discovered_channels`)
- Отправить итоговый отчёт в Saved Messages каждого агента
- Кешировать `subs_count` в БД — без API-вызовов в момент чистки

**Non-Goals:**
- Блокировка повторного вступления через `join_queue` (v1)
- Автоматический запуск по расписанию
- Режим dry-run

## Decisions

### 1. Кеш subs_count вместо fresh API-вызовов

При 1000+ каналах получение `subs_count` через `channels.GetFullChannel` в момент чистки — ~16 минут и неизбежный FLOOD_WAIT.

**Решение:** хранить `subs_count` в таблице `channels`, обновлять раз в месяц вместе с `avg_views` в рамках одного прохода `channel-coverage-update.ts`.

**Альтернатива:** fresh-запрос при каждом запуске чистки — отброшена из-за масштаба и FLOOD_WAIT.

### 2. Одно поле coverage_updated_at вместо двух timestamp'ов

Оба поля (`avg_views`, `subs_count`) обновляются одновременно одним скриптом → единственное поле `coverage_updated_at` достаточно. `avg_views_updated_at` переименовывается.

### 3. NULL → 0 при фильтрации

Каналы без данных (не прошли `channel-coverage-update`) получают `NULL` в обоих полях. По бизнес-решению: NULL = 0, то есть слабейший показатель → попадают под чистку если задан соответствующий фильтр.

### 4. AND-логика при нескольких фильтрах

Оба параметра опциональные. Канал чистится только если выполнены ВСЕ переданные условия. Если задан один — действует только он.

### 5. channel-cleanup — не SkillContext-скилл

Обрабатывает несколько агентов за один вызов, нет `persona`/`llm` в контексте. Реализуется как функция `runChannelCleanup`, вызываемая напрямую из `index.ts` через общий `tg` — по образцу `runDiscovery`.

### 6. DELETE из discovered_channels вместо пометки

Канал удаляется из реестра полностью (не помечается `banned_at`). Best-effort: только если `channelResolved=1` и `channelUsername IS NOT NULL`. Если нет — `discoverySkipped++` в отчёт.

## Risks / Trade-offs

- `subs_count` / `avg_views` устарели до месяца → перед чисткой рекомендуется запустить `channel-coverage-update`; документируется в описании инструмента
- После чистки агент может снова вступить в канал через discovery (строка в `discovered_channels` удалена → канал «незнаком» → discovery переоткроет) → риск принят в v1, решать в v2
- Каналы без `channelUsername` не удаляются из `discovered_channels` → возможен дубль в discovery; принято как best-effort

## Migration Plan

1. При старте `initChannels` выполняется `migrateCoverageColumns`:
   - если есть `avg_views_updated_at`, нет `coverage_updated_at` → `RENAME COLUMN`
   - если нет ни того ни другого → `ADD COLUMN coverage_updated_at INTEGER`
   - `ADD COLUMN subs_count INTEGER` (если не существует)
2. Данные `avg_views_updated_at` → `coverage_updated_at` переносятся автоматически через RENAME
3. `subs_count` заполнится при первом прогоне `channel-coverage-update` после деплоя

Rollback: поле `subs_count` аддитивное, RENAME обратимо через ещё один RENAME. Скилл не затрагивает данные других агентов.

## Open Questions

— нет —
