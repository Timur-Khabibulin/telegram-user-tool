## 1. Схема БД и миграция

- [x] 1.1 `core/db/discovery.ts`: заменить одну таблицу `discovered_channels` на две — `channels(canonical_link PK, added_at, легаси-метрики, metrics_json)` и `channel_assignments(persona, canonical_link, agent_id NULLABLE, assigned_at, PRIMARY KEY(persona, canonical_link), FK→channels)`; индексы по `persona` и `agent_id`. Схема идемпотентна (guard-`Set`), создаётся в `ensureDiscoverySchema`. (Новые таблицы вводятся рядом со старой `discovered_channels` — её читает миграция 1.2; функции доступа переезжают в §2.)
- [x] 1.2 Миграция существующего `discovered_channels`: перенести каналы в `channels` (с `added_at`, метриками) и действующие закрепления в `channel_assignments` с `persona = LEGACY_PERSONA ("maria")`; идемпотентно (`INSERT OR IGNORE`), обратимо (исходную таблицу не удалять до подтверждения оператора).
- [x] 1.3 `core/db/distribution.ts`: переименовать колонку `distribution_tasks.agents_spec` → `persona` (аддитивная пересборка таблицы), обновить типы/`mapRow`/`createDistributionTask`.
- [x] 1.4 `core/db/channel-operations.ts`: `ALTER TABLE operations ADD COLUMN persona TEXT` (nullable для исторических записей).

## 2. Модуль реестра (`core/db/discovery.ts`)

- [x] 2.1 `ensureChannel(admin, link): { inserted }` — `INSERT OR IGNORE` в `channels`.
- [x] 2.2 `assignToPersona(admin, {persona, canonicalLink, agentId, source?}, log?): { assigned }` — транзакция `ensureChannel` + `INSERT OR IGNORE` в `channel_assignments`; эмитит `recordAssigned` с персоной; идемпотентно (повтор пары не создаёт второй слот).
- [x] 2.3 `getAssignment(admin, persona, link): { agentId: string | null } | null` — строка закрепления пары или `null` (дедуп по персоне).
- [x] 2.4 `assignmentCountsForPersona(admin, persona): Record<agentId, number>` — стартовая нагрузка в рамках персоны (`agent_id IS NOT NULL`).
- [x] 2.5 `setAssignmentAgent(admin, persona, link, agentId | null, source?, log?)` — `UPDATE` слота; читает старого агента до записи для `recordAssigned`.
- [x] 2.6 `removeAssignment(admin, persona, link): { deleted }` — `DELETE` строки закрепления персоны; `channels` не трогает.
- [x] 2.7 `isKnownChannel(admin, link)` — оставить как реестровую проверку (`channels`) для обслуживания метаданных (R9).
- [x] 2.8 Удалить `getUnassignedChannels`, `assignChannel` (из NULL), `getChannelStatus`, `forceAssignChannel`, `registerChannel`, `assignmentCounts`, `deleteDiscoveredChannel` (заменены пунктами 2.1–2.6); пул-функции `getAgentPool`/`trySetAgentPool`/`setAgentPool` см. §10.

## 3. Резолвинг персоны (`core/config.ts` + хелпер)

- [x] 3.1 `buildPersonaIndex(): Map<agentId, persona>` — best-effort обход `listAgentIds()` с чтением `loadAccountConfig(agentId).persona`; битый конфиг — пропуск с логом (прецедент `listUsedProxyUsernames`).
- [x] 3.2 `resolvePersonaTargets(persona): string[]` — активные агенты персоны (существующий критерий активности + фильтр по персоне); множество известных персон = значения `buildPersonaIndex`.

## 4. Дискавери

- [x] 4.1 `features/discovery/run.ts`: `RunParams.agents: string[]` → цель-персона; целевые агенты = `resolvePersonaTargets`; дедуп гейтом `getAssignment(persona)` вместо `isKnownChannel`; закрепление через `assignToPersona`.
- [x] 4.2 Отказ до сбора, если `resolvePersonaTargets` пусто / персона неизвестна (R12); отражено в отчёте прогона (per-agent персоны).
- [x] 4.3 Вызыватели дискавери — ops-скрипт `scripts/ops/discovery.ts` и тул в `index.ts`: принимать имя персоны вместо набора агентов.

