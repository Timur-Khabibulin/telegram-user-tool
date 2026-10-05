---
name: project_tg_agent_pool_provisioning_architecture
description: tg-agent-pool-provisioning design — splits autoreg monolith into phase1 (pool producer) + phase2 (persona consumer); phase2 persona-apply IS banned-replacement's code; code gotchas for dev A–H
metadata:
  type: project
---

Фича «расщепление авторегистрации на пул + развёртывание персоны». Требования —
`docs/design/tg-agent-pool-provisioning/requirements-v1.md` (R1–R30). Архитектура НАПИСАНА —
`docs/design/tg-agent-pool-provisioning/architecture.md`. Монолит `tg-agent-autoregistration`
(mode A/B) и `persona-channel-setup` → DEPRECATED, заменяются фазой 1 (продюсер пула
`workspace-emptyAccount<K>`) и фазой 2 (потребитель → `workspace-agent<N>`). Один OpenSpec change.

**Главный архитектурный факт (определяет всё):** persona-часть фазы 2 и persona-часть
`banned-account-replacement` — ОДИН И ТОТ ЖЕ КОД. R20 прямо требует паритета устройства
каналов. В коде уже есть `banned-account-replacement/run.ts:activateAndFinalize` шаги 1-2
(`setupReplacementAccount` + инвайт). Решение — вынести в общий `applyPersonaToAccount`, звать
из обоих потребителей. Это же закрывает R28 (username персоны при замене) и dev-развилку D.

**Находки по коду (источник истины, ветка refactoring-2):**
- `core/tdata/account-setup.ts` уже содержит ДВА тела: `prepareAccount` (монолит) и
  `setupReplacementAccount` (persona без 2FA/сброса сессий, сессией агента). Шов dev A/B уже
  прорезан. Фаза 1 = гигиена = новый экспорт `prepareEmptyPoolAccount` (deleteAdminedPublicChannels
  → change2FA → resetOtherSessions) — тело prepareAccount без фото и персоны. Фаза 2 = зовёт
  `setupReplacementAccount` как есть.
- **dev E crux:** `loadAccountConfig` (`config.ts:520`) БРОСАЕТ, если нет `persona`. А
  `TelegramService.loadAccount` (`service.ts:288`) зовёт именно его. Пул теперь безымянный (без
  persona/username, R10) → валидация пула `tg.loadAccount(poolId)` упадёт. Рекомендация E-a:
  `AccountConfig.persona?` опционально + параметр `loadAccountConfig(id,{requirePersona=true})`
  (дефолт строгий — рабочий контур fail-fast сохранён), `loadAccount(poolId,{pool:true})`.
  Все 40+ читателей `.persona` работают по listAgentIds (пул туда не входит) — безопасно.
  accountId пула = "emptyAccount<K>" (не плейсхолдер "default" — иначе один clientKey на два пула).
- **dev D:** `swap.ts:buildIncoming:101` копирует username ИЗ пула. Пул безымянный → отменяет
  прежнее banned-replacement M4 («username из пула»). Замена теперь ГЕНЕРИТ username из персоны
  заменяемого (`generateUsername(nick)`), как фаза 2.
- **dev C (oldest-first, R29):** `listPoolAccountIds()` возвращает порядок fs.readdirSync (не
  старейший). «Старейший» ≠ метка K (R11 переиспользует метки) → якорь = `ctimeMs` каталога.
  Новый `listPoolAccountsOldestFirst`. banned-replacement.findValidPoolAccount перевести на него.
  claim вынести из swap.ts в общий `core/pool-accounts.ts` (`claimPoolAccountTo(poolId, destDir)`),
  т.к. dest у замены (`.incoming`) и фазы 2 (`staging/agent<N>`) разный; атомарный renameSync = мьютекс.
- **dev F:** apiId/apiHash/2fa переезжают из папки персоны (`persona-template.ts:128/137`
  `default_agent_data.json`) в `~/.openclaw/account-defaults/` (репо `persona/account-defaults/`),
  читает ТОЛЬКО фаза 1 (R27). Из `PersonaTemplate` убрать `defaultAgentData`. Персоны уже
  переехали под `persona/` в репо (git-статус).
