---
name: project_tg_agent_autoregistration_setup_mtproto_calls
description: tg-agent-autoregistration explore — точная карта MTProto-вызовов для подготовки аккаунта (2FA/сессии/профиль/др/канал/pinned channel), подтверждено node_modules/telegram + core.telegram.org
type: project
---

Задача: tg-agent-autoregistration (explore-режим) — вторая половина роли `TData`
(см. [[project_tg_agent_autoregistration_variant_a2_mtcute_convert]] про расшифровку
tdata): сами MTProto-вызовы подготовки аккаунта после получения bootstrap-сессии.
Этого кода нет нигде в `src/core/telegram/service.ts` — пишется с нуля.

Все факты подтверждены прямым чтением `node_modules/telegram/**/*.d.ts`/`*.js` этого
проекта (GramJS) и официальной документации core.telegram.org (2026-08-12).

**1. Смена 2FA — не сырой Api-вызов, а готовый клиентский хелпер GramJS:**
`client.updateTwoFaSettings({ currentPassword, newPassword, hint })` —
`node_modules/telegram/client/2fa.ts`/`.d.ts`. Внутри сам делает
`account.GetPassword()` → `computeCheck(pwd, currentPassword)` (SRP,
`node_modules/telegram/Password.ts`, экспортирует `computeCheck`/`computeDigest` —
писать SRP руками не нужно) → `account.UpdatePasswordSettings({password,
newSettings: account.PasswordInputSettings({newAlgo: pwd.newAlgo, newPasswordHash:
computeDigest(pwd.newAlgo, newPassword), hint})})`. Бросает `PASSWORD_HASH_INVALID`
при неверном `currentPassword`. Диаграммный ярлык `updateTwoFaSettings` — это
буквально имя этого метода клиента, не абстракция.

**2. Сброс сессий:** `client.invoke(new Api.auth.ResetAuthorizations())` —
"Terminates all user's authorized sessions except for the current one"
(core.telegram.org/method/auth.resetAuthorizations). **Подтверждённое
ограничение:** ошибка 406 — "You can't logout other sessions if less than 24 hours
have passed since you logged on the current session". `auth.dropTempAuthKeys` — **не
то же самое**, это про temp-ключи Perfect Forward Secrecy, к сессиям устройств
отношения не имеет (не рассматривать как альтернативу).

**3. Профиль — два независимых вызова, подтверждено:**
`Api.account.UpdateProfile({firstName?, lastName?, about?})` и отдельно
`Api.account.UpdateUsername({username})`. Разные поля, разные RPC, вызываются
отдельно.

**4. Дата рождения — реальный, недавний метод API, подтверждено:**
`Api.account.UpdateBirthday({birthday: new Api.Birthday({day, month, year?})})`
(core.telegram.org/method/account.updateBirthday, Layer 223). Ошибка
`BIRTHDAY_INVALID` при возрасте вне 0–150 лет. Ограничений на частоту смены в
документации нет.

**5. Фото профиля — паттерн для R-5 (все `photo_profile_N` по очереди) уже есть в
JSDoc-примере пакета:** `const file = await client.uploadFile({file: buffer,
workers: 1})` → `client.invoke(new Api.photos.UploadProfilePhoto({file}))`, вызывать
в цикле по одному разу на файл. Ограничение из доки: `ALBUM_PHOTOS_TOO_MANY` (точное
число не документировано).

**6. Канал:** `Api.channels.CreateChannel({broadcast: true, title, about})` →
`Api.TypeUpdates`. Паблик-юзернейм — **отдельный** вызов
`Api.channels.UpdateUsername({channel, username})`, не параметр создания. Пост —
`Api.messages.SendMessage({peer: channel, message})`.

**7. "Закреплённый канал профиля" — существует, вопрос координатора закрыт:**
`Api.account.UpdatePersonalChannel({channel})` (core.telegram.org/method/
account.updatePersonalChannel) — "Associate (or remove) a personal channel, that
will be listed on our personal profile page". **Требование:** `channel` должен быть
broadcast-каналом — supergroup вызовет `PUBLIC_BROADCAST_EXPECTED`. Значит порядок
обязателен: сначала `createChannel`(+`updateUsername`), потом
`updatePersonalChannel` с готовым каналом — это логический вывод из типа параметра
(нужен существующий канал), не отдельно задокументированная последовательность в
API-доке.

**Не подтверждено / требует спайка на реальных данных:**
- Численные пороги `ALBUM_PHOTOS_TOO_MANY` и `CHANNELS_TOO_MUCH` — не
  задокументированы Telegram.
- Сработает ли 24-часовое ограничение `auth.resetAuthorizations` на конкретных
  закупленных tdata-аккаунтах — зависит от их реального возраста логина, не
  проверялось на живых данных.
- Общее поведение `FLOOD_WAIT_X` для этой последовательности вызовов подряд на одном
  аккаунте — не измерялось.

**Why:** координатор явно просил ту же строгость, что и для расшифровки tdata — ни
одного метода/поля не называть по памяти/аналогии, только прямым чтением
`node_modules/telegram` и core.telegram.org.

**How to apply:** при реализации `src/core/tdata/` (см. компонент `TData` в
architecture.md) — использовать `client.updateTwoFaSettings()` как есть (не писать
SRP вручную), вызывать методы в порядке 2→3→4→5→6→7 (сброс сессий до профиля —
координатор явно решил в architecture.md §2.2, что `resetAuthorizations` идёт до
появления агентской сессии; порядок профиль/фото/канал между собой в этом разговоре
не фиксировался, но `updatePersonalChannel` обязан идти строго после
`createChannel`+`updateUsername`).

См. также [[project_tg_agent_autoregistration_tdata_risk]],
[[project_tg_agent_autoregistration_variant_a2_mtcute_convert]].
