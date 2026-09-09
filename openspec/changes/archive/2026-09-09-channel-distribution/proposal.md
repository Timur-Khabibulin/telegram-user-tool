## Why

Распределить список каналов по агентам сейчас может только разработчик — вручную,
через IDE, запуская ops-скрипты (`distribute-channels.ts` и соседи). Администратор
платформы (не разработчик) этого сделать не может, и любое подключение каналов
упирается в разработчика. Требуется самостоятельный путь для администратора через
Telegram-бот. Полные требования — `docs/design/channel-distribution/requirements-v1.md`;
техническое решение — `docs/design/channel-distribution/architecture.md`.

## What Changes

- Новый Telegram-бот (`distribution-listener`, отдельный bot-токен) как фронт-энд
  администратора: приём CSV, выбор агентов диапазонами `agentId`, запуск, статус,
  сводка. Поток command-initiated (спец-команда → приём файла и диапазонов).
- Распределение выполняется инлайн в listener'е (чистая SQLite-операция без
  обращений к Telegram): дедуп, балансировка, регистрация в реестре, постановка в
  `join_queue` батчем по агенту, запуск задачи `join-queue` у целевых агентов.
- Новая балансировка «выравнивание итоговой нагрузки» (детерминированный water-fill
  по `assignmentCounts`) — отличается по цели от round-robin discovery и
  health-spread rotation.
- Новое хранилище прогонов `channel-distribution.db` (таблица `distribution_tasks`:
  статус, счётчики исходов, аудит), сохранение загруженных файлов, журнал в journald.
- Авторизация по чату (настраиваемый уполномоченный чат, default-deny).
- **BREAKING** (поведение системы, не API): модель метрик реестра переводится с
  мёртвых фиксированных колонок (`sub_count`/`avg_views`/…) на единое поле
  произвольного состава (`metrics_json`); справочно, на распределение не влияет.

## Capabilities

### New Capabilities
- `channel-distribution`: приём CSV и выбор агентов через Telegram-бот, валидация
  формата ссылок и классификация исходов строк, балансировка «выравнивание
  итоговой нагрузки», регистрация в реестре и постановка в очередь вступления,
  запуск задачи `join-queue` у целевых агентов, задача-прогон со статусом и
  сводкой, авторизация по чату, аудит (файлы, история прогонов, журнал).

### Modified Capabilities
- `channel-registry`: (1) модель метрик канала — единое поле произвольного состава
  вместо фиксированных колонок; (2) разграничение балансировок — существующее
  требование round-robin без учёта накопленной нагрузки сохраняется для discovery,
  а `channel-distribution` вводит собственную load-aware балансировку; на платформе
  сосуществуют три балансировки с разными целями (discovery, rotation, distribution).

## Impact

- Новые: `src/core/distribution-bot-api.ts`, `src/core/db/distribution.ts`,
  `src/features/channel-distribution/{plan,run}.ts`,
  `src/scripts/periodic/distribution-listener.ts`,
  `deploy/systemd/tg-distribution-listener.service`.
- Переиспользуются как есть: `normalizeChannelLink`, `getChannelStatus`,
  `registerChannel`, `assignmentCounts`, `addJoinQueue`, `upsertTask`/
  `computeDefaultSchedule("join-queue")`.
- `src/core/db/discovery.ts`: аддитивная миграция колонки `metrics_json`; легаси
  колонки метрик остаются на месте (обратимость, читателей нет).
- `src/core/config.ts`: пути `distributionDbPath`, `distribution-uploads/`; чтение
  `CHANNEL_DISTRIBUTION_CHAT_ID` из `secrets.env`.
- Существующие ops-скрипты распределения — сосуществуют, не переписываются.
- Координация с заархивированным `channel-rotation`: примитивы реестра общие,
  балансировщик (`planRotation`) и счётчик нагрузки (`countActiveChannels`) — нет;
  третий релакс инварианта `channel-registry` не требуется (чужие каналы
  пропускаются, назначение не меняется).
