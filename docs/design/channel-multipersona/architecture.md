# Архитектура: Мультиперсонность в распределении каналов

> **О чём документ.** Техническое решение к согласованному ТЗ
> `requirements-v1.md` (R1..R11, AC-1..AC-12, NFR-1..NFR-3). Раскладка реестра по
> двум таблицам, точный DDL, отображение функций доступа и способностей на новую
> модель, резолвинг персоны, план миграции, граница депрекейта, уровень изменения
> и риски. Продуктовые решения не переоткрываются — вход в `requirements-v1.md`.
>
> **Входное ограничение (не пересматривается).** Реестр нормализуется в две
> таблицы: `channels` (реестр канала, метрики) и `channel_assignments`
> (закрепление в разрезе персоны с nullable-агентом). Документ детализирует и
> обосновывает это направление, а не выбирает его заново.

## 1. Целевая схема БД

Файл прежний — `~/.openclaw/workspace-<adminAgentId>/discovery.db`
(`discoveryDbPath`, `core/config.ts`). Внутри вместо одной таблицы
`discovered_channels` — две.

### 1.1. DDL

```sql
-- Реестр канала: одна строка на канал на всю платформу. «Один факт — один дом»:
-- метрики канала (свойство канала, а не персоны) живут только здесь.
CREATE TABLE channels (
    canonical_link   TEXT PRIMARY KEY,          -- инвариант глобальной уникальности КАНАЛА
    added_at         INTEGER NOT NULL DEFAULT 0,
    sub_count        REAL,                        -- легаси-колонки метрик (без читателей, см. §2)
    avg_views        REAL,
    p50_user         REAL,
    p90_users        REAL,
    comments_per_day REAL,
    metrics_json     TEXT                         -- метрики произвольного состава (channel-distribution)
);

-- Закрепление в разрезе персоны: одна строка на пару (персона, канал).
CREATE TABLE channel_assignments (
    persona        TEXT    NOT NULL,             -- имя шаблона персоны (AccountConfig.persona)
    canonical_link TEXT    NOT NULL REFERENCES channels(canonical_link),
    agent_id       TEXT,                          -- NULLABLE: пустой агентский слот (R5)
    assigned_at    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (persona, canonical_link)
);

CREATE INDEX idx_assignments_persona ON channel_assignments(persona);
CREATE INDEX idx_assignments_agent   ON channel_assignments(agent_id);
```

### 1.2. Как ключи реализуют инварианты

| Инвариант ТЗ | Что держит |
|---|---|
| R1 — не более одного агентского слота канала в персоне | `PRIMARY KEY (persona, canonical_link)`: одна строка на пару, у строки максимум один `agent_id`. |
| R1 — независимые закрепления того же канала в разных персонах | тот же PK: `(А, C)` и `(Б, C)` — разные строки. |
| Глобальная уникальность канала как сущности реестра | `channels.canonical_link PRIMARY KEY` — одна запись о канале независимо от числа персон. Это и есть база под R9. |
| R9 — полный список реестра, каждый канал один раз | `SELECT ... FROM channels` — без соединения с `channel_assignments`, канал не размножается по персонам. |
| Целостность закрепления | `FK channel_assignments.canonical_link → channels.canonical_link` — нельзя закрепить неизвестный канал. |

### 1.3. Что происходит с понятием «NULL-пул»

В прежней модели `discovered_channels.assigned_agent IS NULL` означало
**«канал найден, но ещё не роздан агенту»** — промежуточный пул незавершённого
прогона similar-дискавери (`getUnassignedChannels`/`assignChannel`). Это понятие
**исчезает** вместе с депрекейтом пул-механики (§6): дискавери и распределение
пишут закрепление сразу с агентом.

В новой модели `NULL` у `channel_assignments.agent_id` имеет **другой** смысл —
**пустой агентский слот**: канал принадлежит персоне, но активного агента нет
(после бана до ротации, R5/AC-5/AC-6). Строка закрепления при этом существует
(персона хранится), а значение агента отсутствует. Два прежде смешанных смысла
NULL разведены: «нераспределённый кандидат» больше не моделируется вовсе, а
«владелец есть, агента нет» — это `agent_id IS NULL` при существующей строке.

### 1.4. Решение: кто и когда переводит слот в пустой

