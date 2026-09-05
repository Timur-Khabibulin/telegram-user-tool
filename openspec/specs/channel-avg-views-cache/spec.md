# channel-avg-views-cache Specification

## Purpose
TBD - created by archiving change channel-coverage-report. Update Purpose after archive.
## Requirements
### Requirement: avg_views хранится в per-agent БД таблицы channels
Система SHALL хранить кэшированный средний охват канала в полях `avg_views REAL` и
`avg_views_updated_at INTEGER` таблицы `channels`. Поля добавляются аддитивной
миграцией при инициализации БД.

#### Scenario: Миграция при первом запуске
- **WHEN** вызывается `initChannels(agentId)`
- **THEN** если колонки `avg_views` и `avg_views_updated_at` отсутствуют — они добавляются
- **THEN** существующие строки получают `avg_views = NULL`, `avg_views_updated_at = NULL`
- **THEN** если колонки уже есть — миграция не изменяет данные

### Requirement: Формула вычисления avg_views
Система SHALL вычислять `avg_views` канала как среднее число просмотров по последним
10 постам, пропуская самый свежий пост.

#### Scenario: Стандартный расчёт
- **WHEN** канал имеет 11 и более постов
- **THEN** берутся посты с позиции 2 по 11 от конца (10 постов, самый свежий пропущен)
- **THEN** `avg_views = SUM(views) / 10`

#### Scenario: Недостаточно постов
- **WHEN** канал имеет менее 2 постов
- **THEN** `avg_views` остаётся NULL
- **THEN** `avg_views_updated_at` проставляется текущим временем (чтобы не пересчитывать повторно)

#### Scenario: От 2 до 10 постов
- **WHEN** канал имеет от 2 до 10 постов
- **THEN** берутся все посты кроме самого свежего
- **THEN** `avg_views = SUM(views) / количество_взятых_постов`

### Requirement: Плановый пересчёт avg_views раз в месяц
Система SHALL пересчитывать `avg_views` для каналов, у которых
`avg_views_updated_at IS NULL OR avg_views_updated_at <= now() - AVG_VIEWS_CACHE_TTL_SECONDS`
(TTL = 30 дней). Пересчёт выполняет standalone-скрипт, запускаемый systemd-таймером.

#### Scenario: Плановый прогон
- **WHEN** systemd-таймер запускает скрипт пересчёта
- **THEN** скрипт обходит всех агентов последовательно
- **THEN** для каждого агента выбирает каналы с истёкшим TTL (`channelResolved = 1`, `channelId IS NOT NULL`)
- **THEN** запрашивает последние 11 постов через MTProto и вычисляет avg_views
- **THEN** сохраняет результат и обновляет `avg_views_updated_at = now()`
- **THEN** после обхода всех каналов агента закрывает Telegram-сессию

#### Scenario: FLOOD_WAIT при запросе
- **WHEN** Telegram API возвращает FloodWaitError(seconds)
- **THEN** скрипт ожидает указанное число секунд
- **THEN** повторяет запрос для текущего канала один раз
- **THEN** при повторной ошибке — пропускает канал и продолжает

#### Scenario: Ошибка для отдельного канала
- **WHEN** запрос постов канала завершается ошибкой (не FLOOD_WAIT)
- **THEN** ошибка логируется
- **THEN** `avg_views` канала не обновляется
- **THEN** скрипт переходит к следующему каналу

### Requirement: Пауза между запросами к Telegram API
Система SHALL выдерживать паузу не менее 2000 мс между последовательными запросами
`getRecentPosts` в рамках одной агентской сессии.

#### Scenario: Rate limit между каналами
- **WHEN** скрипт завершил запрос для одного канала
- **THEN** перед запросом следующего канала выдерживается пауза 2000 мс

