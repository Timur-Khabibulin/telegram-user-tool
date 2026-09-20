---
name: project_banned_account_replacement_architecture
description: banned-account-replacement design — decided vs owner-forks; tasks.db co-locates runs/error_log (reset gotcha); reuse boundaries for persona-setup; deferred-lifecycle mechanism is the big fork
metadata:
  type: project
---

Фича «авто-замена забаненного аккаунта из пула» (Модель B: agentId+персона сохраняются,
меняется физ. аккаунт). Требования — `docs/design/banned-account-replacement/requirements-v1.md`
(R1..R13). Архитектура НАПИСАНА — `docs/design/banned-account-replacement/architecture.md`.

**Критическая находка по коду (определяет весь §5 «сброс состояния R7»):**
`runs`, `error_log`, `dispatcher_runs` и `tasks` физически лежат в ОДНОМ файле `tasks.db`
(core/db/runs.ts, error-log.ts, dispatcher-runs.ts все открывают `tasksDbPath`). Значит
«сбросить рабочее состояние, но сохранить журналы» НЕЛЬЗЯ сделать как «rm workspace» —
надо перенести `tasks.db` из старого workspace и внутри перезаписать только таблицу
`tasks`, оставив таблицы истории.

**Ключевые решения архитектуры (уже в доке):**
- Триггер — новый systemd oneshot+timer по образцу `tg-reauth-sweep.*`, выборка
  `listActiveByType(admin,"banned")` (заморозка FROZEN_* тоже пишется как banned).
- Защита от двойного забора пула (R3) — атомарный `renameSync(workspace-emptyAccount<X>
  → workspace-<agentId>.incoming)`; он же и потребление, и якорь восстановления. Отдельный
  lock не нужен.
- Подмена — сборка в `.incoming` + два rename (swap), восстановимо по якорям
  `.incoming`/`.old` + фазовый маркер `replacement.json(activating|done)`. `banned`
  снимается ПОСЛЕДНИМ (commit point) — до этого диспетчер гейтит агента на
  getActiveRestriction.
- Сбой активации (item 5): фазовый маркер разделяет commit подмены и commit активации →
  повтор sweep делает ТОЛЬКО активацию (не новый забор пула). Активация идемпотентна
  (профиль re-apply; канал — guard getOwnPersonalChannel; инвайт — upsert).
- Переиспользование настройки под персону: bootstrap-часть autoreg НЕ нужна (пул уже
  авторизован); зовём `createPersonaChannel` (уже экспортирован) + НОВЫЙ экспорт профиля
  из core/tdata/account-setup.ts (applyProfile/uploadProfilePhotos сейчас приватны) +
  `upsertPrivateInviteLink` (сам ставит post_updated=0 = «на перепубликацию»). НЕ звать
  `prepareAccount` целиком (меняет 2FA/сбрасывает сессии). Активация — сессией агента, по
  образцу tg-agent-channel-setup.
- listAgentIds (R12): сузить до `workspace-agent*`, пул — `listPoolAccountIds()` для
  `workspace-emptyAccount*`. Сужение только УБИРАЕТ пул из выборки (желаемо), рабочих
  агентов не задевает т.к. все agentId вида `agent<N>`. Проверить прод `ls ~/.openclaw`.

**Крупные развилки — ЗАКРЫТЫ заказчиком (2026-09-20):**
1. Механизм отложенного перехода — выбран ВАРИАНТ B: таблица `lifecycle_transitions
   (agentId, action, run_at, done)` в admin-workspace. Все три перехода (start_join_queue
   T+1д, enable_monitor_v5 + disable_warmup T+3д) — строками таблицы. Исполняет их НЕ
   диспетчер, а сам суточный sweep (изменение от первоначального §7.3-B, где исполнял
   диспетчер). Гранулярность суточная — принято. A(lifecycle-задачи) и C(по timestamp
   аудита) отклонены; C невозможен, т.к. аудит отложен. Ядро: warmup off по времени
   нативным nextRun невыразимо. B самодостаточен без аудита.
2. Аудит замены (R13) — ОТЛОЖЕН заказчиком, вне скоупа. Таблицу account_replacements НЕ
   проектируем сейчас; на время отсрочки — journal-след. R13 остаётся в requirements, в
   architecture помечен отложенным.
3. Каденс — суточный периодический sweep, ОДИН systemd-юнит совмещает (а) поиск banned +
   замену и (б) исполнение назревших переходов из таблицы (переходы первыми — дешёвое
   housekeeping, замены вторыми).

Минорные форки: username нового аккаунта (из пула vs генерить — риск коллизии с мёртвым),
очистка унаследованных фото/каналов на пул-аккаунте, канал алерта «пул пуст» (реком.
операторский Bot API-чат TELEGRAM_REVIEW_CHAT_ID), дедуп алерта (флаг-файл).

Уровень — OpenSpec change `banned-account-replacement`; затрагивает telegram-error-handling/
agent-restrictions (banned теперь триггерит замену), report-agent-isolation/listAgentIds,
reuse tg-agent-autoregistration + private-invite-links.

Связано: [[project_tg_agent_autoregistration_setup_mtproto_calls]],
[[project_channel_operations_history]], [[feedback_verify_live_component_before_designing]].
