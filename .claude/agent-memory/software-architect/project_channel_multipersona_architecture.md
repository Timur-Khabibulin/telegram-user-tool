---
name: project-channel-multipersona-architecture
description: Находки при проектировании channel-multipersona (реестр каналов в разрезе персоны) — непроизводные решения, снижающие/поднимающие риск
metadata:
  type: project
---

Фича «Мультиперсонность в распределении каналов». Требования согласованы —
`docs/design/channel-multipersona/requirements-v1.md` (R1..R11). Архитектура
написана — `docs/design/channel-multipersona/architecture.md`. Спроектирована,
не реализована. Вход-ограничение заказчика: реестр в ДВЕ таблицы —
`channels` (PK canonical_link, метрики) + `channel_assignments`
(PK persona+canonical_link, agent_id NULLABLE). Файл прежний `discovery.db`.

**Непроизводные решения/находки (проверено чтением, не выводится дёшево):**

- **Агент принадлежит ровно одной персоне** (ограничение 4.2 + `AccountConfig.persona`).
  Следствие: разрез нагрузки по персоне на уровне агента НЕ нужен — все каналы
  агента уже в его персоне. Персона-разрез обеспечивается только сужением
  МНОЖЕСТВА целевых агентов. Поэтому `countActiveChannels(agentId)` (rotation,
  channels.db) не меняет сигнатуру; меняется только `assignmentCounts` →
  `assignmentCountsForPersona` (distribution, реестр).

- **Пустой слот (agent_id NULL) пишет ТОЛЬКО channel-rotation** (fill=target /
  fail=NULL), не leave-banned-channels. Отклонён вариант «обнулять в момент бана»
  ради «один факт — один дом». Окно «бан→ротация» безопасно: забаненный агент
  неактивен, детект кандидата идёт по channels.db (leaved_from_banned), не по
  agent_id. Все AC описывают состояние ПОСЛЕ ротации.

- **Два смысла NULL разведены:** старый `assigned_agent IS NULL` = нераспределённый
  NULL-пул similar-дискавери (ИСЧЕЗАЕТ с депрекейтом); новый `agent_id IS NULL` =
  владелец-персона есть, агента нет (R5).

- **Дедуп дискавери/распределения больше НЕ через `isKnownChannel`** (реестр), а
  через `getAssignment(admin, persona, link)` — канал в другой персоне валиден (R4/AC-1).
  `isKnownChannel` остаётся для R9-обслуживания метаданных.

- **Удаляются при депрекейте пул-механики:** `getUnassignedChannels`, `assignChannel`
  (из NULL), `getAgentPool/trySetAgentPool/setAgentPool` + таблица `agent_pools`.
  Живой читатель agent_pools ровно один — колонка «пул» funnel-report (buildFunnelCsv),
  её заменяет «персона» из `loadAccountConfig(agentId).persona` (R8).
  `parseAgentSpec` (distribution) удаляется — таргетинг именем персоны.
  redistribute сливается в runDistribution (R11), пиннинг на агента убран.

- **Дата штампа депрекейта = 2026-09-05** (git log последнее изменение similar.ts,
  distribute-pool.ts, discovery-add-pool.ts, import-agent-pool.ts).

- **Резолвинг персоны — best-effort `buildPersonaIndex()` в config.ts** (прецедент
  `listUsedProxyUsernames`), один раз на прогон, передаётся картой вниз; без
  глобального изменяемого кэша на процесс.

- **Миграция:** INSERT OR IGNORE discovered_channels → channels + channel_assignments
  (persona='мария', LEGACY_PERSONA const). Идемпотентна на PK, старую таблицу НЕ
  дропает (обратимость). Верификация до запуска: конфиги агентов реально имеют
  persona=='мария'.

**Дополнения после ревью против кода (правки §2.1/§3.2/§5/§7/§8):**

- **ТРИ входа распределения**, не два: бот-листенер, redistribute И
  `scripts/ops/distribute-channels.ts` (сырой список ссылок + `--agents` round-robin,
  глобальные getChannelStatus/registerChannel). distribute-channels СЛИВАЕТСЯ в
  runDistribution (не депрекейт): links→CsvRow[](metrics={}), флаг `--agents`→`--persona`.

- **Пустой набор целей — тихая потеря:** planDistribution([],...) возвращает []
  (plan.ts:30), added=0 молча. Решение: resolvePersonaTargets(persona) пусто →
  ЯВНЫЙ ОТКАЗ до классификации, все входы (бот/redistribute/distribute-channels/
  discovery). Требует нового AC в ТЗ (заказчик заведёт).

- **Бот-листенер валидация персоны:** состояние awaiting_agents→awaiting_persona;
  known personas = new Set(buildPersonaIndex().values()); отказ на опечатку.
  parseAgentSpec удаляется. Колонка distribution_tasks.agents_spec → ПЕРЕИМЕНОВАТЬ
  в `persona` (distribution.ts; аддитивная пересборка таблицы, SQLite без RENAME COLUMN).

- **persona в журнале — ОБЯЗАТЕЛЬНА** (решение заказчика, не опционально как было
  сначала). `ALTER TABLE operations ADD COLUMN persona TEXT` (nullable для старых).
  recordAssigned получает обязательное поле persona. Снимает неоднозначность: один
  chat_id может иметь assigned-события РАЗНЫХ владельцев из разных персон; тайм-линия
  владения строится по (chat_id, persona). Индекс не добавляем (нет потребителя).
  Ключ журнала chat_id и мост channel_identity — персона-независимы.

**Уровень:** OpenSpec change. Специи: channel-registry, channel-discovery(+avg-reach-gate),
channel-distribution, channel-rotation, channel-cleanup, funnel-report, funnel-metrics,
channel-operations-history (поле persona); депрекейт channel-pools/
similar-channel-discovery/discovery-similar-parallel.

Связано: [[project-channel-distribution-architecture]] (discovery.ts, три
балансировки, мёртвые метрики-колонки, bot-listener),
[[project-channel-operations-history]] (recordAssigned из assign-путей),
[[feedback-check-hidden-schema-consumers-before-renaming]] (grep .claude/skills/ до DROP).
