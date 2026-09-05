## Why

Админ канала может забанить аккаунт агента на запись. После этого монитор при
попытке ответить получает `CHAT_WRITE_FORBIDDEN`, но продолжает каждый цикл
заходить в канал и пытаться писать — впустую тратит флуд-бюджет аккаунта, копит
ошибки и шумит в отчёте. Сейчас система ошибку только логирует, но не реагирует:
забаненные каналы остаются в работе агента. Нужно выходить из таких каналов и
убирать их из данных агента.

## What Changes

- Монитор начинает различать именно `CHAT_WRITE_FORBIDDEN` (а не любую не-flood
  ошибку ответа) и ставит такой канал в новую per-agent очередь `banned_channels`.
- Новый скилл `leave-banned-channels` (per-agent, в диспетчере) обрабатывает
  очередь: выходит из канала (`leaveChannel`), полностью удаляет рабочие данные
  агента по этому каналу, помечает канал забаненным в реестре, чистит очередь.
- Новый метод `leaveChannel(chatId)` в `TelegramService` (MTProto
  `channels.LeaveChannel`) + резолв username по `chatId`.
- В реестр `discovered_channels` добавляется колонка `banned_at`; строка канала
  и `assigned_agent` сохраняются (видно, какой агент забанен).
- Триггер — **только** `CHAT_WRITE_FORBIDDEN`. Прочие ошибки ответа
  (`reply_failed`, `flood_wait`, `peer_id_invalid`) ведут себя как раньше.

## Capabilities

### New Capabilities

- `leave-banned-channels`: очередь `banned_channels`, скилл-гигиена (выход из
  канала, полная чистка данных агента по `chatId`, пометка `banned_at` в
  реестре, самоочистка очереди), метод `leaveChannel`.

### Modified Capabilities

- `group-monitoring`: монитор различает `CHAT_WRITE_FORBIDDEN` отдельно от
  прочих не-flood ошибок ответа и кладёт `chatId` в `banned_channels`.

## Impact

- Код: `src/core/telegram/service.ts` (новый `leaveChannel` + резолв username),
  `src/skills/monitor.ts` (детект `CHAT_WRITE_FORBIDDEN`), новый скилл
  `src/skills/leave-banned-channels.ts`, `src/scripts/dispatcher.ts`
  (регистрация скилла), `src/core/db/channels.ts` (таблица `banned_channels` +
  функция полной чистки данных по `chatId`), `src/core/db/discovery.ts`
  (колонка `banned_at` + пометка).
- Данные: новая per-agent таблица `banned_channels` в `tg-channels.db`; новая
  колонка `banned_at` в `discovered_channels` (`discovery.db`). Аддитивные
  миграции, без потери данных.
- Зависит от детекта ошибок отправки из `funnel-tracking-stages` (уже
  задеплоен): монитор уже ловит не-flood ошибки ответа, здесь добавляется
  только различение конкретного `CHAT_WRITE_FORBIDDEN`.
- Необратимость: выход из канала и удаление данных агента по каналу —
  необратимы (повторное вступление в публичный канал возможно, но история
  данных не восстанавливается). Срабатывает только по подтверждённому
  `CHAT_WRITE_FORBIDDEN`.
