---
name: project-channel-rotation-v2-visit-count
description: Проектирование channel-rotation v2 — раскладка «по нагрузке» → «по visit-count из журнала операций»; непроизводные находки
metadata:
  type: project
---

Фича «Раскладка авторотации по истории посещений» (v2). Требования —
`docs/design/channel-rotation/requirements-v2.md` (R1..R7). Архитектура —
`docs/design/channel-rotation/architecture-v2.md`. Спроектирована, не реализована.
Меняется ТОЛЬКО правило выбора целевого агента; остальная авторотация не трогается.

**Непроизводные находки (проверено чтением/grep):**

- **Выбор становится per-candidate независимым — курсор round-robin не нужен.** Старый
  round-robin двигал курсор, чтобы размазать НАГРУЗКУ внутри прогона; v2 убирает нагрузку
  (R1), а каждый кандидат — отдельный канал со своей историей (разные chat_id), поэтому
  назначения других кандидатов в том же прогоне не влияют на visit-count текущего. Один
  канал не может быть кандидатом дважды (источник у leaved_from_banned один). Следствие:
  `plan.ts` сильно упрощается (нет cursor/idx/attempts, нет сортировки целей по нагрузке).

- **`countActiveChannels` (channels.ts) после правки — МЁРТВАЯ.** grep по репо: единственный
  код-потребитель — `run.ts:84`. Прочее — docs/memory/archive. distribution меряет нагрузку
  ПО РЕЕСТРУ (assignmentCountsForPersona), НЕ countActiveChannels. Рекомендация — удалить
  функцию (минорная развилка владельца, DB-слой).

- **visit-count = зеркало `getOwnershipTimeline` + GROUP BY newAgentId.** Тот же мост
  chat_id↔canonical_link через channel_identity, тот же фильтр persona. Рекомендация:
  новая read-функция `getChannelVisitCounts(admin, chatId, persona)` в channel-operations.ts
  (владелец журнала — «один факт один дом»), per-channel запрос (суточный джоб, N запросов
  по idx_ops_chat_type_ts дёшевы; батч — преждевременная оптимизация). newAgentId IS NULL
  (пустой слот) в счёт не идёт.

- **plan.ts передаётся готовая структура `Map<chatId, Map<agentId, number>>`** (реком.),
  отсутствие агента = vc 0 (не материализуем нули). Тай-брейк — Math.random() inline (уже
  прецедент в текущем plan.ts); тест проверяет «результат ∈ множество минимальных
  не-источников», не точного агента (R4 случайный).

- **Тест plan.ts отсутствует** (проверено) — нужен новый plan.test.ts под AC-1..AC-6.

**6 развилок владельцу** (§9 architecture-v2.md): передача vc в plan (A Map), дом запроса
(A getChannelVisitCounts), батч/per-channel (A per-channel), тай-брейк (A Math.random),
удаление countActiveChannels (реком. да, минор), снятие сортировки кандидатов (реком. да, минор).

Связано: [[project-channel-multipersona-architecture]] (persona-разрез, resolvePersonaTargets,
countActiveChannels как прежний источник нагрузки ротации),
[[project-channel-operations-history]] (журнал assigned, getOwnershipTimeline, мост).
