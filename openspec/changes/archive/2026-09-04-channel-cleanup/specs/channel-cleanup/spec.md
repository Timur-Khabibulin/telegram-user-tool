## ADDED Requirements

### Requirement: Валидация параметров
Инструмент SHALL требовать хотя бы один из параметров `minSubsCount` или `minAvgViews`. При отсутствии обоих SHALL вернуть ошибку до начала любой обработки.

#### Scenario: Оба фильтра не заданы — ошибка
- **WHEN** оператор вызывает инструмент без `minSubsCount` и без `minAvgViews`
- **THEN** инструмент возвращает ошибку валидации и не выполняет никаких действий

### Requirement: Фильтрация каналов-кандидатов
Инструмент SHALL отбирать каналы для чистки по AND-логике: канал является кандидатом только если выполнены ВСЕ переданные условия. Значения `NULL` в `avg_views` и `subs_count` SHALL трактоваться как 0.

#### Scenario: Канал проходит оба фильтра — кандидат
- **WHEN** `avg_views=80`, `subs_count=400`, задан `minAvgViews=100` и `minSubsCount=500`
- **THEN** канал является кандидатом на чистку

#### Scenario: Канал проходит только один фильтр из двух — не кандидат
- **WHEN** `avg_views=80`, `subs_count=2000`, задан `minAvgViews=100` и `minSubsCount=500`
- **THEN** канал НЕ является кандидатом (AND-условие не выполнено)

#### Scenario: avg_views = NULL — считается нулевым
- **WHEN** `avg_views=NULL`, `subs_count=400`, задан `minAvgViews=100` и `minSubsCount=500`
- **THEN** канал является кандидатом (NULL avg_views < 100)

#### Scenario: Задан только один фильтр
- **WHEN** задан только `minAvgViews=100`, `avg_views=80`
- **THEN** канал является кандидатом (единственное условие выполнено)

### Requirement: Выход из канала и удаление данных
Для каждого кандидата инструмент SHALL сначала выполнить выход через Telegram API, затем удалить все рабочие данные агента по каналу из всех БД. Если выход не удался — данные SHALL NOT удаляться.

#### Scenario: Успешный выход — данные удаляются
- **WHEN** `leaveChannel` завершается успешно для кандидата
- **THEN** выполняется `purgeChannelData` и канал удаляется из `discovered_channels` (best-effort)

#### Scenario: Ошибка выхода — данные не удаляются
- **WHEN** `leaveChannel` возвращает ошибку для кандидата
- **THEN** данные агента по каналу НЕ удаляются, канал помечается как `leave_failed`, обработка остальных каналов продолжается

### Requirement: Удаление из discovered_channels
После успешного выхода инструмент SHALL удалить строку канала из `discovered_channels`. Удаление SHALL выполняться только если `channelResolved=1` и `channelUsername IS NOT NULL`; иначе — пропустить с incrementом `discoverySkipped`.

#### Scenario: Канал с channelUsername удаляется из discovery
- **WHEN** `channelResolved=1` и `channelUsername` задан
- **THEN** строка с `canonical_link = normalizeChannelLink(channelUsername)` удаляется из `discovered_channels`

#### Scenario: Канал без channelUsername — discovery не трогается
- **WHEN** `channelUsername IS NULL` или `channelResolved=0`
- **THEN** `discovered_channels` не изменяется, `discoverySkipped++`

### Requirement: Изоляция агентов
Чистка SHALL затрагивать только данные агентов, явно переданных в параметре `agents`. Данные других агентов SHALL NOT изменяться, даже если они состоят в тех же каналах.

#### Scenario: Чистка только у указанных агентов
- **WHEN** `agents=["agent-1"]`, оба агента подписаны на один канал
- **THEN** данные по каналу удаляются только у `agent-1`; данные `agent-2` не затронуты

### Requirement: Уведомление в Saved Messages
По завершении обработки каждого агента инструмент SHALL отправить сообщение в Saved Messages агента с итоговыми счётчиками.

#### Scenario: Есть очищенные каналы — отчёт со счётчиками
- **WHEN** у агента были кандидаты и часть успешно очищена
- **THEN** в Saved Messages отправляется: `[channel-cleanup] agent=<id>\nОчищено: N | Ошибки выхода: N | Не в реестре: N`

#### Scenario: Кандидатов нет — сообщение об этом
- **WHEN** ни один канал агента не проходит фильтры
- **THEN** в Saved Messages отправляется: `[channel-cleanup] agent=<id>\nКандидатов не найдено по заданным фильтрам.`
