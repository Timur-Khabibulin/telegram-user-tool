---
name: project_tg_agent_autoregistration_cleanup_calls
description: tg-agent-autoregistration explore — точные MTProto-вызовы для очистки купленного tdata-аккаунта (фото, паблик-каналы) перед настройкой персоны; проверка утверждения координатора про конфликт с updatePersonalChannel
type: project
---

Задача: tg-agent-autoregistration (explore-режим). Координатор добавил требование —
удалить у купленного tdata-аккаунта существующие фото профиля и публичные каналы
(наследие прошлого использования сессии) до подготовки персоны, утверждая, что это
нужно для `account.UpdatePersonalChannel` (см.
[[project_tg_agent_autoregistration_setup_mtproto_calls]], пункт 7).

Все факты подтверждены двумя независимыми источниками: `node_modules/telegram/tl/api.d.ts`
(GramJS в этом проекте) и core.telegram.org/method/* (2026-08-12), Layer 223.

**1. Удаление фото профиля — подтверждено, два вызова:**
- `Api.photos.GetUserPhotos({userId, offset, maxId, limit})` → `photos.TypePhotos`.
  Ошибки: `CHANNEL_PRIVATE`, `MAX_ID_INVALID`, `MSG_ID_INVALID`, `USER_ID_INVALID`.
- `Api.photos.DeletePhotos({id: Api.TypeInputPhoto[]})` → `long[]` (id успешно удалённых
  фото). `TypeInputPhoto = InputPhotoEmpty | InputPhoto`, где
  `InputPhoto{id: long, accessHash: long, fileReference: bytes}` — это не тот же объект,
  что `Photo` из ответа `getUserPhotos`; нужна конвертация (в GramJS есть хелпер
  `Utils.getInputPhoto(photo)`, `node_modules/telegram/Utils.d.ts`, не проверялась
  сигнатура детально — подтверждено только его существование). Официальных ошибок для
  `deletePhotos` не задокументировано; "Only users can use this method" (не боты — не
  применимо, у нас всегда user-аккаунт).

**2. Обнаружение публичных каналов аккаунта — подтверждено:**
`Api.channels.GetAdminedPublicChannels({byLocation?, checkLimit?, forPersonal?})` →
`messages.TypeChats` (`messages.chats`/`messages.chatsSlice`, `Chat[]`). Официальное
описание: "channels, supergroups, geogroups where the user holds admin privileges…
typically invoked when user exceeds ownership limit for public channels and must remove
one". Флаг `forPersonal` — **буквально документирован под этот сценарий**: "Set this
flag to only fetch the full list of channels that may be passed to
account.updatePersonalChannel" — то есть предзапрос списка кандидатов для
`updatePersonalChannel` — это официальный, а не самодельный паттерн.
`messages.getAllChats` — не то же самое (весь список диалогов, не только
admin/public); не подтверждён как использовавшийся здесь.

**3. Что делать с найденными каналами — два инструмента, подтверждены оба:**
- `Api.channels.UpdateUsername({channel, username: ""})` → `Bool`. Освобождает
  юзернейм, канал остаётся, подписчики не теряются. Ошибки:
  `CHANNELS_ADMIN_PUBLIC_TOO_MUCH`, `CHANNEL_INVALID`, `CHANNEL_PRIVATE`,
  `CHAT_ADMIN_REQUIRED`, `CHAT_NOT_MODIFIED`, `CHAT_WRITE_FORBIDDEN`,
  `USERNAME_INVALID`, `USERNAME_NOT_MODIFIED`, `USERNAME_OCCUPIED`,
  `USERNAME_PURCHASE_AVAILABLE`.
- `Api.channels.DeleteChannel({channel})` → `Api.TypeUpdates`. Официальное описание:
  "permanently deleted along with all its message history for the user performing the
  deletion" — **не подтверждено буквально в доке, что удаляет канал у ВСЕХ подписчиков**
  (текст страницы говорит "for the user performing the deletion", не "for all
  subscribers"; координатор в предыдущем ответе интерпретировал это как необратимое
  удаление для всех — эта деталь требует отдельной проверки, если важна, не додумывать).
  Ошибки: `CHANNEL_INVALID`, `CHANNEL_PRIVATE` (406), `CHANNEL_TOO_LARGE` (406, порог
  1000 участников — выше нельзя удалить), `CHAT_ADMIN_REQUIRED`, `CHAT_NOT_MODIFIED`,
  `CHAT_WRITE_FORBIDDEN`.
  `updateUsername("")` — обратимая, менее разрушительная операция и напрямую снимает
  ограничение `CHANNELS_ADMIN_PUBLIC_TOO_MUCH`; `deleteChannel` — необратима и требует
  явного подтверждения человека по принципу проекта (`agent-playbook.md`:
  "Необратимое… выполнять только с явного подтверждения человека").

**4. Проверка утверждения координатора — ЧАСТИЧНО подтверждено, но НЕ так, как он
сформулировал:**
- `account.UpdatePersonalChannel` документирует только одну ошибку:
  `PUBLIC_BROADCAST_EXPECTED` ("channel parameter only accepts a channel, not a
  supergroup"). **Нет никакого документированного конфликта с наличием ДРУГИХ
  публичных каналов у аккаунта.** Ставить в личный канал профиля можно любой
  существующий broadcast-канал аккаунта независимо от того, сколько ещё публичных
  каналов у него есть — сам вызов лимита на них не проверяет.
- Реальный технический конфликт — **не в `updatePersonalChannel`, а на шаге СОЗДАНИЯ
  публичного юзернейма** (`channels.UpdateUsername`, вызывается при создании нового
  канала для персоны, см. пункт 6 в
  [[project_tg_agent_autoregistration_setup_mtproto_calls]]): ошибка
  `CHANNELS_ADMIN_PUBLIC_TOO_MUCH` — "You're admin of too many public channels, make
  some channels private to change the username" — это **числовой лимит на количество
  публичных каналов/супергрупп, которыми аккаунт админит одновременно**, точное число
  не задокументировано (config-константа на сервере), но сам факт лимита и текст
  ошибки — задокументированы.

**Вывод:** координатор прав насчёт риска, но причинно-следственная связь другая, чем
он сформулировал: **проблема не в `updatePersonalChannel`, а в том, что создание НОВОГО
публичного канала персоны (`channels.updateUsername` при создании канала) упадёт с
`CHANNELS_ADMIN_PUBLIC_TOO_MUCH`, если унаследованные от tdata старые публичные каналы
уже заняли лимит**. Если старых публичных каналов у аккаунта меньше лимита — можно
пропустить очистку каналов и очистка не нужна для этого конкретного шага. Точное число
лимита не задокументировано Telegram — при спайке на реальных tdata-аккаунтах нужно
эмпирически проверять `getAdminedPublicChannels({checkLimit: true})`, который по доке
явно предназначен вернуть ошибку лимита без побочных эффектов, если лимит уже
достигнут.

**Not confirmed / needs spike:**
- Точное число лимита `CHANNELS_ADMIN_PUBLIC_TOO_MUCH`.
- Действительно ли `channels.deleteChannel` удаляет канал у всех подписчиков или
  только "для выполняющего удаление" — текст доки двусмысленный, не проверялось живым
  вызовом.
- Точная сигнатура `Utils.getInputPhoto()` в GramJS (существование подтверждено,
  детали — нет).

**Why:** координатор явно просил ту же строгость (первоисточники, не по памяти),
что и для tdata-расшифровки и для setup-вызовов — не выдумывать причинно-следственную
связь, если она не в источниках
([[feedback_dont_override_requirements_from_code_inference]] — не отбрасывать
буквальное требование координатора, но здесь наоборот: не подтверждать причину,
которую он назвал, бездумно, а найти настоящую).

**How to apply:** при написании requirements-v1.md/architecture.md для очистки
аккаунта — не привязывать очистку каналов к `updatePersonalChannel` буквально, а
привязать к шагу создания нового публичного канала персоны (`channels.updateUsername`
при создании). Предпочесть `updateUsername("")` (обратимо) вместо `deleteChannel`
(необратимо, требует подтверждения человека) как метод очистки по умолчанию.

См. также [[project_tg_agent_autoregistration_setup_mtproto_calls]],
[[project_tg_agent_autoregistration_tdata_risk]],
[[project_tg_agent_autoregistration_variant_a2_mtcute_convert]].