`agent_id` меняет только `channel-rotation` — единственный автоматический путь
смены закрепления (совпадает с базовым инвариантом `channel-registry`: два пути
смены — ручной override и ротация). При обработке кандидата ротация выставляет
`agent_id = целевой агент` (слот заполнен, AC-4) либо `agent_id = NULL`, если
активного агента персоны нет (слот пуст, AC-5/AC-6). Строку закрепления ротация
не удаляет — принадлежность персоне сохраняется.

Рассмотренная альтернатива — обнулять слот в момент выхода из канала
(`leave-banned-channels`), чтобы состояние «пусто» наступало ровно в момент
бана. Отклонена ради простоты и «один факт — один дом»: запись `agent_id`
осталась бы в одном владельце (ротация), а не размазалась по двум скиллам.
Функционально окно «бан → первая ротация» безопасно: строка уже принадлежит
персоне, а забаненный агент неактивен и целью распределения не станет; ротация
идёт суточно и сверяет состояние по `channels.db` (статус `leaved_from_banned`),
а не по `agent_id`. Все проверяемые AC описывают состояние **после** ротации.

## 2. Отображение функций `core/db/discovery.ts`

Модуль расщепляется на операции реестра (`channels`) и операции закрепления
(`channel_assignments`). Сигнатуры, у которых появляется разрез по персоне,
получают параметр `persona`.

| Текущая функция | Судьба | Новая сигнатура / замена |
|---|---|---|
| `normalizeChannelLink(raw)` | без изменений | — |
| `ensureDiscoverySchema(admin)` | без изменений (создаёт обе таблицы + запускает миграцию §5) | — |
| `isKnownChannel(admin, link)` | **сохраняется как реестровая проверка** (существование в `channels`), но перестаёт быть гейтом дедупа дискавери | `isKnownChannel(admin, link): boolean` — читает `channels`. Для R9-обслуживания метаданных. |
| — (нет) | **новая**: дедуп по персоне (R4/AC-1/AC-2) | `getAssignment(admin, persona, link): { agentId: string \| null } \| null` — строка `channel_assignments` для пары или `null`. |
| `registerChannel(admin, link, assignedAgent?)` | **расщепляется** | `ensureChannel(admin, link): { inserted }` — `INSERT OR IGNORE` в `channels`. Плюс `assignToPersona(...)` ниже. |
| `assignChannel(admin, link, agent, source?, log?)` (из NULL) | **удаляется** (пул-механика) | замена — `assignToPersona` (прямое закрепление при дискавери/распределении). |
| — (нет) | **новая**: атомарное закрепление за агентом персоны | `assignToPersona(admin, {persona, canonicalLink, agentId, source?}, log?): { assigned }` — в одной транзакции `ensureChannel` + `INSERT OR IGNORE INTO channel_assignments(persona, canonical_link, agent_id, assigned_at)`. Идемпотентно (NFR-1): повтор той же пары не создаёт второй слот (AC-2). Эмитит `recordAssigned` (см. §2.1). |
| `getUnassignedChannels(admin)` | **удаляется** (пул-механика; читатели — только similar.ts и distribute-pool.ts, оба в депрекейте §6) | — |
| `getChannelStatus(admin, link)` | **заменяется** на `getAssignment` (разрез по персоне) | см. `getAssignment`. |
| `assignmentCounts(admin)` | **меняет сигнатуру** — стартовая нагрузка в рамках персоны (R6/AC-7) | `assignmentCountsForPersona(admin, persona): Record<agentId, number>` — `SELECT agent_id, COUNT(*) FROM channel_assignments WHERE persona=? AND agent_id IS NOT NULL GROUP BY agent_id`. |
| `forceAssignChannel(admin, link, agent, source?, log?)` | **заменяется** на слот-апдейт ротации | `setAssignmentAgent(admin, persona, link, agentId \| null, source?, log?)` — `UPDATE channel_assignments SET agent_id=? WHERE persona=? AND canonical_link=?`. Читает старого агента перед записью для `recordAssigned` (oldAgentId). |
| `deleteDiscoveredChannel(admin, link)` | **заменяется** на удаление закрепления по персоне (R7/AC-8) | `removeAssignment(admin, persona, link): { deleted }` — `DELETE FROM channel_assignments WHERE persona=? AND canonical_link=?`. Строку `channels` не трогает (её могут держать другие персоны). |
| `setChannelMetrics(admin, link, metrics)` | **переезжает на `channels`**, сигнатура без изменений (метрика — свойство канала) | пишет `channels`. (Без читателей — см. память проекта; сохраняется ради обратимости.) |
| `setChannelMetricsJson(admin, link, metrics)` | **переезжает на `channels`**, сигнатура без изменений | пишет `channels.metrics_json`. |
| `getAgentPool` / `trySetAgentPool` / `setAgentPool` + таблица `agent_pools` | **депрекейт** (§6): единственный живой читатель — колонка «пул» funnel-report, её заменяет «персона» из конфига (§3.5) | — |

