## Why

Сейчас нельзя определить, сколько раз и когда канал был забанен у того или иного
агента: пер-агентная `channels.db` хранит только последний статус (перезапись), а
при ротации строка канала у прежнего агента удаляется целиком. История теряется и
ретроспективно не восстанавливается. Требования и архитектура зафиксированы в
[docs/design/channel-operations-history/requirements-v1.md](../../../docs/design/channel-operations-history/requirements-v1.md)
и [docs/design/channel-operations-history/architecture.md](../../../docs/design/channel-operations-history/architecture.md).

## What Changes

- Новый централизованный append-only журнал операций над каналами
  (`channel-operations.db` в workspace админ-агента), ключ канала — `chatId`.
- Новый модуль `core/db/channel-operations.ts` — владелец схемы, белого списка
  учитываемых переходов и всех функций записи/чтения; единственное место логики
  журнала.
- Инструментирование существующих точек-писателей статуса и владения
  (`markChannelStatus`, `setLeftChannelStatus`, `expireChannelStatuses`,
  `upsertChannelIdentityFromJoin`, `assignChannel`, `forceAssignChannel`):
  аддитивно, без изменения их внешнего поведения.
- Переработка `expireChannelStatuses` на пообъектную обработку, чтобы отличать
  снятие `suspend` (журналируется, источник `timer`) от `sleep` (не журналируется);
  внешнее поведение сброса статусов сохраняется.
- Три типа операций в v1: смена статуса, `assigned` (смена владельца), `joined`
  (вступление). `should_leave` в v1 не журналируется (нет кодовой точки записи).

## Capabilities

### New Capabilities
- `channel-operations-history`: централизованный append-only журнал операций над
  каналами — фиксация переходов статуса, смены владельца и вступления с ключом
  `chatId`; ответы на «сколько раз и когда канал забанен у агента», тайм-линия
  владения, агрегат банов по агенту.

### Modified Capabilities
<!-- Нет: журналирование аддитивно, нормативное поведение существующих
     способностей (смена статуса, ротация, вступление, очередь выхода) не меняется. -->

## Impact

- **Новый код:** `core/db/channel-operations.ts`; путь `channelOperationsDbPath`
  в `core/config.ts`; новый файл БД `channel-operations.db` в admin-workspace.
- **Правки (аддитивные):** `core/db/channels.ts`
  (`markChannelStatus` +параметр `source`, `setLeftChannelStatus`,
  `expireChannelStatuses`, `upsertChannelIdentityFromJoin`), `core/db/discovery.ts`
  (`assignChannel`, `forceAssignChannel`).
- **Не трогается:** мониторы `monitor-v2..v5`, скилл `leave-banned-channels`,
  `channel-rotation`, `join-queue` — вызовы инструментируемых функций у них не
  меняются.
- **Зависимости/инфраструктура:** без новых зависимостей; SQLite WAL +
  `busy_timeout` для конкурентной записи многих агентов в один файл журнала.
