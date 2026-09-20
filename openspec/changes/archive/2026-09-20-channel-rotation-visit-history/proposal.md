## Why

Авторотация выбирает целевого агента **по нагрузке** (round-robin по числу активных
каналов). Это не учитывает историю: канал может снова достаться агенту, который его
уже держал (и, возможно, там же был забанен), пока агенты, ещё не пробовавшие канал,
его не получают. Меняем правило на распределение **по истории посещений**. Требования
и архитектура согласованы: `docs/design/channel-rotation/requirements-v2.md` и
`docs/design/channel-rotation/architecture-v2.md`.

## What Changes

- **Правило выбора целевого агента**: было round-robin по нагрузке → стало по
  **visit-count** — число прошлых назначений (`assigned`) канала агенту в разрезе
  персоны. Канал уходит агенту с минимальным visit-count, случайно среди равных,
  исключая источник; «круги» возникают как следствие роста минимума.
- **Источник visit-count** — журнал операций (`assigned`-события): новая читающая
  функция `getChannelVisitCounts` в `channel-operations.ts` (зеркало
  `getOwnershipTimeline` по мосту `chat_id↔canonical_link` + счёт по `newAgentId`).
- **`plan.ts` упрощается**: курсор round-robin и сортировка целей по нагрузке убраны —
  выбор становится независимым по каждому кандидату.
- **`countActiveChannels` удаляется** — после правки её единственный потребитель
  (`run.ts`) перестаёт её звать, функция становится мёртвой.
- **Не меняется**: сбор кандидатов, группировка по персоне, перенос назначения
  (закрепление → очередь вступления → удаление у источника), суточный таймер,
  поведение `unassigned`.

## Capabilities

### New Capabilities
<!-- нет -->

### Modified Capabilities
- `channel-rotation`: правило выбора целевого агента — по истории посещений
  (visit-count) вместо нагрузки; источник исключается из выбора.

## Impact

- **Код**: `src/features/channel-rotation/plan.ts` (новое правило + упрощение),
  `src/features/channel-rotation/run.ts` (visit-counts вместо `loadByAgent`),
  `src/core/db/channel-operations.ts` (`getChannelVisitCounts`),
  `src/core/db/channels.ts` (удаление мёртвой `countActiveChannels`), новый
  `src/features/channel-rotation/plan.test.ts`.
- **Данные**: без миграций; visit-count читается из существующего журнала операций
  (ведётся с ~2026-09-12 — ранняя история не видна).
- **Без изменений**: `leave-banned-channels`, `join-queue`, реестр закрепления,
  суточный таймер.
