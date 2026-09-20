---
name: project-channel-operations-history
description: Разведка перед дизайном журнала «История операций с каналами» (ИО) — проверенные факты по коду, снижающие/поднимающие риск
metadata:
  type: project
---

Фича «История операций с каналами» (ИО): централизованный append-only журнал
операций над каналами. Требования — `…/requirements-v1.md` (R1..R20), архитектура
НАПИСАНА — `docs/design/channel-operations-history/architecture.md`. Три типа
операций v1: «Смена статуса» (oldAgentId,newAgentId,oldStatus,newStatus,source),
«assigned» (oldAgentId,newAgentId,source), «joined» (agentId,source). Ключ канала —
`chatId`.

**Развилки ЗАКРЫТЫ заказчиком (учтено в architecture.md):**
- Детект перехода — ВАРИАНТ A (при записи): SELECT old + UPDATE атомарно в
  channels.db, потом best-effort append в журнал. Гейт `old==new` закрывает R9/R10.
- `assigned` по chatId ЧЕРЕЗ МОСТ join: карта `channel_identity(canonical_link,
  chat_id)` наполняется в recordJoined; первичное назначение до join — chat_id NULL
  + canonicalLink, R17 мостит через карту.
- `should_leave` НЕ журналируется (нет кодового писателя); leaved_manual — да.
- Требования v1 обновлены заказчиком: should_leave вынесен в «Вне рамок»,
  «приватные» → «каналы без собственного username», добавлен краевой случай
  тайм-линии владения.

**Ключевые решения architecture.md:** новый файл `channel-operations.db` в
admin-workspace (WAL + busy_timeout); новый модуль `core/db/channel-operations.ts`
— владелец схемы, белого списка R8 (`classifyStatusTransition` в одном месте) и
всех записей/чтений; JSON-поле `attrs` вместо EAV; кросс-файловую атомарность
через ATTACH отклонили (ограничение WAL) — append best-effort, потеря = недоучёт,
не двойной счёт; expireChannelStatuses переработать на пообъектную обработку ради
source=timer/oldStatus у снятия suspend.

**Проверено по коду на этапе разведки (не выводится дёшево заново):

**Снимает главный риск:** межконтекстная запись «пер-агентный скилл → admin-workspace
БД» УЖЕ есть в проде. `src/skills/monitor-v2.ts:295` вызывает
`upsertRestriction(FUNNEL_ADMIN_AGENT_ID, agentId, …)` → `agentRestrictionsDbPath`.
`FUNNEL_ADMIN_AGENT_ID="agent1"` — compile-time константа `core/config.ts:351`.
Централизованный журнал = новая БД в admin-workspace по этому же шаблону.

**Естественный мост link↔chatId — точка join.** `src/skills/join-queue.ts:71`
`upsertChannelIdentityFromJoin(agentId, identity)` — единственное место, где
одновременно известны `chatId` (resolved identity) и `canonical_link`
(`result.link`). Только тут можно наполнять карту `chatId↔link`.

**Развилки до дизайна (проверенные основания):**
- Переход old→new: НИ ОДИН писатель статуса не передаёт oldStatus. `markChannelStatus`
  делает голый UPDATE; старый статус лежит в той же строке `channels.status`.
  Развилка: детект перехода ПРИ ЗАПИСИ (SELECT old в одной транзакции; oldStatus/R7,
  R10, R9-дедуп решаются даром) vs append-raw + дедуп на чтении (у первой записи нет
  old, R19).
- `assigned` эмитится в пространстве `canonical_link` (реестр `discovered_channels`,
  PK=canonical_link), НЕ знает chatId. Приватные каналы без username в реестр не
  попадают вовсе ⇒ R17-тайм-линия для них недостижима; но R16/AC-3 требуют для
  приватных лишь СЧЁТ банов (идёт от status-операций с chatId) — это ок. Нужно
  подтверждение заказчика, что R17 ограничивается каналами с username.
- `should_leave` НЕ имеет кодового писателя — ставится оператором вне `src/`
  (`channels.ts:1418`, grep не нашёл писателей `status='should_leave'`). R8/R13
  требуют его фиксировать ⇒ либо вводить ops-точку, либо R8 не держится. Решение
  заказчика.

**Инструментирование (для единого примитива с белым списком R8):**
- R8-переходы разбросаны: `markChannelStatus` (banned/suspend + вне-R8
  format_error/only_comment/sleep), `setLeftChannelStatus` (leaved_from_banned/
  leaved_manual), `expireChannelStatuses` (снятие suspend — но это БАТЧ-UPDATE,
  снимает suspend И sleep разом, sleep вне R8 ⇒ нужна пер-канальная итерация),
  `upsertChannelIdentityFromJoin` (сброс в NULL при join). Белый список R8 обязан
  жить в одном месте, иначе протечка → нарушение AC-9.
- `forceAssignChannel` (discovery.ts) перезаписывает assigned_agent без чтения
  старого — для oldAgentId (R11) нужен SELECT перед перезаписью. `assignChannel`
  (только из NULL) даёт пустой oldAgentId = первичное назначение (R11/AC-4) даром.
- Ротация `features/channel-rotation/run.ts:75-80`: forceAssignChannel(assigned) →
  addJoinQueue → deleteChannelRow(source). joined произойдёт ПОЗЖЕ и может не
  случиться.
- `source` (R6/AC-10) не выводится из функции — прокидывать параметром. `banned` из
  `core/post-comment-send.ts:83` идёт и из мониторов, и из review-listener.

**Риск нагрузки:** журнал будут писать все мониторы всех агентов одновременно в один
admin-файл (в отличие от нынешних admin-БД, куда пишут одиночные admin-задачи) —
нужен WAL + busy_timeout.

Связано: [[project-channel-distribution-architecture]] (discovery.ts, реестр,
FUNNEL_ADMIN_AGENT_ID), [[feedback-check-hidden-schema-consumers-before-renaming]].
