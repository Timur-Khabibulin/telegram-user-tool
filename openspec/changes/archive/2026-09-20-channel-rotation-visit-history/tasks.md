## 1. Запрос истории посещений

- [x] 1.1 В `src/core/db/channel-operations.ts` добавить `getChannelVisitCounts(adminAgentId, chatId, persona)` — по образцу `getOwnershipTimeline`/`aggregateBansByAgent`: `type='assigned'`, мост `chat_id↔canonical_link`, фильтр `persona`, `GROUP BY newAgentId` → `Map<agentId, number>` (или объект). Отсутствующий агент трактуется вызывающим как 0.

## 2. Правило раскладки (plan.ts)

- [x] 2.1 Переписать `planRotation` в `src/features/channel-rotation/plan.ts`: принимать visit-counts (`Map<chatId, Map<agentId, number>>`) вместо `loadByAgent`; для каждого кандидата — активные цели минус источник, выбрать минимальный visit-count (агент без записи = 0), случайно (`Math.random()`) среди равных; нет цели → `unassigned`. Убрать курсор round-robin, сортировку целей по нагрузке, `attempts`-обход и сортировку кандидатов по `statusUpdatedAt`.
- [x] 2.2 Обновить сигнатуру/типы `planRotation` (входные параметры) под новый контракт.

## 3. Оркестрация (run.ts)

- [x] 3.1 В `src/features/channel-rotation/run.ts` заменить сбор `loadByAgent=countActiveChannels` на сбор visit-counts через `getChannelVisitCounts` (per-channel по кандидатам персоны, разрез персоны) и передать их в `planRotation`. Остальное (кандидаты, группировка по персоне, применение назначения, сводка) не менять.

## 4. Уборка

- [x] 4.1 Удалить мёртвую `countActiveChannels` из `src/core/db/channels.ts` (после снятия единственного потребителя в `run.ts`); проверить grep'ом отсутствие других вызовов.

## 5. Тесты и проверка

- [x] 5.1 Новый `src/features/channel-rotation/plan.test.ts` (`node --import tsx --test`) под AC-1…AC-6: канал уходит агенту с visit-count 0 независимо от нагрузки; случайный выбор среди равных (проверять принадлежность множеству минимальных не-источников); повтор только после круга; источник исключён; unassigned если активен только источник.
- [x] 5.2 Тайпчек затронутых файлов; `openspec validate channel-rotation-visit-history`.
