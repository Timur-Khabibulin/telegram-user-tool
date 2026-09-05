## 1. Хранилище: `private-invites.db`

- [x] 1.1 `privateInvitesDbPath(adminAgentId)` в `src/core/config.ts` — `workspaceDir(adminAgentId)/private-invites.db`
- [x] 1.2 `src/core/db/private-invites.ts`: схема `private_invite_links (agent_id TEXT PRIMARY KEY, invite_link TEXT NOT NULL, created_at INTEGER NOT NULL)`, `ensurePrivateInvitesSchema`
- [x] 1.3 `upsertPrivateInviteLink(adminAgentId, agentId, link, createdAt)` — `INSERT ... ON CONFLICT(agent_id) DO UPDATE`
- [x] 1.4 `listPrivateInviteLinks(adminAgentId)` — все строки, для проверки/дебага

## 2. `TelegramService`: новые методы

- [x] 2.1 `exportChatInvite(channelId, { title })` — резолв peer как в `getPendingJoinRequests` (`findChannelPeer` → `getDialogs` fallback), `messages.ExportChatInvite({ peer, requestNeeded: true, title })`, без `usageLimit`/`expireDate`/`subscriptionPricing`, вернуть `{ link }`
- [x] 2.2 `updatePersonalChannelPostLink(link)` — `getOwnPersonalChannel()`, если `null`/нет `postId` → `{ ok: false, reason }`; иначе `client.getMessages(inputPeer, { ids: [postId] })`, убрать строки-URL (`/^https?:\/\/\S+$/` по строкам), добавить `\n<link>\n<link>\n<link>`, `messages.EditMessage`
- [x] 2.3 Обобщить сообщение об ошибке в `getPendingJoinRequests` (`Is agent1 a member?` → без хардкода конкретного агента)

## 3. `funnel-collect.ts`: перенос подсчёта заявок

- [x] 3.1 Импортировать `REPORT_AGENT_ID` из `./config`
- [x] 3.2 Вынести блок заявок (`tg.loadAccount` + `getPendingJoinRequests` + `result.privateNote`/`privateRequestsAbs`) из цикла `for (const agentId of listAgentIds())` в отдельный шаг до цикла, через `REPORT_AGENT_ID`
- [x] 3.3 Посчитать `result.privateRequestsDelta` там же, до цикла, через `getPreviousSnapshot(adminAgentId, adminAgentId)`
- [x] 3.4 Внутри цикла — убрать повторный fetch, использовать посчитанные снаружи `privateAbs`/`result.privateRequestsDelta` в блоке `agentId === adminAgentId` (запись снапшота/агрегата не меняется)
- [x] 3.5 Проверить: сбой шага 3.2 не примешивается к try/catch агента `adminAgentId` внутри цикла — подтверждено: отдельный try/catch вне цикла, независимый от per-agent try/catch этапов 5-7

## 4. OpenClaw-инструмент: `tg_private_invite_links`

- [x] 4.1 Зарегистрировать tool в корневом `index.ts` (рядом с `tg_funnel_report`/`tg_channel_coverage_report`), параметр `agentIds: string[]` (обязательный, список целевых агентов из запроса пользователя). Два идентификатора в этом tool'е не путать: `REPORT_AGENT_ID` — чьей MTProto-сессией выполняются действия (создание ссылки, чтение/правка чужих постов недоступны — только своя), `FUNNEL_ADMIN_AGENT_ID` — под каким `adminAgentId` пишутся данные в `private-invites.db`. Импортировать оба явно, не выводить один из другого.
- [x] 4.2 Шаг 1 — `tg.loadAccount(REPORT_AGENT_ID)`, для каждого `agentId` из списка: `exportChatInvite(FUNNEL_PRIVATE_CHANNEL_ID, { title: agentId })`, затем **`upsertPrivateInviteLink(FUNNEL_ADMIN_AGENT_ID, agentId, link, now)`** — первый аргумент строго `FUNNEL_ADMIN_AGENT_ID`, не `REPORT_AGENT_ID` и не переменная текущего `tg.loadAccount()`; накопить результат. Каждая попытка логируется: `log.info` на успех (с самой ссылкой), `log.warn` на ошибку — тег `[tg_private_invite_links]`
- [x] 4.3 Шаг 2 — для каждого `agentId` из списка: `tg.loadAccount(agentId)` (переключает `tg` на **самого целевого агента**, не `REPORT_AGENT_ID` и не `FUNNEL_ADMIN_AGENT_ID`), `updatePersonalChannelPostLink(link)`, накопить успех/`reason` при пропуске; ошибка одного агента не прерывает остальных (try/catch на итерацию). Каждая попытка логируется: `log.info` на успех, `log.warn` на пропуск/ошибку — тот же тег `[tg_private_invite_links]`
- [x] 4.4 Вернуть `{ text, result }` — реализовано как `{ text, created, inserted, createErrors, insertSkipped }` (структурные поля вместо одного `result`, чтобы разделить успех/ошибки по шагам без вложенности)
- [x] 4.5 `skills/private-invite-links/SKILL.md` — по конвенции `skills/funnel-report/SKILL.md`: `name`, `description` (когда вызывать), инструкция по параметру `agentIds`

## 5. Документация

- [x] 5.1 `docs/configuration.md` — добавить `private-invites.db`/`REPORT_AGENT_ID`-как-администратора-канала, если там описывается эта роль
- [x] 5.2 `docs/operation.md` — добавить `private-invites.db` в таблицу «Данные агента» (только у `FUNNEL_ADMIN_AGENT_ID`)
