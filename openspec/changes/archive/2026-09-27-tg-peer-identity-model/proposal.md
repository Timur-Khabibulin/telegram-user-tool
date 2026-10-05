## Why

Per-agent `tg-channels.db` хранит `access_hash` peer'ов без признака провенанса,
поэтому после переавторизации агента (новая `sessionString`) сохранённый
`access_hash` устаревает, но код не умеет это распознать: холодный путь
(review-listener через `seedPeerCache`/`getChatAccessHash`) сидирует `peerCache`
из БД без проверки актуальности и обращается по устаревшему хэшу. Требования и
решение зафиксированы в `docs/design/tg-peer-identity-model/requirements-v1.md`
(R1–R6, AC-1…AC-5) и `docs/design/tg-peer-identity-model/architecture.md`.

## What Changes

- Ввести провенанс `access_hash`: `session_authorized_at` (в `tg-account.json`,
  рядом с `sessionString`) и `access_hash_updated_at` (в БД). Правило валидности —
  `access_hash_updated_at >= session_authorized_at`; устаревший хэш переполучается.
- Переполучение `access_hash` (reacquire) — строго по стабильному marked id через
  проход диалогов, без резолва по username.
- Любая запись `sessionString` проставляет `session_authorized_at = now` (reauth
  из tdata, автогенерация, провижининг пула, интерактивный логин).
- Ввести `peer_type` (`broadcast`/`megagroup`/`basic_group`) как явную колонку.
- Ввести `membership` (`member`/`left`/`banned`/`not_found`) как отдельный дом
  факта членства; на переходный период — **dual-write** рядом со `status` (status
  не вычищается, вне-скоупные потребители не трогаются). Перевод потребителей и
  вычистка `status` — отдельный будущий change (план сходимости).
- `linked_broadcast_username` — first-class публичный хэндл (маппится на уже
  хранимый `channelUsername`).
- Обработка миграции `basic_group` → супергруппа (`migrated_to_id`), чтобы не
  терять чат при смене идентификатора.
- Аддитивная миграция `channels.db` (Вариант A): новые колонки через
  `ALTER TABLE`, унаследованные `access_hash` при миграции считаются невалидными
  (нет таймстампа) и переполучаются на первом обращении.

Скоуп строго по ТЗ: только идентичность peer и членство. Вне скоупа — метрики,
`write_access`, post-watch, DM-кандидаты, статусные таймеры (их колонки не
трогаются).

## Capabilities

### New Capabilities
- `peer-identity`: хранение идентичности Telegram-сущностей (peer) в per-agent БД —
  стабильные идентификаторы (marked id, тип, публичные хэндлы, связь
  обсуждение↔broadcast), провенанс и правило валидности `access_hash`,
  переполучение по id, состояние членства, миграция `basic_group`→супергруппа.

### Modified Capabilities
<!-- Нет: вне-скоупные потребители продолжают читать `status` без изменений
     (dual-write), их нормативное поведение не меняется. Перевод на `membership`
     — отдельный будущий change. -->

## Impact

- **Данные**: `channels.db` (таблица `channels`) — новые колонки; `tg-account.json`
  (`AccountConfig`) — новое поле `session_authorized_at`.
- **Код**: `src/core/config.ts` (чтение поля), `src/core/telegram/service.ts`
  (`buildInputPeer`/reacquire/`seedPeerCache`/`onPeerApiError`), `src/core/db/channels.ts`
  (миграция колонок, dual-write, чтение с проверкой валидности), точки записи
  `sessionString` (`tg-agent-reauth-from-tdata`, автогенерация, pool-provision),
  распознавание `migrated_to`/`deactivated` на пути синхронизации диалогов.
- **Замена аккаунта** (`banned-account-replacement`): не меняется — per-account
  `channels.db` корректно уничтожается на swap, закрепление живёт в реестре.
- Полное соответствие требованиям и техническое решение — в парных документах
  `docs/design/tg-peer-identity-model/`.
