## 1. Миграция схемы БД

- [x] 1.1 В `src/core/db/discovery.ts`: добавить миграцию `assigned_agent NOT NULL → nullable` — пересборка таблицы через RENAME + CREATE + INSERT + DROP
- [x] 1.2 Добавить функцию `getUnassignedChannels(adminAgentId): string[]` — SELECT с `assigned_agent IS NULL`
- [x] 1.3 Добавить функцию `assignChannel(adminAgentId, canonical, agent): { assigned: boolean }` — UPDATE WHERE `assigned_agent IS NULL`
- [x] 1.4 Изменить `registerChannel` — параметр `assignedAgent` становится необязательным; при отсутствии INSERT с NULL
- [x] 1.5 Исправить `assignmentCounts` — добавить фильтр `WHERE assigned_agent IS NOT NULL`

## 2. Типы и структуры данных

- [x] 2.1 Расширить `SearcherStatus` в `src/core/discovery/similar.ts`: добавить поля `collected: number`, `skips: SkipCounts`
- [x] 2.2 Добавить тип `SharedCollectionState { totalCollected: number, goal: number }`

## 3. Функция runSearcher

- [x] 3.1 Создать функцию `runSearcher(searcherId, shared, params, log): Promise<SearcherStatus>` с собственным экземпляром `TelegramService`
- [x] 3.2 Реализовать per-searcher BFS с изолированным `visited: Set<string>` и сортировкой seed-каналов по вовлечённости
- [x] 3.3 Регистрировать кандидатов через `registerChannel(..., undefined)` — без агента; инкрементировать `shared.totalCollected` только при `inserted=true`
- [x] 3.4 Проверять `shared.totalCollected >= shared.goal` после каждой успешной регистрации и останавливаться
- [x] 3.5 Перехватывать все ошибки внутри — ошибка сессии → поле `error`, двойной FLOOD_WAIT → `stoppedByFlood`; функция никогда не реджектит promise

## 4. Фаза распределения

- [x] 4.1 Изменить `distribute` — читать пул из `getUnassignedChannels` вместо in-memory массива
- [x] 4.2 Назначать агента через `assignChannel` + `addJoinQueue` round-robin до `target` на агента

## 5. Оркестратор runSimilarDiscovery

- [x] 5.1 Заменить последовательный цикл на `Promise.all(searchers.map(id => runSearcher(...)))` с общим `SharedCollectionState`
- [x] 5.2 Запускать `distribute` строго после `Promise.all` — независимо от результатов искателей

## 6. Отчёт

- [x] 6.1 Изменить `renderSimilarReport` — добавить per-searcher таблицу: имя / найдено / отсеяно по каждому гейту / статус
- [x] 6.2 Добавить итоговую строку «ИТОГО» с суммарными значениями по всем искателям
- [x] 6.3 В строке проблемного искателя указывать причину остановки рядом со счётчиками

## 7. Документация

- [x] 7.1 Обновить `docs/db-schema.puml` — `assigned_agent` без NOT NULL, добавить примечание о NULL-пуле