### 2.1. Журнал операций (channel-operations-history): поле `persona`

**Решение заказчика:** в журнал операций добавляется персона. Это обязательно, не
опционально: без неё `assigned`-запись неоднозначна.

**Почему без персоны неоднозначно.** Ключ журнала — `chat_id` (глобальный marked
peer id, `core/db/channel-operations.ts`). В новой модели один и тот же канал
(один `chat_id`, один `canonical_link` через мост `channel_identity`) может быть
закреплён в нескольких персонах одновременно и независимо ротироваться в каждой.
Тогда по одному `chat_id` в журнале лежат `assigned`-события **разных владельцев
из разных персон**, и восстановить тайм-линию владения в рамках персоны (кто
держал канал C в персоне А) без поля `persona` нельзя — события А и Б
перемешиваются. `persona` разрешает это: тайм-линия строится в разрезе
`(chat_id, persona)`.

**Миграция таблицы `operations`.** Аддитивная колонка, тем же приёмом, что
аддитивные миграции `discovery.ts`:

```sql
ALTER TABLE operations ADD COLUMN persona TEXT;   -- nullable: старые записи до миграции
```

Nullable — исторические `assigned`/`status_change`/`joined` до перехода персону
не знают (их и не было в мультиперсонной модели); новые `assigned`-записи её
проставляют. Дополнительный индекс не обязателен (частичные выборки по
`chat_id`+`type` уже покрыты `idx_ops_chat_type_ts`; персона фильтруется в
приложении на небольшой выборке по каналу) — не добавляем без потребителя
(«простота»). Приём с `attrs` не используется: персона — первоклассный разрез
владения, а не справочный атрибут.

**Проброс `persona` в запись.** `recordAssigned(params)` получает обязательное
поле `persona: string`; `appendOperation` пишет его в новую колонку. Источники
вызова:

| Путь | Вызов | `persona` | `oldAgentId` |
|---|---|---|---|
| Первичное закрепление (discovery/distribution) | `assignToPersona` → `recordAssigned` | целевая персона прогона | `null` |
| Ротация — заполнение слота | `setAssignmentAgent(admin, P, link, target)` → `recordAssigned` | `P` (персона источника) | прежний агент строки |
| Ротация — обнуление слота (нет активных агентов) | `setAssignmentAgent(admin, P, link, NULL)` → `recordAssigned` | `P` | прежний агент; `newAgentId` = `null` (слот пуст) |

Удаление закрепления (`removeAssignment`, channel-cleanup, R7) в журнал `assigned`
не пишет — сегодня снятие закрепления не журналируется как `assigned`, эта фича
поведение не расширяет (журнал остаётся наблюдаемостью, а не источником решений).
Границу «нужна ли отдельная операция снятия» решает под-задача channel-operations-history,
здесь не вводим.

`recordAssigned` best-effort (сбой журнала не роняет обработку канала) — это
свойство сохраняется. Разрез по персоне на мост `channel_identity` не влияет:
`chat_id ↔ canonical_link` остаётся один на канал (персона-независим).

## 3. Раскладка способностей на новую модель

### 3.1. channel-discovery (`features/discovery/run.ts`)

- **Таргетинг по персоне (R2/R3).** `RunParams.agents: string[]` заменяется на
  `RunParams.persona: string`; целевые агенты round-robin резолвятся внутри как
  **активные агенты персоны** (§3.5, `resolvePersonaTargets(persona)`). Смешение
  агентов разных персон в одном прогоне невозможно по построению.
- **Дедуп по персоне (R4/AC-1).** Гейт `isKnownChannel(admin, canonical)`
  заменяется на `getAssignment(admin, persona, canonical) !== null`. Канал,
  закреплённый в другой персоне, — валидный кандидат.
