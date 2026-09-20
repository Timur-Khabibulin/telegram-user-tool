## Why

Платформа узнаёт о невозможности писать в канал только постфактум — из ошибки
отправки `CHAT_WRITE_FORBIDDEN`, и сваливает в один `status='banned'` два разных
случая: «писать нельзя никому» (структурно) и «забанен именно наш аккаунт». Из-за
этого суточная авторотация переносит структурно закрытые каналы между аккаунтами
вхолостую (по данным за 14 дней ~24% ротируемых каналов не смог написать ни один
аккаунт). Требования и архитектура согласованы в
`docs/design/channel-write-access/requirements-v1.md` и
`docs/design/channel-write-access/architecture.md`.

## What Changes

- **Новая способность `channel-write-access`**: проактивно определять право агента
  писать в канал (при вступлении и перед фазой отправок), различать причину по
  фиксированному перечню и использовать её в решении «ротация vs read-only».
- **Модель данных** (`channels`): две колонки — `write_access_reason` (TEXT NULL,
  единый признак «писать нельзя» + причина) и `write_access_until` (INTEGER NULL,
  `until_date` справочно). Тип причины (постоянная/переменная) выводится функцией
  `isPermanentReason ∈ {members_restricted, paid}`, не хранится.
- **Монитор (`group-monitoring-v5`)**: перед фазой отправок — живой
  `GetParticipant(self)` один раз на канал за прогон; классификация сигналов и кодов
  send-ошибок в причины (новый чистый модуль `src/core/write-access.ts`); при
  зафиксированном «писать нельзя» отправки по каналу в этом прогоне не инициируются
  (уже обеспечено существующим потоком `ChannelSkipError`). Ветку
  `allow_payment_required` перевести с `format_error` на `write_access_reason='paid'`
  в общем обработчике `core/post-comment-send.ts` (реактивный дом v5).
- **Вступление (`join-queue`)**: разово снимать постоянную величину
  (`default_banned_rights` группы обсуждения) из уже выполняемого `GetFullChannel`,
  без доп. вызова.
- **Гейт ротации** остаётся на существующем механизме: переменная причина →
  `status='banned'` → `leave-banned-channels` → `leaved_from_banned` → ротация;
  постоянная причина → `status` не трогаем → канал остаётся read-only и продолжает
  читаться. Код `channel-rotation` НЕ меняется.

## Capabilities

### New Capabilities
- `channel-write-access`: определение, хранение и классификация права аккаунта писать
  в канал; правило «постоянная причина → read-only, переменная → кандидат на ротацию».

### Modified Capabilities
- `group-monitoring-v5`: перед отправкой — живой pre-check права записи (раз на канал
  за прогон), реактивная классификация send-ошибок в причины, `allow_payment_required`
  → причина `paid` вместо `format_error`.
- `join-queue`: при успешном вступлении разово фиксировать постоянную величину права
  записи из `default_banned_rights` группы обсуждения.
- `channel-operations-history`: в событие `status_change` перехода в `banned`
  добавить причину права записи (`attrs.reason`) — для прямого churn-анализа причин
  бана по журналу.

## Impact

- **Схема БД**: `channels` — 2 новые nullable-колонки (`write_access_reason`,
  `write_access_until`); аддитивная миграция.
- **Код**: новый `src/core/write-access.ts` (чистая классификация сигнал/ошибка →
  причина); правки `src/skills/monitor-v5.ts` (pre-check шаг 5.3c + гейт фаз отправок),
  `src/core/post-comment-send.ts` (реактивная классификация + ветка `paid` — общий
  обработчик отправки v5), `src/skills/join-queue.ts` (захват постоянной величины при
  join), новый метод `getSelfParticipant` + проброс `defaultBannedSendMessages` в
  `src/core/telegram/service.ts`.
- **Без изменений**: `src/features/channel-rotation/` и `leave-banned-channels`
  (гейт обеспечивается тем, ставится ли `status='banned'` выше по потоку).
