## Why

Публичный канал персоны создаётся в фазе 2 (`tg-agent-persona-deploy`) на только что
зарегистрированной агентской сессии, и Telegram отклоняет `channels.CreateChannel`
ошибкой `USER_RESTRICTED` (403) — создание публичного канала с «свежей» сессии
ограничено. Старый скилл `tg-agent-autoregistration` создавал канал на bootstrap-сессии
из tdata (обжитой) и ошибок не давал. Подтверждено по прогонам: 403 возникает только на
`CreateChannel`, `account.UpdateUsername` на той же свежей сессии проходит, а аккаунты,
чья агентская сессия отлежалась ~6 суток, канал создают нормально.

## What Changes

- **Фаза 1 (`tg-agent-pool-provision`)** создаёт **шаблонный публичный канал** на
  bootstrap-сессии (tdata): `channels.CreateChannel` + публичный username + placeholder
  название/фото/пост. Канал обезличен (персона в фазе 1 неизвестна).
- Публичный username канала — **самостоятельный**: случайный человекочитаемый
  (сочетание слов из словаря, без цифрового хвоста), не производный от username аккаунта
  (больше не `${username}_ch`), к персоне не привязан. Клейм с ретраем при коллизии
  (`USERNAME_OCCUPIED`). username задаётся финальным в фазе 1 и в фазе 2 не меняется.
- **Фаза 2 (`tg-agent-persona-deploy`)** больше не создаёт канал, а **правит уже
  существующий**: название → `channelName`, описание, фото, замена шаблонного поста на
  персональный с инвайт-ссылкой в приватный канал воронки, привязка к профилю.
- Шаг работы с каналом становится **самоадаптирующимся**: найти свой публичный канал
  (`channels.GetAdminedPublicChannels`) → есть, править; нет — создать (прежнее
  поведение). Это сохраняет работоспособность `banned-account-replacement` и пул-аккаунтов,
  созданных до этого изменения (без шаблонного канала).
- **Зачистка истории:** служебные сообщения о смене названия/фото, порождённые правками
  в фазе 2, удаляются (`channels.deleteMessages`). Служебное `messageActionChannelCreate`
  («канал создан») документацией отнесено к неудаляемым и остаётся — это событие создания,
  не изменения данных.

## Capabilities

### New Capabilities
<!-- нет новых способностей — меняется поведение существующих -->

### Modified Capabilities
- `tg-agent-pool-provision`: фаза 1 дополнительно создаёт шаблонный публичный канал на
  bootstrap-сессии с самостоятельным случайным человекочитаемым username (ретрай на
  коллизию); пул-аккаунт теперь «обезличенный, но с шаблонным каналом».
- `tg-agent-persona-deploy`: фаза 2 не создаёт канал, а правит существующий (название/
  описание/фото/пост + инвайт-ссылка + привязка к профилю), username канала не трогает,
  зачищает служебные сообщения об изменениях; шаг работы с каналом — «найти → править,
  иначе создать».

## Impact

- Код: `src/core/tdata/account-setup.ts` (`createPersonaChannel` → разделение на создание
  шаблона и правку существующего; `prepareEmptyPoolAccount` добавляет шаг создания канала;
  генератор username канала), `src/features/persona-apply/apply-persona.ts`,
  `src/features/tg-agent-pool-provision/run.ts`, `src/features/tg-agent-persona-deploy/run.ts`.
- Смежный потребитель: `src/features/banned-account-replacement/run.ts` использует общий
  `applyPersonaToAccount` — поведение сохраняется за счёт «найти → править, иначе создать».
- Telegram API: `channels.CreateChannel`, `channels.UpdateUsername`,
  `channels.GetAdminedPublicChannels`, `channels.EditTitle`, `channels.EditPhoto`,
  `channels.deleteMessages`, `account.UpdatePersonalChannel`.
- Данные/конфиг: новых полей в `tg-account.json` не требуется — канал находится через
  `GetAdminedPublicChannels` (у аккаунта после гигиены фазы 1 ровно один публичный канал).
- Документация: `docs/telegram-errors.md` (поведение на `USER_RESTRICTED`),
  спеки `tg-agent-pool-provision` и `tg-agent-persona-deploy`.