- **Запись.** `registerChannel(admin, canonical, agent)` → `assignToPersona(admin,
  {persona, canonicalLink: canonical, agentId: agent})`. `ensureChannel` внутри
  создаёт реестровую строку.
- **Балансировка.** Дискавери сохраняет round-robin без учёта истории нагрузки
  (базовый инвариант `channel-registry`), теперь по кругу активных агентов
  персоны.
- Callers: `index.ts` тул `discovery_run` (параметр `agents?` → `persona`) и
  `scripts/ops/discovery.ts` (аргумент agents → persona). `avg_reach`-гейт не
  затрагивается.

### 3.2. channel-distribution (`features/channel-distribution/`)

- **Таргетинг по персоне (R2/R3/AC-3).** `parseAgentSpec` (разбор списка/
  диапазонов агентов) **удаляется**. Цель прогона — имя персоны; целевые агенты =
  `resolvePersonaTargets(persona)`. Указать конкретного агента нельзя.
- **Дедуп по персоне (R4).** В `classifyRows` проверка `getChannelStatus(admin,
  link) !== null` заменяется на `getAssignment(admin, persona, link) !== null`.
  Канал, закреплённый в другой персоне, попадает в кандидаты (AC-1); повторный в
  этой персоне — `skipped` (AC-2).
- **Water-fill в рамках персоны (R6/AC-7).** Стартовая нагрузка
  `assignmentCounts(admin)` → `assignmentCountsForPersona(admin, persona)`.
  `planDistribution` (чистая функция water-fill) **не меняется** — ей передаются
  агенты персоны и их персональная стартовая нагрузка. Детерминизм (NFR-2)
  сохраняется (тай-брейк по меньшему `agentId`).
- **Запись.** `registerChannel(...)` → `assignToPersona(...)`;
  `setChannelMetricsJson` без изменений (метрики канала).
- **Слияние redistribute (R11), см. §3.4.** `runDistribution` получает `persona`
  вместо `targetAgentIds`; внутри резолвит агентов сам.
- Caller: `scripts/periodic/distribution-listener.ts` — см. §3.2.3.

#### 3.2.1. Третий вход распределения: `scripts/ops/distribute-channels.ts`

Помимо бот-листенера (§3.2) и redistribute (§3.4) распределение имеет ещё один
вход: `distribute-channels.ts` — round-robin «сырого» списка ссылок (один линк на
строку, без метрик) по явному `--agents`, с пропуском уже известных реестру через
глобальные `getChannelStatus`/`registerChannel`. Он нарушает и таргетинг по
персоне (R3), и дедуп в рамках персоны (R4).

**Решение: слить с `runDistribution`, не депрекейтить.** Это тот же класс операции
(входной список каналов без готового агента → раскладка по агентам), что бот и
redistribute; отдельная реализация с собственными глобальными вызовами — источник
именно того расхождения, которое чинит фича. Три входа сходятся на одной функции
`runDistribution(rows, persona, ...)` — единый дедуп (R4) и water-fill (R6). Сырой
список ссылок оборачивается в `CsvRow[]` (`rawLink` = ссылка, `metrics = {}`) и
передаётся в `runDistribution`; отдельная round-robin-петля скрипта убирается.

- **Новая сигнатура запуска:** `--agents` → `--persona`:
  `tsx src/scripts/ops/distribute-channels.ts --file <path> --persona <имя> [--admin agent1]`.
  Валидация `--agents` против `listAgentIds()` заменяется на валидацию персоны
  против множества известных персон (§3.2.3) и отказ до записи при пустом/
  неизвестном значении, а также при отсутствии активных агентов персоны (§3.2.2).
- Скрипт становится тонкой обёрткой: чтение файла → `CsvRow[]` → `runDistribution`.

#### 3.2.2. Распределение на персону без активных агентов — явный отказ

`planDistribution` при пустом наборе целей возвращает `[]`
(`features/channel-distribution/plan.ts:30`): каналы классифицируются, но не
назначаются никому — прогон молча даёт `added=0` (тихая потеря входа). В новой
модели множество целей резолвится из персоны (`resolvePersonaTargets`, §3.5) и
может оказаться пустым (у персоны нет активных агентов).

