# Design — tg-autoreg-optional-channel-and-setup-skill

## D1 — Флаг `createPublicChannel` делает шаг канала условным

`createPersonaChannel` (шаг 6 `prepareAccount`) вызывается только при
`createPublicChannel === true`. Остальные шаги (очистка, 2FA, сброс сессий,
профиль, фото, username) — без изменений и в обоих режимах. Профиль/фото
persona-derived, поэтому персона нужна на реге в любом режиме (см. D4).

Значение флага прокидывается: тул `index.ts` → `RunParams` → `processAccount` →
`prepareAccount(client, template, twoFaPassword, username, log, createPublicChannel)`.

## D2 — Новый скилл создаёт канал через сессию агента

Отдельный тул `tg_agent_channel_setup(agentIds: string[])`. Для каждого agentId:
1. `loadAccountConfig(agentId)` — из `~/.openclaw/workspace-<agentId>/tg-account.json`
   (sessionString, proxy, username, persona).
2. Подключение через `TelegramService` по сохранённой сессии агента (НЕ bootstrap
   tdata — рега уже прошла, tdata может отсутствовать).
3. Guard (D3): если у агента уже есть personal/pinned-канал — статус `skipped`,
   не создаём.
4. Иначе — `createPersonaChannel(client, template, username, log)` (та же уже
   вынесенная функция, что в реге).

Batch-изоляция: ошибка/скип одного агента не останавливает остальных — по каждому
свой статус (`done` / `skipped` / `failed`), сводка в конце (как у autoreg).

## D3 — Guard по существующему каналу (skip, не пересоздание)

Перед созданием проверяем, установлен ли у аккаунта personal-канал
(`account.getPersonalChannel` / наличие админского публичного канала). Если да —
`skipped`. Это делает повторный прогон на пачке безопасным: не плодит дубли и не
упирается в `CHANNELS_ADMIN_PUBLIC_TOO_MUCH`. Безусловного пересоздания нет
(осознанно — подтверждено).

## D4 — Персона выбирается на реге и персистится

Персона задаётся параметром реги (шаг 1) и пишется в `tg-account.json.persona`
(имя = папка шаблона `~/.openclaw/personas/<persona>`). Новый скилл читает её оттуда и сам
резолвит шаблон — отдельного параметра персоны у скилла нет. Это единственный
источник истины о персоне агента.

## D5 — Приватные ссылки вне скоупа

Создание/вставка приватных инвайт-ссылок остаётся существующим скиллом
`private-invite-links` (`tg_private_invite_links`), запускаемым отдельным (третьим)
шагом после создания каналов. Новый скилл их не касается — только публичный канал.

## Открытые вопросы реализации (не блокеры)

- Точный способ проверки «канал уже есть» (`account.getPersonalChannel` vs
  `channels.getAdminedPublicChannels`) — уточнить по api.d.ts на реализации.
- Значение по умолчанию `createPublicChannel` у тула (явно требовать vs default
  `true` для совместимости с текущим поведением) — решить на реализации.