## 5. Распределение

- [x] 5.1 `features/channel-distribution/run.ts`: удалить `parseAgentSpec`; `runDistribution(rows, persona, …)` — целевые агенты из `resolvePersonaTargets`; дедуп `classifyRows` по персоне (`getAssignment`); регистрация через `assignToPersona`.
- [x] 5.2 `features/channel-distribution/plan.ts`: стартовая нагрузка из `assignmentCountsForPersona`; при пустом наборе целей — отказ на уровне `runDistribution` (не пустой прогон).
- [x] 5.3 `scripts/periodic/distribution-listener.ts`: состояние диалога `awaiting_agents` → `awaiting_persona`; валидация имени персоны против известных персон; тексты подсказок и сводки; передача persona в `createDistributionTask`; отказ при пустой/неизвестной персоне.
- [x] 5.4 `scripts/ops/redistribute-channels.ts`: вход — список каналов + `--persona` (агентская колонка и пиннинг убраны); та же `runDistribution`.
- [x] 5.5 `scripts/ops/distribute-channels.ts`: слить с `runDistribution` — ссылки оборачиваются в `CsvRow[]` (`metrics={}`), флаг `--agents` → `--persona`.

## 6. Ротация

- [x] 6.1 `features/channel-rotation/run.ts`: целевые агенты — активные агенты персоны источника; кандидаты группируются по персоне (`buildPersonaIndex`); перенос через `setAssignmentAgent(persona, …)`.
- [x] 6.2 При отсутствии активного агента персоны — `setAssignmentAgent(persona, link, NULL)` (пустой слот), строку закрепления не удалять, `deleteChannelRow(source)` для непристроенного не вызывать.
- [x] 6.3 `features/channel-rotation/plan.ts`: нагрузка/раскладка в рамках персоны; исключение агента-источника только для его канала.

## 7. Очистка

- [x] 7.1 `skills/channel-cleanup.ts`: замена `deleteDiscoveredChannel(link)` на `removeAssignment(persona агента, link)`; персона агента из `buildPersonaIndex`/конфига.

## 8. Журнал операций

- [x] 8.1 `core/db/channel-operations.ts`: колонка `persona` в общей части операции (+ аддитивная миграция); проброс персоны в `recordAssigned` (первичное назначение, ротация-заполнение, ротация-обнуление). `recordStatusChange`/`recordJoined` персону не несут — по §2.1 персона нужна только `assigned` (для status_change владелец-агент уже в `newAgentId`, персона выводится из него 1:1).
- [x] 8.2 Тайм-линия владения (`getOwnershipTimeline`) — с опциональным сужением по персоне (разрез `(chat_id, persona)`). Подсчёт банов идёт по `status_change` (персону не несёт), поэтому там сужение по персоне не вводится.

## 9. Отчёт

- [x] 9.1 `features/funnel/funnel-collect.ts`: `AgentFunnelRow.poolName` → `persona` из `loadAccountConfig(agentId).persona`.
- [x] 9.2 `funnel-report.ts` (`buildFunnelCsv`): заголовок «пул» → «персона», источник значения — персона агента.

## 10. Депрекейт-штампы (только пометка; полный выпил — отдельная под-задача)

- [x] 10.1 Проставить депрекейт-комментарий с датой последнего изменения в `features/discovery/similar.ts`, `scripts/ops/discovery-similar.ts`, `scripts/ops/discovery-add-pool.ts`, `scripts/ops/distribute-pool.ts`, `scripts/ops/import-agent-pool.ts` — не запускать (пишут по старой модели реестра).

## 11. Документация

- [x] 11.1 Обновить `docs/db-schema.puml` (две таблицы `channels`/`channel_assignments` вместо `discovered_channels`; колонка `persona` в журнале операций).
- [x] 11.2 Обновить `docs/architecture.md` / `docs/operation.md` в затронутых местах (модель реестра, таргетинг по персоне).