**Поведение:** `runDistribution` (и все её входы — бот, redistribute,
distribute-channels, discovery) до классификации строк проверяет
`resolvePersonaTargets(persona)`. Пусто → **отказ прогона** с сообщением
«в персоне <P> нет активных агентов», без записи в реестр и без пустого прогона
`added=0`. Для бота это ответ оператору и возврат в состояние приёма ввода; для
скриптов — ненулевой код возврата и сообщение в лог. Аналогично для discovery
(§3.1): нет активных агентов персоны → отказ, а не пустой сбор.

Это новое наблюдаемое поведение требует отдельного критерия приёмки в ТЗ
(заводится заказчиком отдельно); здесь фиксируется как проектное решение.

#### 3.2.3. Бот-листенер: валидация имени персоны

`distribution-listener.ts` сегодня валидирует агентов через `parseAgentSpec`
против `listAgentIds()` и держит состояние диалога `awaiting_agents`. В новой
модели оператор вводит **имя персоны**:

- **Состояние диалога** `awaiting_agents` → `awaiting_persona`
  (`{ phase: "awaiting_persona", filePath, rows }`).
- **Множество известных персон** выводится из persona-полей всех агентов:
  `new Set(buildPersonaIndex().values())` (§3.5). `parseAgentSpec` из этого пути
  удаляется.
- **Валидация и путь ошибки.** Введённое имя (сообщением или подписью к файлу)
  сверяется с множеством известных персон. Неизвестное/опечатка → отказ
  «неизвестная персона «<ввод>»; известные: <список>», диалог остаётся в
  `awaiting_persona` (файл валиден — можно исправить ввод), как сегодня при
  отклонённом наборе агентов. Пустой набор активных агентов у валидной персоны →
  отказ §3.2.2.
- **Изменённые тексты подсказок:** «Пришлите диапазоны agentId, например
  agent6-agent10, agent15» → «Пришлите имя персоны, например: мария»; сводка
  запуска «(агентов: N)» → «(персона: <имя>, активных агентов: N)».

**Колонка `distribution_tasks.agents_spec`** (`core/db/distribution.ts`) теперь
хранит имя персоны. **Решение: переименовать** `agents_spec` → `persona`
(и поле `agentsSpec` → `persona` в `DistributionTask`/`mapRow`/`createDistributionTask`).
Причина: колонка станет семантически ложной («spec агентов», хранящий имя
персоны) — это ровно тот дрейф значения поля, от которого предостерегает практика
проекта. Таблица уровня прогона, исторических читателей значения нет
(персистится для аудита) — переименование безопасно; выполняется аддитивной
пересборкой таблицы тем же приёмом, что миграции `discovery.ts` (SQLite без
надёжного `RENAME COLUMN` на старых версиях).

### 3.3. channel-rotation (`features/channel-rotation/`)

- **Ротация в рамках персоны источника (R5/AC-4/AC-5/AC-6).** Кандидаты
  собираются по всем агентам (`getRotationCandidates` из `channels.db` каждого
  агента, без изменений). Для каждого кандидата персона = `personaOf(sourceAgentId)`
  (§3.5). Кандидаты **группируются по персоне**; каждая группа распределяется
  независимо только по активным агентам своей персоны.
- **Активные цели персоны.** `getActiveTargetAgents(admin)` фильтруется по
  персоне: к прежнему критерию (`getActiveRestriction == null &&
  isAgentActive`) добавляется `personaOf(agentId) === P`.
- **Нагрузка.** `countActiveChannels(agentId)` (из `channels.db`) — источник
  нагрузки прежний. Дополнительная фильтрация по персоне не нужна: агент
  принадлежит ровно одной персоне (ограничение среды 4.2), поэтому все его каналы
  уже в его персоне. Персона-разрез обеспечивается только сужением **множества**
  целевых агентов.
- **Заполнение / пустой слот.** Для назначенного кандидата: `setAssignmentAgent(admin,
  P, link, targetAgentId)` (было `forceAssignChannel`), `addJoinQueue(target)`,
  `deleteChannelRow(source)`. Для кандидата без цели (`unassigned` в `planRotation`,
  либо в персоне нет активных агентов): `setAssignmentAgent(admin, P, link, NULL)` —
  слот становится пустым, строка закрепления сохраняется, канал остаётся в
  персоне (AC-5). `deleteChannelRow(source)` для непристроенного **не** вызывается
  (кандидат должен переоцениваться следующим прогоном — поведение как сегодня).
