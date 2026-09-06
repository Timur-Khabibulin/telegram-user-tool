## Why

Воронка по агентам с `monitor-v5` вскрыла два дефекта жизненного цикла каналов,
из-за которых агент теряет доступные для мониторинга каналы:

1. **Статус залипает после повторного вступления.** При повторном join
   `upsertChannelIdentityFromJoin` обновляет только identity-поля и не трогает
   `status`. Канал, ранее помеченный `leaved_manual`, остаётся `leaved_manual`,
   хотя агент снова участник — и монитор его игнорирует (198 строк).
2. **Sync безвозвратно удаляет строку.** `syncChannels` делает `DELETE`, если
   Telegram не вернул канал в диалогах. Это теряет историю/метрики и делает канал
   невосстановимым, даже если исчезновение временное (промах листинга диалогов,
   а не реальный выход). 498 записей `join_queue.status='joined'` не имеют строки
   в `channels.db`.

## What Changes

- **Новый статус `not_found`** в `channels.status` — канал, которого Telegram не
  вернул в диалогах, но который агент не покидал осознанно. Исключается из
  мониторинга и подсчёта активных, но НЕ ставится в очередь на выход.
- **Sync не удаляет строки (BREAKING поведение `syncChannels`).** Пропавший из
  диалогов канал с активным статусом (`null`/`only_comment`/`sleep`/`format_error`)
  переводится в `not_found`; канал с терминальным статусом
  (`banned`/`suspend`/`leaved_*`/`should_leave`) не трогается. `DELETE` убирается
  полностью. Появление канала в диалогах со статусом `not_found` возвращает его
  в `null`.
- **`USER_ALREADY_PARTICIPANT` — путь восстановления, а не ошибка.** join
  трактует «уже участник» как успех: возвращает identity, строка канала
  создаётся/обновляется. Тег уходит из ветки `error`.
- **Успешное вступление обновляет строку полностью.** upsert при join сбрасывает
  `status` в `null` (всегда, включая `banned`), очищает
  `statusUpdatedAt`/`statusDurationSeconds`/`status_description`, освежает
  `title`/`chatUsername`/identity — вместо прежнего обновления одних
  identity-полей.
- **Разовая миграция БД** (ops-скрипт, только агенты с `monitor-v5`): сброс
  залипших `leaved_manual` в `null` (~198), сброс `only_comment` без joined-записи
  в `null` (~59), перевод потерянных joined-записей в `join_queue.status='pending'`
  для повторного вступления (~498). Порядок деплоя критичен: сначала код, потом
  миграция.

## Capabilities

### New Capabilities
<!-- Нет новых capability: изменяются существующие. -->

### Modified Capabilities
- `group-monitoring`: схема `channels.status` расширяется значением `not_found`;
  `not_found` исключается из батча мониторинга и подсчёта активных; `syncChannels`
  больше не удаляет строки — ставит `not_found` активным пропавшим каналам,
  сохраняет терминальные статусы и снимает `not_found` при повторном появлении
  канала в диалогах. (Свойство общей `syncChannels`, применяется ко всем версиям
  монитора, не только `monitor-v5`.)
- `join-queue`: `USER_ALREADY_PARTICIPANT` становится успехом-восстановлением
  (возврат identity, upsert строки), а не `error`; успешное вступление делает
  полный upsert строки со сбросом `status` в `null`.

## Impact

- **Код**: `src/core/db/channels.ts` (тип `ChannelStatus`, `syncChannels`,
  `upsertChannelIdentityFromJoin`, фильтры `getChannelsBatch` и подсчёта активных),
  `src/core/telegram/service.ts` (`joinDiscussionGroups` — обработка
  `USER_ALREADY_PARTICIPANT`), `src/skills/join-queue.ts` (`JOIN_ERROR_TAGS`).
- **Данные**: `channels.db` каждого агента (значения `status`), `tg-join-queue.db`
  (перевод части записей в `pending`). Схема не меняется — `status` уже `TEXT`.
- **Разовый ops-скрипт**: `src/scripts/ops/` — миграция cat4/cat5/cat7, запуск на
  VPS после деплоя кода.
- **Обратная совместимость**: строки `channels` больше не исчезают — потребители,
  полагавшиеся на удаление (нет таких в коде), не затрагиваются; накопление
  терминальных/`not_found` строк — сознательное решение (история сохраняется).
