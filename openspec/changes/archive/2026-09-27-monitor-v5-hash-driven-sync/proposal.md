## Why

monitor-v5 держит `access_hash` каналов свежим суточным полным синком
(`V5_FULL_SYNC_PERIOD_SECONDS=86400`), а `not_found` (агент больше не участник)
детектит только этот же синк (пропал из диалогов). После внедрения провенанса
`access_hash` (change `tg-peer-identity-model`) это даёт две проблемы: (1) после
переавторизации все хэши устаревают, но обновятся лишь на ближайшем суточном
синке — агент простаивает до ~24 ч; (2) суточная задержка детекта `not_found`.
Дизайн и эмпирика — `docs/design/tg-peer-identity-model/architecture.md` §9
(OV-9.1/OV-9.2 подтверждены на живом агенте).

## What Changes

- **Убрать суточный таймер полного синка** (`isFullSyncDue`/`markFullSyncDone`/
  `V5_FULL_SYNC_PERIOD_SECONDS`, таблица `sync_state`).
- **Триггерить полный проход диалогов по устареванию хэшей**:
  `hasStaleAccessHashes(agentId, sessionAuthorizedAt)` — EXISTS канал с
  `membership='member'` И (`chat_access_hash_updated_at IS NULL OR
  < sessionAuthorizedAt`). После reauth все хэши устаревают → один проход
  переполучает их и реконсилирует; между reauth проход не идёт.
- **Read-time детект `not_found`**: `CHANNEL_PRIVATE` при чтении канала со свежим
  засеянным хэшем = агент не участник → `markChannelStatus(not_found)`. Ловится в
  `catch` вокруг `getPeerDialog` (и на путях `getMessages`/reply). Пробинг не нужен
  (эмпирика OV-9.1: не-участник бросает `CHANNEL_PRIVATE`, не возвращает `[]`).
- **Разовый бэкафилл `sessionAuthorizedAt = now`** во все существующие
  `tg-account.json` — для когерентности предикатов staleness/freshness у legacy.

Смысловой гейт сохраняется: `CHANNEL_PRIVATE` (валидный хэш, не участник →
`not_found`) vs `CHANNEL_INVALID` (протухший хэш → reacquire).

## Capabilities

### New Capabilities
- `peer-hash-refresh`: политика поддержания `access_hash` каналов свежим без
  таймера — обновление по устареванию относительно авторизации и детект
  `not_found` в момент чтения по `CHANNEL_PRIVATE`.

### Modified Capabilities
<!-- Нормативные требования group-monitoring-v5 по обработке каналов не меняются;
     меняется только когда/чем триггерится полный проход и как детектится not_found
     — это выносится в новую capability peer-hash-refresh. -->

## Impact

- **Код**: `src/skills/monitor-v5.ts` (Шаг 3 — триггер прохода; блок обработки
  статуса диалога — read-time not_found), `src/core/db/channels.ts`
  (`hasStaleAccessHashes`; удаление `isFullSyncDue`/`markFullSyncDone`/`sync_state`),
  `src/core/config.ts` (`V5_FULL_SYNC_PERIOD_SECONDS` — удаление),
  классификатор ошибок на пути чтения (тег `channel_private`).
- **Данные**: разовый бэкафилл `sessionAuthorizedAt` в `tg-account.json` (разовый
  thundering-herd на первом прогоне — размазан диспетчером).
- **Зависимость**: поверх реализованного `tg-peer-identity-model` (провенанс
  `access_hash`, `membership`, `getFreshChatAccessHash`).
- Полный дизайн и эмпирика — `docs/design/tg-peer-identity-model/architecture.md` §9.