- `planRotation` (чистая функция) — без изменений; вызывается по одному разу на
  персону. `Math.random()`-тай-брейк остаётся (для ротации детерминизм R не
  требуется).

### 3.4. redistribute (`scripts/ops/redistribute-channels.ts`)

Сливается с distribution (R11/AC-12). Прежний скрипт закреплял каналы за
**конкретными** агентами из CSV (`forceAssignChannel` по столбцу `assigned_agent`
+ `setAgentPool`). Новая модель:

- Вход — список каналов + **имя персоны** (агентская колонка и пиннинг убраны).
- Логика — та же `runDistribution(rows, persona, ...)`: дедуп в рамках персоны
  (R4), water-fill в рамках персоны (R6). Отдельного механизма
  принудительного пиннинга нет.
- `forceAssignChannel` и `setAgentPool` из этого пути уходят. Скрипт становится
  тонкой обёрткой над `runDistribution` (или его функцию перенимает бот
  distribution-listener целиком — решает под-задача реализации).

### 3.5. Резолвинг персоны (`features/funnel/funnel-collect.ts` + новый хелпер)

- **R8/AC-9.** В отчёте колонка «пул» → «персона». `AgentFunnelRow.poolName`
  (из `getAgentPool`) заменяется на `persona`, резолвится из
  `loadAccountConfig(agentId).persona`. Меняются: `funnel-collect.ts` (заполнение
  поля), `funnel-report.ts` (`buildFunnelCsv` — заголовок `пул` → `персона`,
  ячейка `a.poolName` → `a.persona`). Текстовый отчёт «пул» не показывает —
  правка только CSV.
- **Где резолвить, чтобы не читать файлы в цикле.** Новый хелпер в
  `core/config.ts` (там уже живут `loadAccountConfig`, `listAgentIds`,
  `listUsedProxyUsernames` — прецедент best-effort обхода конфигов):

  ```ts
  /** Активные best-effort персоны всех агентов: Map<agentId, persona>.
   *  Битый/недоступный конфиг одного агента не роняет резолвинг остальных. */
  export function buildPersonaIndex(): Map<string, string>;

  /** Активные агенты персоны (existing критерий активности + фильтр персоны). */
  // в feature-слое, поверх buildPersonaIndex + isAgentActive/getActiveRestriction
  export function resolvePersonaTargets(persona: string, ...): string[];
  ```

  Пустой результат `resolvePersonaTargets(persona)` (у персоны нет активных
  агентов) — это путь отказа §3.2.2, а не пустой прогон: вызывающая способность
  прекращает работу с сообщением до классификации входа.

  `buildPersonaIndex()` вызывается **один раз на прогон** (дискавери,
  распределения, ротации, сбора воронки) и передаётся вниз как готовая карта —
  никаких чтений `tg-account.json` в циклах по каналам/агентам. Глобального
  изменяемого кэша на процесс не заводим (playbook: избегать общего изменяемого
  состояния); карта живёт в области видимости прогона.

## 4. План миграции `discovered_channels` → `channels` + `channel_assignments`

Выполняется внутри `ensureSchema` (тот же приём, что аддитивные миграции сегодня):
идемпотентно, при первом открытии БД любым процессом (плагин или диспетчер).

### 4.1. Шаги

```sql
-- 0. Создать целевые таблицы, если их нет (§1.1).

-- 1. Реестр: перенести каждый известный канал (метрики — как есть).
INSERT OR IGNORE INTO channels
    (canonical_link, added_at, sub_count, avg_views, p50_user, p90_users, comments_per_day, metrics_json)
SELECT canonical_link, added_at, sub_count, avg_views, p50_user, p90_users, comments_per_day, metrics_json
FROM discovered_channels;

-- 2. Закрепления: персона maria (единственная на момент перехода, R10/AC-11).
INSERT OR IGNORE INTO channel_assignments (persona, canonical_link, agent_id, assigned_at)
SELECT 'maria', canonical_link, assigned_agent, added_at
FROM discovered_channels;
```

