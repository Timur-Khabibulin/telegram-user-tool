## 1. Примитивы резерва (ядро)

- [x] 1.1 `src/core/reserve-accounts.ts`: `listReserveAccountsOldestFirst(persona)` (фильтр по префиксу `workspace-reserve-<persona>-`, сортировка по ctime), `computeNextReserveNumber(persona)` (калька `computeNextPoolNumber` со скоупом по персоне), резолвинг `reserveId ⇄ workspace-reserve-<persona>-<K>`
- [x] 1.2 `findValidReserveAccount(persona, log)` — калька `findValidPoolAccount` поверх резерва; валидация/карантин делегируют в `validatePoolAccount`/`quarantinePoolAccount` (без дублирования)

## 2. Реестр инвайт-ссылок

- [x] 2.1 `src/core/db/private-invites.ts`: `rekeyPrivateInviteLink(adminAgentId, fromAgentId, toAgentId)` — перенос строки реестра на новый ключ без вызовов Telegram (сохраняет invite_link/created_at/post_updated); при существующей строке toAgentId — перезапись

## 3. Скилл провижен-в-резерв (третий путь)

- [x] 3.1 `src/features/tg-agent-reserve-provision/staging.ts`: `stagingDir`/`stagingTdataDir`, `writeStagingStatus`, `computeNextReserveNumber`-обвязка, `promoteToReserve(reserveId, accountConfig)` (атомарный rename стейджинг → `workspace-reserve-<persona>-<K>`)
- [x] 3.2 `src/features/tg-agent-reserve-provision/run.ts`: `runReserveProvision({personName, links, twoFaPassword, proxyRegion, maxProxyAttempts})` по образцу `runPoolProvision`; на аккаунт: download → `selectWorkingProxy` → `connectBootstrap` → `prepareAccount(createPublicChannel=false)` → `exportChatInvite`/`upsertPrivateInviteLink` (ключ reserveId) → `createPersonaChannel(..., link)` + `markPostUpdated` → `registerAgenticSession` → `promoteToReserve`; человеко-паузы между аккаунтами
- [x] 3.3 `retryReserveManualCode(reserveId, …)` — повтор только агентской сессии без гигиены (калька `retryPoolManualCode`)
- [x] 3.4 `renderReport` и терминальные статусы (`done`/`proxy_failed`/`setup_failed`/`needs_manual_code`), как у фаз 1/2

## 4. Общая финализация активации

- [x] 4.1 `src/features/persona-account-reserve/activate.ts`: `finalizeActivation(agentId, reserveId, adminAgentId, log)` — выделение шагов 3–4 из `banned-account-replacement/activateAndFinalize` БЕЗ применения персоны и снятия banned: `rekeyPrivateInviteLink(reserveId→agentId)` + `createOrUpdateTask(account-warmup)` + наполнение join-queue из `channel_assignments` + `seedTransitions`
- [x] 4.2 Канал/пост активация не трогает; `applyPersonaToAccount` не вызывается

## 5. Триггер 2 — скилл ручной активации

- [x] 5.1 `runReserveActivate(reserveId, log)` в `activate.ts`: валидация (`validatePoolAccount`, R19) → claim `renameSync(reserve → workspace-agent<N>.incoming)` с `computeNextAgentNumber`+инкремент (калька `claimPoolToNewAgent`) → перепись `accountId=agent<N>` → промоушен → `finalizeActivation` → отчёт
- [x] 5.2 `src/scripts/ops/tg-agent-reserve-activate.ts` (detached, фиксированный таймаут, отчёт в Saved Messages, ADR 0008) + `skills/tg-agent-reserve-activate/SKILL.md`

## 6. Триггер 1 — доработка banned-account-replacement

- [x] 6.1 `replaceOne`: источник = `findValidReserveAccount(persona)` вместо `findValidPoolAccount`; при непригодном — добор следующего той же персоны
- [x] 6.2 Убрать `applyPersonaToAccount` из замены; активация = `claimPoolAccount` (swap.ts без изменений) + `buildIncoming` (username резерва НЕ регенерируется) + `commitSwap` + `finalizeActivation(bannedAgentId, reserveId, …)` + `clearRestriction(banned)` последним
- [x] 6.3 R20: пустой резерв персоны → агент остаётся banned, без фолбэка на обезличенный пул; алерт пер-персонный (`reserve-empty-alerted-<persona>`), сброс флага при непустом резерве персоны; текст алерта «в резерве нет аккаунта персоны <persona>»

## 7. Обёртки, регистрация, скиллы провиженинга

- [x] 7.1 `src/scripts/ops/tg-agent-reserve-provision.ts` (detached, таймаут масштабируется по размеру пачки, отчёт в Saved Messages, ADR 0008)
- [x] 7.2 `index.ts`: регистрация тулов `tg_agent_reserve_provision_run`, `tg_agent_reserve_provision_retry_code`, `tg_agent_reserve_activate` (execute → run.ts/activate.ts напрямую, ADR 0001)
- [x] 7.3 `skills/tg-agent-reserve-provision/SKILL.md` (сбор параметров + detached-запуск через systemd-run, образец `skills/tg-agent-pool-provision/SKILL.md`)

## 8. Документация

- [x] 8.1 Обновить оглавление/указатели при необходимости (`docs/README.md`, `docs/operation.md` — пути резерва и новые скиллы); каталог ошибок уже содержит `USER_RESTRICTED`
