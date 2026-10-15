---
name: project_persona_account_reserve_architecture
description: persona-account-reserve design — third provision path into a per-persona reserve + two activation triggers; reserve FS naming makes it invisible for free; activation drops applyPersonaToAccount
metadata:
  type: project
---

Фича «резерв готовых аккаунтов персоны» (третий путь подготовки). Требования —
`docs/design/persona-account-reserve/requirements-v1.md` (R1–R20). Архитектура НАПИСАНА —
`docs/design/persona-account-reserve/architecture.md`. Два существующих скилла
(`tg-agent-pool-provision` фаза 1, `tg-agent-persona-deploy` фаза 2) остаются; третий —
в дополнение. Корневая причина фичи: `channels.CreateChannel` → `USER_RESTRICTED` на
уровне аккаунта, поэтому канал создаётся в момент провиженинга (как в автрегистрации),
а активация канал НЕ трогает.

**Ключевые решения (неочевидны из кода):**
- **Резерв на ФС = `~/.openclaw/workspace-reserve-<persona>-<K>`, logical id `reserve-<persona>-<K>`.**
  Невидимость рабочему контуру (R11/R12/AC-3) достигается ВЫБОРОМ ИМЕНИ, без правок
  перечислителей. Проверено по коду: все 4 сканера `workspace-*` фильтруют по префиксу/
  регулярке, которым `workspace-reserve-*` не соответствует — `listAgentIds` (`workspace-agent`),
  `listPoolAccountIds` (`workspace-emptyAccount`), `computeNextAgentNumber` (`^workspace-agent(\d+)`),
  `computeNextPoolNumber` (`^workspace-emptyAccount(\d+)`). Префикс `workspace-` (не отдельное
  дерево) выбран, чтобы `workspaceDir`/`loadAccount`/`validatePoolAccount`/`quarantinePoolAccount`/
  `claimPoolAccountTo` работали БЕЗ изменений. Персона в имени → отбор резерва персоны —
  дешёвый readdir-фильтр; ограничение: имя персоны не должно иметь вид `<другая>-<число>`.
- **Активация НЕ вызывает `applyPersonaToAccount`** (аккаунт резерва уже персонализирован;
  R13 — канал не создаём). Это упрощение против нынешней замены банов, где шаг 1–2 создавал
  канал+инвайт. Общая финализация (прогрев + join-queue + seedTransitions) выносится из
  `banned-account-replacement/run.ts:activateAndFinalize` в `features/persona-account-reserve/activate.ts`.
- **Инвайт-ссылка создаётся В СКИЛЛЕ ПРОВИЖЕНИНГА (решение координатора, расходится с R4/AC-11).**
  При создании канала: `exportChatInvite` от REPORT_AGENT_ID + вставка в пост + upsert в реестр
  под ключом reserveId + markPostUpdated (post_updated=1). Аккаунт уходит в резерв полностью
  готовым. Реализация: prepareAccount(createPublicChannel=FALSE) + отдельный
  createPersonaChannel(..., funnelInviteLink) — оба уже экспортированы, account-setup.ts НЕ
  меняется. Активация канал/пост НЕ трогает — только ПЕРЕКЕЙ записи реестра reserveId→финальный
  agentId БЕЗ вызовов Telegram (URL ведёт в общий канал, от аккаунта не зависит). Нужен новый
  `rekeyPrivateInviteLink(admin, from, to)` в core/db/private-invites.ts (delete существующей
  to-строки + смена ключа from→to, post_updated=1 сохраняется). Триггер 1: to=bannedId
  (перезапись). Триггер 2: to=agent<N>. Telegram-title ссылки остаётся reserveId (косметика).
- **`validatePoolAccount`/`quarantinePoolAccount` переиспускаются на reserveId КАК ЕСТЬ:**
  `{pool:true}`-загрузчик только connect+getMe, игнорирует persona — валиден и для аккаунта
  резерва (у которого persona есть). Имена «про пул», операция общая.
- **R20 — пер-персонный алерт.** Нынешний флаг `pool-empty-alerted` глобальный; становится
  `reserve-empty-alerted-<persona>` (дедуп оповещения на персону, снятие при пополнении
  резерва этой персоны). Фолбэк на обезличенный пул ЗАПРЕЩЁН (снова упёрся бы в USER_RESTRICTED).
- **buildIncoming:** username аккаунта резерва СОХРАНЯЕТСЯ (канал уже `@<username>_ch`), не
  регенерируется (в отличие от обезличенного пула). `buildIncoming` username не трогает —
  достаточно не добавлять регенерацию.

**Открытые вопросы СНЯТЫ координатором (2026-10-05):** активация = сделать аккаунт обычным
активным агентом, дальше работает существующая lifecycle-машинерия (для замены — существующая
финализация banned-account-replacement: warmup + join-queue + seedTransitions); спец-онбординга
ручной активации НЕ проектируем. Политику старения/ревалидации резерва НЕ вводим —
validatePoolAccount при активации (R19) достаточно.

Компоненты: `features/tg-agent-reserve-provision/{run,staging}.ts` (калька pool-provision,
промоушен в резерв вместо agent<N>), `core/reserve-accounts.ts` (пер-персонный аналог
pool-accounts.ts), ops-скрипты + SKILL.md + 3 тула в index.ts, detached по ADR 0008.

Связано: [[project_tg_agent_pool_provisioning_architecture]],
[[project_banned_account_replacement_architecture]],
[[project_tg_agent_autoregistration_setup_mtproto_calls]].
</content>