- **Персона `maria`** — константа миграции `LEGACY_PERSONA = "maria"` (единый
  источник). Требование R10 задаёт значение явно; ограничение среды 4.4
  гарантирует, что все каналы принадлежат одной персоне. **Шаг верификации перед
  запуском:** оператор подтверждает, что у существующих агентов
  `loadAccountConfig(agentId).persona === "maria"` (иначе таргетинг после
  миграции не найдёт агентов под перенесённые закрепления). Значение константы
  должно совпадать с фактическим `persona` в конфигах — код источник истины.
- **Строки с `assigned_agent IS NULL`** (остатки старого NULL-пула, если есть)
  переносятся как пустые слоты персоны `maria`. По ограничению 4.4 таких на
  практике нет; PK не допустит дублей (AC-11).

### 4.2. Идемпотентность (NFR-1)

`INSERT OR IGNORE` + `PRIMARY KEY` делают повтор безопасным: второй прогон
миграции ничего не дублирует и не перезаписывает. Дополнительный маркер версии
схемы не нужен — уникальность ключей самодостаточна («простота»).

### 4.3. Обратимость (NFR-3)

`discovered_channels` **не удаляется** этой миграцией — остаётся нетронутой как
резерв. Физическое удаление старой таблицы — отдельный шаг под-задачи депрекейта,
только с явным подтверждением оператора. До удаления откат = перечитать старую
таблицу (новые таблицы можно отбросить и построить заново).

## 5. Граница депрекейта (отдельная под-задача — здесь только фиксируется)

Не реализуется в этой фиче; переводится в устаревшее с проставлением **даты
последнего изменения кода** (по `git log` — `2026-09-05` для всех перечисленных
файлов):

| Что | Файлы / артефакты | Штамп |
|---|---|---|
| similar-дискавери | `src/features/discovery/similar.ts`, `src/scripts/ops/discovery-add-pool.ts`; специи `similar-channel-discovery`, `discovery-similar-parallel` | последнее изменение кода — 2026-09-05 |
| Пул-механика | таблица `agent_pools`; функции `getAgentPool`/`trySetAgentPool`/`setAgentPool`; NULL-пул (`getUnassignedChannels`/`assignChannel`); `src/scripts/ops/distribute-pool.ts`, `src/scripts/ops/import-agent-pool.ts`; специя `channel-pools` | последнее изменение кода — 2026-09-05 |

similar-дискавери и пул-механика **не переводятся** на мультиперсонность. Их
удаление функций доступа из `discovery.ts` (§2) согласовано с этой границей:
`getUnassignedChannels`/`assignChannel`/`getAgentPool`&Co. теряют живых
потребителей одновременно с депрекейтом.

**Не путать с депрекейтом:** `distribute-channels.ts` — не пул-механика, а вход
распределения; он **конвертируется** на персона-таргетинг и `runDistribution`
(§3.2.1), а не помечается устаревшим. Пул-скрипты `distribute-pool.ts` (берёт
NULL-пул) и `discovery-add-pool.ts`/`import-agent-pool.ts` (пул как имя) —
депрекейт по таблице выше.

## 6. Уровень изменения (agent-playbook)

**OpenSpec change** — меняется поведение системы (инвариант канала, единица
таргетинга), затрагивается несколько модулей и схема БД.

Затрагиваемые способности/специи в `openspec/specs/`:

| Спека | Характер дельты |
|---|---|
| `channel-registry` | инвариант «один канал — один агент на платформу» → «один канал — один агент в рамках персоны»; правило round-robin дискавери переформулировать в терминах агентов персоны |
| `channel-discovery`, `channel-discovery-avg-reach-gate` | дедуп и раскладка в рамках персоны; таргетинг персоной |
| `channel-distribution` | цель — имя персоны (убрать `parseAgentSpec`); дедуп/water-fill в рамках персоны; слияние redistribute |
| `channel-rotation` | ротация в рамках персоны источника; пустой слот (`agent_id NULL`) |
| `channel-cleanup` | удаление только закрепления в персоне агента (R7) |
| `funnel-report`, `funnel-metrics` | колонка «персона» вместо «пул» |
| `channel-operations-history` | поле `persona` в журнале (`operations`), разрез тайм-линии владения по `(chat_id, persona)` (§2.1) |
| `channel-pools`, `similar-channel-discovery`, `discovery-similar-parallel` | депрекейт (§5) |

