## ADDED Requirements

### Requirement: Оператор получает CSV-отчёт по каналам в Saved Messages
Система SHALL собирать каналы из таблицы `channels` всех агентов (только вступлённые,
`channelResolved = 1` не обязателен — берутся все каналы независимо от резолва),
формировать CSV-файл и отправлять его в Saved Messages агента `agent1`.

#### Scenario: Успешная генерация отчёта
- **WHEN** оператор вызывает OpenClaw-инструмент `tg_channel_coverage_report`
- **THEN** система собирает каналы всех агентов из их per-agent БД
- **THEN** формирует CSV с колонками: Название, Ссылка, chat_id, Средний охват, Дата пересчёта, Агент
- **THEN** отправляет CSV-файл в Saved Messages агента agent1
- **THEN** возвращает `{ channelCount, agentCount }` в ответе инструмента

#### Scenario: Каналы без avg_views включаются в отчёт
- **WHEN** у канала `avg_views IS NULL`
- **THEN** канал попадает в отчёт с пустой ячейкой охвата
- **THEN** такие каналы располагаются в конце списка (после всех каналов с охватом)

### Requirement: Отчёт отсортирован по убыванию среднего охвата
Система SHALL сортировать строки CSV по `avg_views` DESC на этапе формирования файла.
Порядок строк в БД значения не имеет.

#### Scenario: Сортировка в выводе
- **WHEN** отчёт формируется
- **THEN** канал с наибольшим `avg_views` располагается первым в файле
- **THEN** каналы с одинаковым `avg_views` располагаются в произвольном порядке между собой

### Requirement: Состав строки отчёта
Каждая строка CSV SHALL содержать: название канала, ссылку `t.me/{username}` (пустая
если `channelUsername IS NULL`), `chatId`, `avg_views`, дату последнего пересчёта
в человекочитаемом формате, `agentId`.

#### Scenario: Канал с username
- **WHEN** у канала заполнен `channelUsername`
- **THEN** в колонке «Ссылка» содержится `t.me/{channelUsername}`

#### Scenario: Канал без username
- **WHEN** `channelUsername IS NULL`
- **THEN** колонка «Ссылка» пустая
