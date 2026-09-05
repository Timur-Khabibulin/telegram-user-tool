## ADDED Requirements

### Requirement: Сбор subs_count при обновлении coverage
Скрипт `channel-coverage-update` SHALL при каждом прогоне сохранять `subs_count` (число подписчиков) для каждого канала в таблицу `channels` вместе с `avg_views` в рамках одного и того же обхода.

#### Scenario: Успешное получение subs_count
- **WHEN** скрипт обрабатывает канал с валидным `channelId`/`channelAccessHash`
- **THEN** `subs_count` сохраняется в `channels` вместе с `avg_views` и `coverage_updated_at`

#### Scenario: FLOOD_WAIT при получении subs_count — ретрай
- **WHEN** `getChannelSubsCount` возвращает `FloodWaitError` с `waitSeconds`
- **THEN** скрипт ждёт `waitSeconds * 1000` мс, повторяет вызов один раз; при повторной ошибке сохраняет `subs_count=null` и продолжает

### Requirement: Единый timestamp coverage_updated_at
Таблица `channels` SHALL хранить одно поле `coverage_updated_at` вместо `avg_views_updated_at`. Поле SHALL обновляться при каждом сохранении `avg_views` и `subs_count`.

#### Scenario: Миграция существующей БД
- **WHEN** `initChannels` вызывается на БД с полем `avg_views_updated_at`
- **THEN** поле переименовывается в `coverage_updated_at` без потери данных

#### Scenario: Свежая БД — поле создаётся напрямую
- **WHEN** `initChannels` вызывается на БД без `avg_views_updated_at` и без `coverage_updated_at`
- **THEN** создаётся поле `coverage_updated_at INTEGER`