Смежно обновить `docs/db-schema.puml` (две таблицы вместо одной) и
`docs/architecture.md` (реестр discovery).

## 7. Риски и обратная совместимость

| Риск | Влияние | Смягчение |
|---|---|---|
| Значение `persona` в конфигах ≠ `"maria"` | после миграции закрепления «висят» без агентов персоны | верификация §4.1 до запуска; при расхождении менять константу на фактическое значение (код — источник истины) |
| Битый `tg-account.json` при резолвинге персоны | агент выпадает из целей прогона | best-effort `buildPersonaIndex` (прецедент `listUsedProxyUsernames`); залогировать пропущенных |
| Окно «бан → первая ротация»: `agent_id` ещё указывает на забаненного агента | нет — забаненный агент неактивен, целью не станет; ротация суточная сверяет `channels.db` | осознанное решение §1.4; проверяемые AC описывают состояние после ротации |
| Скрытый потребитель `discovered_channels`/`agent_pools` (например, skill на VPS) | сломается чтение | перед физическим DROP — grep по `.claude/skills/` и `*.py` (прецедент скрытого читателя funnel.db); таблицу оставить до подтверждения |
| Два определения стартовой нагрузки (distribution — из реестра, rotation — из `channels.db`) | рассинхрон восприятия нагрузки | сохранено намеренно (разные стратегии балансировки); обе сужаются по персоне тождественно |
| FK `channel_assignments → channels` при включённом `PRAGMA foreign_keys` | вставка закрепления без реестровой строки упадёт | `assignToPersona` делает `ensureChannel` в той же транзакции до вставки закрепления |
| Распределение на персону без активных агентов | тихая потеря входа (`planDistribution` → `[]`, `added=0`) | явный отказ до классификации (§3.2.2) — новый критерий приёмки в ТЗ |
| Опечатка/неизвестное имя персоны (бот, скрипты) | прогон уходит «в никуда» | валидация против множества известных персон `buildPersonaIndex().values()` с отказом (§3.2.3) |
| Один `chat_id` — несколько владельцев в разных персонах в журнале | неоднозначная тайм-линия владения | поле `persona` в `operations`, разрез `(chat_id, persona)` (§2.1) |
| Три расходящихся входа распределения (бот, redistribute, distribute-channels) | разный дедуп/балансировка, обход персона-разреза | все сведены на `runDistribution(rows, persona, ...)` (§3.2.1, §3.4) |

**Обратная совместимость данных.** Пути файлов не меняются (§config). Старая
таблица сохраняется до подтверждённого удаления — откат без потери данных.

## 8. Порядок внедрения

1. **Схема + миграция** (`core/db/discovery.ts`): две таблицы, `ensureSchema`
   создаёт их и переносит данные (§4). Старую таблицу не трогать. Заодно —
   аддитивная колонка `operations.persona` в журнале (`core/db/channel-operations.ts`,
   §2.1) и переименование `distribution_tasks.agents_spec` → `persona`
   (`core/db/distribution.ts`, §3.2.3).
2. **Функции доступа** (§2): `ensureChannel`, `assignToPersona`, `getAssignment`,
   `assignmentCountsForPersona`, `setAssignmentAgent`, `removeAssignment`; перевод
   метрик на `channels`. Удаление `getUnassignedChannels`/`assignChannel` — вместе
   с депрекейтом (§5), не раньше снятия их вызовов.
3. **Резолвинг персоны** (`core/config.ts` + feature-хелпер `resolvePersonaTargets`).
4. **Способности** (§3): discovery → distribution (все три входа на
   `runDistribution`: бот-листенер §3.2.3, redistribute §3.4, distribute-channels
   §3.2.1) → rotation → funnel-report. Каждая переключается на персона-таргетинг
   и персона-дедуп независимо; отказ при пустой персоне (§3.2.2) и проброс
   `persona` в журнал (§2.1) — в этом же шаге.
5. **Депрекейт** (§5) — отдельной под-задачей после того, как способности снялись
   с пул-механики и similar-дискавери.
6. **Документация**: `db-schema.puml`, `architecture.md`, специи OpenSpec.

Порядок обеспечивает работоспособность на каждом шаге: миграция и функции
доступны раньше, чем способности начнут их использовать; удаление мёртвых функций
— последним.