- **dev G:** нумерацию K считать по СЫРЫМ base-именам `workspace-emptyAccount<K>*` (вкл. `.invalid`/
  `.incoming`), не по listPoolAccountIds — иначе переиспользованная метка (R11) столкнётся с
  карантинным каталогом.

**Решения координатора по всем развилкам §12 (закрыты 2026-09-20, зафиксированы в architecture.md):**
- **E = E-b** (НЕ E-a): отдельный строгий `loadPoolAccountConfig`/`PoolAccountConfig` для пула;
  общий `loadAccountConfig` НЕ ослабляется (остаётся требовать persona). `loadAccount(id,{pool:true})`
  ветвится на пул-загрузчик. Дублирование парсинга proxy/device принято (можно свести к общему
  parseProxy/parseDevice-хелперу). Причина выбора: не размывать fail-fast и не ослаблять тип persona.
- **M1 = фаза 2**: фото профиля только фаза 2 (`setupReplacementAccount.uploadProfilePhotos`);
  фаза 1 фото не ставит и унаследованные не удаляет (инвариант обезличенного пула).
- **M4 = параллельные прогоны РАЗРЕШЕНЫ** (не сериализовать). N выдаётся атомарно на ФС, НЕ
  in-memory счётчиком. Механизм (§4.3): два независимых rename на аккаунт — (1) claim пула
  `rename(workspace-<poolId> → workspace-.pool-claim-<pid>-<poolId>)` (ENOENT→забрал другой,
  next); (2) claim номера `rename(tmp → workspace-agent<N>.incoming)` от computeNextAgentNumber()
  вверх, ENOTEMPTY→N++. Живая резервация непуста → ENOTEMPTY надёжно детектит коллизию номера.
  temp-имя `workspace-.pool-claim-*` невидимо и listAgentIds, и listPoolAccountIds. Согласовано с
  banned-replacement (номера НЕ минтит, конкурирует только за пул; N≥max+1 > любого забаненного id).
- **H = H-b**: старое (тулы/скиллы/спеки) помечается `[DEPRECATED]`, код/регистрации живут до
  архивации change; удаление — при `openspec archive`, не в этом change.
- **R20 = вариант А**: приватного канала на агента НЕ создаётся — инвайт в ОБЩИЙ канал воронки
  `FUNNEL_PRIVATE_CHANNEL_ID` (exportChatInvite от REPORT_AGENT_ID + upsertPrivateInviteLink,
  post_updated=0). §6 уже соответствует. Правку текста R20 в requirements ведёт аналитик параллельно.
- Остаются открытыми только минорные M2 (ctime vs createdAt-поле), M3 (дом claim), Q2 (удаление
  creds из персон — необратимо, подтверждение человека).

**Detached (ADR 0008, §9 доработки):** обе фазы — долгие прогоны >90s watchdog → обязаны
следовать ADR 0008: тул/скилл только стартует detached job через `systemd-run` (transient-юнит,
НЕ committed `.service`), итог асинхронно в Saved Messages REPORT_AGENT_ID; каждый ops-скрипт
обязан иметь внутренний жёсткий таймаут + `process.exit` (образец `ops/tg-agent-autoregistration.ts`
гасит висящие GramJS reconnect-клиенты). Committed юниты (`tg-agent@.service`,
`tg-banned-replacement-sweep.service`) — образец только для периодических задач. Каждая фаза
получает свой `skills/<phase>/SKILL.md` (образец `skills/tg-agent-autoregistration/SKILL.md`),
чтобы быть вызываемой как скилл, а не только тул.

Связано: [[project_banned_account_replacement_architecture]],
[[project_tg_agent_autoregistration_setup_mtproto_calls]],
[[project_tg_agent_autoregistration_cleanup_calls]],
[[feedback_dont_override_requirements_from_code_inference]] (R20 — не переписал требование сам, вынес на подтверждение; координатор подтвердил вариант А).
