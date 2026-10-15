# Резерв готовых аккаунтов персоны — архитектура

Design-doc (HOW). Источник требований (ЧТО/ЗАЧЕМ) — [requirements-v1.md](requirements-v1.md),
на требования ссылаюсь как R1…R20 / AC-1…AC-13. Фиксируются принятые решения, включая
развилки, разрешённые координатором (момент установки инвайт-ссылки — §5, §6.4; объём
активации — §6.3). Инвайт-ссылку ставит сам скилл провиженинга (не `private-invite-links`)
— соответствует R4/AC-11.

Опора на код (источник истины, ветка `refactoring-2`): существующие три пути подготовки
аккаунта уже построены вокруг общих примитивов — единый процесс
`tg-agent-autoregistration` (монолит, помечен DEPRECATED в `index.ts`, но его
логика настройки жива в `core/tdata/account-setup.ts`), фаза 1
`tg-agent-pool-provision` и фаза 2 `tg-agent-persona-deploy`. Новый (третий) путь
собирается из тех же примитивов и ничего в них не переопределяет.

---

## 1. Резюме решения

Фича добавляет **третий путь подготовки** и **два триггера активации**, не трогая
логику настройки аккаунта:

1. **Провижен-в-резерв** — новый feature-модуль `src/features/tg-agent-reserve-provision/`,
   построенный по образцу `tg-agent-pool-provision/run.ts`. Делает ровно то же, что
   единый процесс `tg-agent-autoregistration` (`prepareAccount` с созданием публичного
   канала + регистрация агентской сессии), но промоутит результат не в
   `workspace-agent<N>`, а в **резерв** `workspace-reserve-<persona>-<K>` с собственной
   пер-персонной нумерацией (R5, R6, R7, R8).

2. **Активация** — общий примитив (валидация подключением → атомарный claim →
   финализация жизненного цикла), вызываемый двумя триггерами:
   - **Триггер 1** — доработанный `banned-account-replacement`: берёт аккаунт из
     резерва **той же персоны**, что у забаненного агента, вместо «взять обезличенный
     пул-аккаунт и настроить под персону» (R16); персону больше **не применяет** и
     канал **не создаёт** (R13) — аккаунт резерва уже полностью настроен.
   - **Триггер 2** — новый скилл ручной активации `tg-agent-reserve-activate`: человек
     выбирает аккаунт резерва, система присваивает ему новую метку `agent<N>` (R17).

**Невидимость резерва рабочему контуру (R11, R12, AC-3) достигается выбором имени
каталога и не требует правок перечислителей.** Все четыре сканера `~/.openclaw/workspace-*`
отбирают по префиксу/регулярке, которым `workspace-reserve-*` не соответствует:
`listAgentIds` (префикс `workspace-agent`), `listPoolAccountIds` (префикс
`workspace-emptyAccount`), `computeNextAgentNumber` (`^workspace-agent(\d+)`),
`computeNextPoolNumber` (`^workspace-emptyAccount(\d+)`). Диспетчер, планировщик,
воронка и discovery ходят через `listAgentIds` — резерв в выборку не попадает, прогрев
и задачи по нему не идут (так же, как обезличенный пул уже невидим рабочему контуру).

---

## 2. Переиспользование

### 2.1 Берётся без изменений

| Что | Где | Роль в резерв-провиженинге |
|---|---|---|
| `downloadTdataArchive` (+ extraFile) | `features/tg-agent-autoregistration/run.ts` (экспортирован) | скачивание tdata-архива (Mega / Google Drive), как в фазе 1 |
| `selectWorkingProxy` | `features/tg-agent-autoregistration/proxy-selection.ts` | подбор мобильного прокси с лимитом попыток (R1) |
| `connectBootstrap`, `readAccountPhone`, `prepareAccount`, `createPersonaChannel`, `TdataSetupError` | `core/tdata/` (`account-setup.ts`) | bootstrap-сессия из tdata + гигиена → профиль/фото (`prepareAccount` с `createPublicChannel=false`), затем отдельным вызовом `createPersonaChannel(..., funnelInviteLink)` — **публичный канал персоны с постом, закрепом и уже вставленной персональной инвайт-ссылкой** → `getMe` (R2, R3, R10). Оба метода уже экспортированы; `account-setup.ts` не меняется (см. §5) |
| `registerAgenticSession` | `features/tg-agent-autoregistration/agentic-session.ts` | вторая (агентская) MTProto-сессия (R10) |
| `exportChatInvite` + `upsertPrivateInviteLink`/`markPostUpdated`/`getPrivateInviteLink` | `core/telegram/service.ts`, `core/db/private-invites.ts` | получить персональную инвайт-ссылку от `REPORT_AGENT_ID` и записать её в реестр (ключ — `reserveId`) — тот же путь, что `features/persona-apply/apply-persona.ts` (§5) |
| `loadPersonaTemplate(persona, requireChannel=true)` | `features/tg-agent-autoregistration/persona-template.ts` | шаблон персоны с канальными файлами (`post.txt`, фото) |
| `loadAccountDefaults` | `core/config.ts` | общие `apiId`/`apiHash`/целевой 2FA из `~/.openclaw/account-defaults/` |
| `assignUsernameForAgent` / `generateUsername` | `features/tg-agent-autoregistration/username.ts` / `core/pool-accounts.ts` | username аккаунта (R2) — канал получает `@<username>_ch` внутри `createPersonaChannel` |
| `validatePoolAccount`, `quarantinePoolAccount`, `claimPoolAccountTo`, `listPoolAccountsOldestFirst` | `core/pool-accounts.ts` | примитивы валидации/карантина/claim/«старейший первым» — **применимы к любому `workspace-<id>` с загружаемой сессией**, не только к пулу (см. 6.1) |
| `claimPoolAccount`, `buildIncoming`, `commitSwap`, `recoverAnchors`, фазовый маркер | `features/banned-account-replacement/swap.ts` | файловая подмена для триггера 1 — переиспользуется как есть, меняется только **источник** (резерв вместо пула) |
| `createOrUpdateTask`, `removeTask` | `core/scheduler-control.ts` | включение прогрева и подъём heartbeat-таймера при активации (R14) |
| `seedTransitions`, `listDueTransitions` | `core/db/lifecycle-transitions.ts` | отложенные переходы жизненного цикла (warmup→monitor-v5) при активации |

Ключевой факт по `prepareAccount`: публичный канал создаётся на bootstrap-сессии в один
прогон, в самый свежий момент настройки — это и есть обход `USER_RESTRICTED` (раздел 4
требований). Резерв-провижен вызывает тот же код, поэтому проблема создания канала в
нём не воспроизводится; активация канал **не трогает** (R13).

Инвайт-ссылка ставится **внутри скилла провиженинга**, при создании канала (R4, AC-11;
см. §5): аккаунт уходит в резерв уже полностью готовым (канал + пост + рабочая
персональная ссылка в приватный канал воронки).
Активация канал и пост **не трогает** — только перекеивает запись реестра на финальный
`agentId` без обращений к Telegram (§6.4).

### 2.2 Выносится в общий код (новое)

- `core/reserve-accounts.ts` — пер-персонный аналог `core/pool-accounts.ts`:
  перечисление резерва персоны «старейший первым», пер-персонная нумерация `K`,
  резолвинг `reserveId ⇄ workspace-reserve-<persona>-<K>`. Валидация и карантин
  **переиспускают** `validatePoolAccount`/`quarantinePoolAccount` (6.1) — не дублируются.
- `features/persona-account-reserve/activate.ts` — общая **финализация активации**
  (перекей инвайт-записи reserveId→agentId + прогрев + наполнение join-queue + посев
  отложенных переходов), вызывается обоими триггерами. Это выделение шагов 3–4 из
  нынешнего `banned-account-replacement/run.ts:activateAndFinalize`, **без** шага
  применения персоны (шаг 1–2 `applyPersonaToAccount`) и без снятия `banned` — последнее
  остаётся приватной деталью триггера 1.
- `core/db/private-invites.ts` — добавить `rekeyPrivateInviteLink(adminAgentId,
  fromAgentId, toAgentId)`: перенос строки реестра на новый ключ без вызовов Telegram
  (§6.4). Прочее поведение модуля не меняется.

---

## 3. Компоненты

| Компонент | Расположение | Роль |
|---|---|---|
| Резерв-провижен (Main) | `src/features/tg-agent-reserve-provision/run.ts` (новый) | цикл по аккаунтам: download → proxy → bootstrap → `prepareAccount(createPublicChannel=false)` → инвайт-ссылка от `REPORT_AGENT_ID` → `createPersonaChannel(..., link)` → агентская сессия → промоушен в резерв; `retryReserveManualCode` для `needs_manual_code` |
| Стейджинг/нумерация резерва | `src/features/tg-agent-reserve-provision/staging.ts` (новый) | `stagingDir`/`stagingTdataDir`, `writeStagingStatus`, `computeNextReserveNumber(persona)`, `promoteToReserve` (атомарный rename стейджинг → `workspace-reserve-<persona>-<K>`) |
| Примитивы резерва | `src/core/reserve-accounts.ts` (новый) | `listReserveAccountsOldestFirst(persona)`, `findValidReserveAccount(persona)`, резолвинг id/каталога; валидация/карантин — делегируют в `pool-accounts.ts` |
| Общая финализация активации | `src/features/persona-account-reserve/activate.ts` (новый) | `finalizeActivation(agentId, reserveId, adminAgentId)` — перекей инвайт-записи + прогрев + join-queue + переходы; `runReserveActivate(reserveId)` — драйвер ручной активации (триггер 2) |
| Доработка замены банов | `src/features/banned-account-replacement/run.ts` (правка) | `replaceOne`: источник = резерв персоны; без `applyPersonaToAccount`; перекей инвайт-записи reserveId→agentId; пер-персонный алерт R20 |
| Перекей реестра инвайтов | `src/core/db/private-invites.ts` (правка) | новый `rekeyPrivateInviteLink(adminAgentId, fromAgentId, toAgentId)` — перенос строки на новый ключ без Telegram (§6.4) |
| CLI-двойники (detached) | `src/scripts/ops/tg-agent-reserve-provision.ts`, `tg-agent-reserve-activate.ts` (новые) | тонкие обёртки над `run.ts`/`activate.ts` по образцу `ops/tg-agent-pool-provision.ts` / `ops/tg-agent-reauth-from-tdata.ts`; собственный жёсткий таймаут + `process.exit` + отчёт в Saved Messages (ADR 0008) |
| OpenClaw-тулы | `index.ts` (+3 регистрации) | `tg_agent_reserve_provision_run`, `tg_agent_reserve_provision_retry_code`, `tg_agent_reserve_activate` — `execute()` делегирует в `run.ts`/`activate.ts` напрямую, без LLM-цикла (ADR 0001) |
| Скиллы | `skills/tg-agent-reserve-provision/SKILL.md`, `skills/tg-agent-reserve-activate/SKILL.md` (новые) | сбор параметров + detached-запуск через `systemd-run` (образец `skills/tg-agent-pool-provision/SKILL.md`) |
| Спеки | `openspec/specs/persona-account-reserve/spec.md` (новая способность), правка `openspec/specs/banned-account-replacement/spec.md` | нормативное поведение |

Единственная новая зависимость в рантайме отсутствует — всё собирается из
установленных пакетов (`@mtcute/convert` и прочее уже стоят ради
`tg-agent-autoregistration`).

---

## 4. Представление «резерва» на файловой системе

### 4.1 Каталог и идентификатор

- Каталог аккаунта резерва: **`~/.openclaw/workspace-reserve-<persona>-<K>`**.
- Логический id (для `workspaceDir`/`loadAccountConfig`/`TelegramService.loadAccount`):
  **`reserve-<persona>-<K>`**. `workspaceDir("reserve-maria-3")` = `workspace-reserve-maria-3`
  — резолвинг совпадает без правок `config.ts`.
- `tg-account.json` — полноценный `AccountConfig`: `accountId = reserveId`, `persona`
  задана, `username` задан, `sessionString`/`sessionAuthorizedAt`/`proxy`/`device` —
  как у рабочего агента. Отличается от обезличенного пула (`PoolAccountConfig` без
  `persona`/`username`) именно наличием персоны (R6, R10).

Почему каталог вида `workspace-<id>`, а не отдельное дерево `~/.openclaw/reserve/…`:
валидация и подключение (`TelegramService.loadAccount` → `workspaceDir(id)`),
карантин (`quarantinePoolAccount` → `${workspaceDir}.invalid`) и claim
(`claimPoolAccountTo` → `renameSync(workspaceDir(src), dst)`) все работают от
`~/.openclaw/workspace-<id>/`. Размещение резерва в этом же пространстве имён даёт
переиспользование этих примитивов **без изменений**; при этом префикс `reserve-`
выводит каталог из-под всех действующих сканеров рабочего контура (раздел 1).

### 4.2 Разбиение по персонам и нумерация (R7, R8)

Персона закодирована **в имени каталога** — отбор резерва нужной персоны становится
дешёвой `readdir`-фильтрацией (как `listPoolAccountIds`), без открытия каждого
`tg-account.json`:

- `listReserveAccountsOldestFirst(persona)` — фильтр по префиксу
  `workspace-reserve-<persona>-`, остаток до `.invalid`/`.incoming` — цифры `K`;
  сортировка по `ctimeMs` каталога (как у пула: метка `K` переиспользуется во времени
  и монотонности возраста не гарантирует).
- `computeNextReserveNumber(persona)` — `max(существующие K данной персоны) + 1`, по
  сырым именам в `~/.openclaw` (включая `.invalid`/`.incoming`) и в стейджинге —
  точная калька `computeNextPoolNumber`, но со скоупом по персоне. Нумерация у каждой
  персоны своя (R7); метку `agent<N>` резерв **не занимает** до активации (R8, AC-2).

Поскольку персона всегда известна из контекста (вход провиженинга или `persona`
забаненного агента), парсить «персона vs K» из общего имени не требуется — скан идёт
по известному префиксу. Ограничение именования: имя папки персоны не должно иметь вид
`<другая-персона>-<число>` (у контролируемых имён персон — `maria`, `irina`,
`persona-template` — это выполнено; отмечено как риск 11.1).

### 4.3 Стейджинг и атомарный промоушен в резерв

По образцу `tg-agent-pool-provision/staging.ts`: до `done` аккаунт живёт в
`~/.openclaw/tg-agent-reserve-provisioning/staging/<reserveId>/` (вне `workspace-*`,
чтобы не стать видимым раньше времени). `promoteToReserve` собирает `tg-account.json`
рядом с уже скачанным `tdata/` и делает один `renameSync(staging → workspace-reserve-…)`
— атомарен в пределах одной ФС (всё под `~/.openclaw`). Это закрывает AC-1: после
`done` аккаунт целиком в резерве с меткой персоны, либо целиком в стейджинге при сбое.

### 4.4 Переходы состояний

```
  [provision]                         tg-agent-reserve-provision
  staging/<reserveId>  --renameSync--> workspace-reserve-<persona>-<K>   (done, в резерве)

  [активация, триггер 1 — замена бана]  источник = workspace-reserve-<persona>-<K>
  reserve  --claimPoolAccount(rename)--> workspace-<bannedAgentId>.incoming
           --buildIncoming + commitSwap--> workspace-<bannedAgentId>      (agentId/персона сохранены)

  [активация, триггер 2 — ручная]       источник = workspace-reserve-<persona>-<K>
  reserve  --claim(rename)--> workspace-agent<N>.incoming
           --renameSync------> workspace-agent<N>                         (новая метка N)

  [R19 непригоден]  reserve --renameSync--> workspace-reserve-<persona>-<K>.invalid   (карантин)
```

---

## 5. Третий скилл — провижен-в-резерв (поток)

`runReserveProvision({ personName, links, proxyRegion, maxProxyAttempts, twoFaPassword })`
— структура повторяет `runPoolProvision`:

1. **Pre-flight (до скачивания):** `loadPersonaTemplate(personName, true)` (канальные
   файлы обязательны — канал создаётся), `loadAccountDefaults`, непустой `links`.
   Нумерация **не** вычисляется заранее пачкой фиксированных меток: как у пула, базовая
   `K = computeNextReserveNumber(personName)`, далее `K, K+1, …` на аккаунт.
2. **Batch-скачивание** каждого архива в `stagingTdataDir(reserveId)`; ошибка одного —
   `setup_failed`, пачка продолжается.
3. **Цикл по аккаунтам** (последовательно, human-pacing между аккаунтами, как в фазах 1/2):
   1. `selectWorkingProxy` → `connectBootstrap` → `readAccountPhone`;
   2. `prepareAccount(client, template, twoFaPassword, username, log, /*createPublicChannel*/ false)`
      — гигиена/2FA/сброс сессий/профиль/фото, **без** создания канала;
   3. **инвайт-ссылка** — `exportChatInvite(funnelPrivateChannelId, { title: reserveId })`
      сессией `REPORT_AGENT_ID`; `upsertPrivateInviteLink(adminAgentId, reserveId, link, now)`;
   4. `createPersonaChannel(client, template, username, log, link)` — создаёт публичный
      канал с постом, в который ссылка уже вставлена; затем `markPostUpdated(adminAgentId, reserveId)`
      (пост готов, `post_updated=1` — перепубликация `private-invite-links` не нужна);
   5. `registerAgenticSession` → `promoteToReserve(reserveId, accountConfig)`.
   `accountConfig` несёт `persona=personName`, `username`, `sessionAuthorizedAt=now`.
   Шаги 3–4 — тот же путь получения ссылки, что `features/persona-apply/apply-persona.ts`,
   но ключ реестра — `reserveId` (финальный `agentId` ещё не присвоен). Единое соединение
   `REPORT_AGENT_ID` на всю пачку (как в фазе 2) переиспользуется для всех `exportChatInvite`.
4. **Терминальные статусы** — те же, что у единого процесса (R9, AC-10):
   `done` (в резерве) / `proxy_failed` / `setup_failed` / `needs_manual_code`.
   `retryReserveManualCode(reserveId, …)` повторяет только агентскую сессию без
   повторной гигиены (калька `retryPoolManualCode`).
5. **Отчёт** — `renderReport` по образцу фаз 1/2; доставка в Saved Messages
   `REPORT_AGENT_ID` делается ops-скриптом (ADR 0008).

Отличия от `tg-agent-autoregistration`: (а) промоушен в резерв
(`promoteToReserve(reserveId → workspace-reserve-<persona>-<K>)`) вместо
`promoteToWorkspace(agentId → workspace-agent<N>)` (R5); (б) персональная инвайт-ссылка
экспортируется и вставляется в пост **в самом скилле** (шаги 3–4), а не откладывается на
`private-invite-links` (R4, AC-11). Логика настройки аккаунта (`core/tdata/account-setup.ts`) не
меняется: `prepareAccount` и `createPersonaChannel` уже экспортированы и принимают нужные
параметры (`createPublicChannel`, `funnelInviteLink`) — разбивка на два вызова не требует
правок ядра.

---

## 6. Активация (общий примитив)

Активация в обоих триггерах состоит из трёх частей: **выбор + валидация (R19)** →
**атомарный claim (R15)** → **финализация жизненного цикла (R14)**. Канал при этом
никогда не создаётся (R13).

### 6.1 Валидация пригодности (R19, AC-12)

`findValidReserveAccount(persona, log)` — калька `findValidPoolAccount`, но по
`listReserveAccountsOldestFirst(persona)`: для каждого кандидата `validatePoolAccount(reserveId)`
(подключение сессией + `getMe`); `"invalid"` → `quarantinePoolAccount(reserveId)`
(каталог → `…-<K>.invalid`, статус по образцу `account_invalid`) и берём следующего
той же персоны (это и есть «добор» R16); `"skip"` (прокси/сеть/`SessionBusyError`) —
аккаунт остаётся в резерве, пробуем следующего; `"ok"` → возвращаем.

Важная деталь переиспользования: `validatePoolAccount` подключается загрузчиком
`{ pool: true }` (не требует `persona`). Для аккаунта резерва, у которого `persona`
есть, этот путь тоже валиден — он лишь подключается и зовёт `getMe`, игнорируя
`persona`. Поэтому функция применяется к `reserveId` **как есть**, без обобщения
сигнатуры; имена `*PoolAccount*` остаются пул-ориентированными по истории, но операция
общая (отмечено для спецификации).

### 6.2 Атомарный claim (R15, AC-8)

Claim — это `renameSync` каталога резерва в транзиентный `.incoming`-каталог целевого
id. `rename` в пределах ФС атомарен: при гонке двух процессов выигрывает ровно один,
проигравший получает `ENOENT`. Это единственная точка сериализации — отдельный лок не
нужен (тот же инвариант, что у claim пула в `swap.ts` и `persona-deploy`).

- Триггер 1: `claimPoolAccount(reserveId, bannedAgentId, log)` →
  `workspace-<bannedAgentId>.incoming` (переиспользуется из `swap.ts` как есть).
- Триггер 2: claim в `workspace-agent<N>.incoming`, где `N = computeNextAgentNumber()`
  с инкрементом при занятости — калька `claimPoolToNewAgent` из `persona-deploy/run.ts`
  (обобщить источник: `renameSync(workspaceDir(reserveId), incoming)`).

Валидация 6.1 идёт **до** claim (как в `persona-deploy`): TOCTOU-зазор безвреден —
реальный мьютекс это claim-rename, а победитель уже провалидирован; проигравший в
гонке получает `ENOENT` и (триггер 1) берёт следующего / (триггер 2) сообщает «уже
активируется».

### 6.3 Финализация жизненного цикла (R14, AC-7)

`finalizeActivation(agentId, reserveId, adminAgentId, log)` — выделенные из нынешнего
`activateAndFinalize` шаги, **без** применения персоны и без снятия `banned`:

- перекей инвайт-записи `reserveId → agentId` (§6.4);
- `createOrUpdateTask({ agentId, type: "account-warmup" })` — прогрев on + подъём
  heartbeat-таймера агента (первая активная задача);
- наполнение join-queue из реестра назначений (`listAgentAssignmentLinks` + `addJoinQueue`);
  для свежего `agent<N>` триггера 2 назначений обычно нет — очередь пуста, как у
  свежего агента фазы 2;
- `seedTransitions`: `start_join_queue` (+1 д), `enable_monitor_v5` и `disable_warmup`
  (+3 д) — дальше работает существующая lifecycle-машинерия; спец-онбординга у активации
  нет (решение координатора).

Персона, публичный канал и инвайт-ссылка в посте уже на месте с момента провиженинга —
`applyPersonaToAccount` **не вызывается** (R13, AC-4), канал/пост активация не трогает.
Это принципиальное упрощение относительно нынешней замены банов: её шаг 1–2 (создание
канала + вставка инвайт-ссылки) исключён.

### 6.4 Перекей инвайт-записи при активации (без Telegram)

Персональная инвайт-ссылка создана при провиженинге и записана в реестр
`private_invite_links` под ключом `reserveId` (с `post_updated=1`). URL ссылки ведёт в
общий приватный канал воронки и от конкретного аккаунта **не зависит** — он уже рабочий
и уже в посте. Поэтому активация лишь переносит запись реестра на финальный `agentId`,
**без обращений к Telegram**: `rekeyPrivateInviteLink(adminAgentId, reserveId, agentId)`
сохраняет `invite_link`/`created_at`/`post_updated` и меняет только ключ.

- Триггер 1 (замена): `agentId = bannedAgentId`. У него могла остаться прежняя запись —
  перекей её **перезаписывает** (внутри: удалить существующую строку `agentId`, затем
  сменить ключ строки `reserveId → agentId`).
- Триггер 2 (ручная): `agentId = agent<N>` — прежней записи нет, простая смена ключа.

`post_updated=1` сохраняется, поэтому `private-invite-links` не станет перепубликовывать
уже готовый пост. Telegram-side «title» ссылки остаётся `reserveId` (косметический
админ-ярлык, менять его означало бы вызов Telegram — сознательно не делаем).

---

## 7. Триггер 1 — доработка `banned-account-replacement` (R16, R20)

Правится только `replaceOne` (и алерт); `swap.ts`, фаза переходов, восстановление по
якорям — без изменений.

Новый `replaceOne(bannedAgentId)`:

1. `recoverAnchors` + проверка маркера — как сейчас (восстановление оборванной замены);
   при наличии маркера доигрывается только `finalizeActivation` (persona не применяется —
   значит резюмирование тривиально идемпотентно).
2. `persona = loadAccountConfig(bannedAgentId).persona` (Модель B — персона сохраняется).
3. **`reserveId = findValidReserveAccount(persona)`** — вместо `findValidPoolAccount`.
   Пусто / все непригодны → **R20** (см. ниже).
4. `claimPoolAccount(reserveId, bannedAgentId)` → `.incoming`.
5. `buildIncoming(bannedAgentId, reserveId, persona)` — переиспользуется, с одной
   поправкой по username: аккаунт резерва **уже персонализирован**, его `username`
   соответствует созданному публичному каналу (`@<username>_ch`), поэтому username из
   конфигурации резерва **сохраняется** (а не генерируется заново, как для обезличенного
   пула). `buildIncoming` username не перезаписывает — достаточно не добавлять
   регенерацию; `accountId=bannedAgentId`, `persona` совпадает.
6. `commitSwap`.
7. `finalizeActivation(bannedAgentId, reserveId, adminAgentId)` (внутри — перекей
   инвайт-записи `reserveId → bannedAgentId`, §6.4) → `clearMarker` →
   `clearRestriction(banned)` (commit point — `banned` снимается последним, R7 замены).

Инвайт-ссылка нового аккаунта уже создана при провиженинге и лежит в реестре под
`reserveId`; шаг 7 переносит её на `bannedAgentId` без вызовов Telegram, перезаписывая
прежнюю запись забаненного агента (§6.4). Канал и пост не трогаются (R13).

**R20 (пустой резерв персоны, AC-13).** Если `findValidReserveAccount(persona)` вернул
`null`: аккаунт агента не меняется, `banned` остаётся, владение каналами не трогается,
обезличенный пул под персону **не настраивается** (это заново создало бы канал на
ограниченном аккаунте и упёрлось бы в `USER_RESTRICTED`). Оператор оповещается
**один раз** до пополнения. Нынешний флаг-файл дедупликации — глобальный
(`~/.openclaw/banned-replacement/pool-empty-alerted`); R20 требует **пер-персонной**
семантики, поэтому флаг становится пер-персонным
(`reserve-empty-alerted-<persona>`), а снятие флага на старте прогона — для каждой
персоны, чей резерв непуст. Текст алерта меняется с «пул пуст» на «в резерве нет
готового аккаунта персоны `<persona>`».

Остальное поведение замены (сброс per-agent состояния через `buildIncoming`, отложенные
переходы, восстановление) не меняется (R16 явно это фиксирует).

---

## 8. Триггер 2 — скилл ручной активации (R17, AC-6)

`runReserveActivate(reserveId, log)`:

1. **Вход** — id аккаунта резерва (например `reserve-maria-3`), который выбрал оператор.
   (Удобную выдачу списка «что есть в резерве по персонам» дают
   `listReserveAccountsOldestFirst` по персонам — отдельный read-only тул/строка отчёта;
   не обязателен для активации.)
2. **Валидация (R19):** `validatePoolAccount(reserveId)`. `invalid` →
   `quarantinePoolAccount` + отчёт `account_invalid`, стоп. `skip` → отчёт «временно
   недоступен, повторить», стоп (не карантин). `ok` → далее.
3. **Claim (R15):** `N = computeNextAgentNumber()`, `renameSync(workspace-reserve-… →
   workspace-agent<N>.incoming)` с инкрементом `N` при занятости. `ENOENT` источника →
   «аккаунт уже активирован/забран» (конкурентная активация), стоп.
4. **Перепись конфигурации:** в `tg-account.json` `.incoming` — `accountId=agent<N>`;
   `persona`/`username` остаются (канал уже привязан к ним).
5. **Промоушен:** `renameSync(workspace-agent<N>.incoming → workspace-agent<N>)` —
   аккаунт становится видимым `listAgentIds`.
6. **Финализация:** `finalizeActivation(agent<N>, reserveId, adminAgentId)` — перекей
   инвайт-записи `reserveId → agent<N>` (§6.4, прежней записи нет — простая смена ключа)
   + прогрев on + переходы; join-queue пуст при отсутствии назначений.
7. **Отчёт** — присвоенный `N` и статус (`done` / `account_invalid` / `skip` / `taken`).

Метка `agent<N>` присваивается именно в момент активации (R17, AC-6); до этого резерв
занимает только метку `K` своей персоны.

---

## 9. Невидимость рабочему контуру (R11, R12, AC-3)

Достигается без правок перечислителей (раздел 1). Проверено по коду: единственные
обходчики `~/.openclaw/workspace-*` — `listAgentIds`, `listPoolAccountIds`,
`computeNextAgentNumber`, `computeNextPoolNumber`; ни один не матчит `workspace-reserve-*`.
Следствия:

- диспетчер (`dispatcher.ts --agent <id>`) по резерву не запускается — его инстанцируют
  systemd-таймеры только для существующих рабочих агентов, а их схему/наличие ведёт
  `listAgentIds`;
- воронка, discovery, distribution, `private-invite-links`, дневная сводка — все ходят
  через `listAgentIds` → резерв не обрабатывают;
- прогрев и задачи в резерве не заводятся (таблица `tasks` создаётся только при
  `finalizeActivation`).

Риск будущего (11.2): любой новый широкий сканер `workspace-*` обязан исключать и
`workspace-reserve-*`, и `workspace-emptyAccount*`. Решение — не плодить обходчиков, а
переиспользовать `listAgentIds`/`listPoolAccountIds`.

---

## 10. Detached-исполнение и отчёт (ADR 0008)

Оба новых скилла — долгие прогоны (bootstrap/MTProto/human-pacing) и не влезают в
~90 s watchdog вызова тула. Как у фаз 1/2:

- тул/скилл стартует ops-скрипт отсоединённо через `systemd-run` (transient-юнит, не
  committed `.service`) и сразу возвращает управление;
- ops-скрипт держит **собственный жёсткий таймаут** + финальный `process.exit` (гасит
  висящие GramJS-reconnect-клиенты) и доставляет итоговый отчёт в Saved Messages
  `REPORT_AGENT_ID`;
- таймаут провиженинга масштабируется по размеру пачки
  (`BASE + PER_ACCOUNT * accounts`, как `ops/tg-agent-pool-provision.ts`); ручная
  активация — один аккаунт, фиксированный бюджет (валидация + подключение), образец —
  `ops/tg-agent-reauth-from-tdata.ts`.

Та же логика доступна тонким тулом `index.ts` для коротких ручных вызовов (один
аккаунт), как у существующих скиллов.

---

## 11. Затрагиваемые модули и сущности

**Новые:** `features/tg-agent-reserve-provision/{run,staging}.ts`,
`features/persona-account-reserve/activate.ts`, `core/reserve-accounts.ts`,
`scripts/ops/tg-agent-reserve-provision.ts`, `scripts/ops/tg-agent-reserve-activate.ts`,
`skills/tg-agent-reserve-provision/SKILL.md`, `skills/tg-agent-reserve-activate/SKILL.md`,
`openspec/specs/persona-account-reserve/spec.md`.

**Правятся:** `features/banned-account-replacement/run.ts` (источник = резерв,
без `applyPersonaToAccount`, перекей инвайт-записи `reserveId → bannedAgentId`,
пер-персонный алерт), `core/db/private-invites.ts` (новый `rekeyPrivateInviteLink`),
`index.ts` (+3 регистрации), `openspec/specs/banned-account-replacement/spec.md`.

**Новое файловое пространство:** `~/.openclaw/workspace-reserve-<persona>-<K>[.invalid|.incoming]`,
`~/.openclaw/tg-agent-reserve-provisioning/staging/<reserveId>/`,
`~/.openclaw/banned-replacement/reserve-empty-alerted-<persona>`.

**Не меняются:** `core/tdata/account-setup.ts` (логика настройки аккаунта),
`core/pool-accounts.ts` (переиспускается), `swap.ts`, `scheduler-control.ts`,
`lifecycle-transitions.ts`, перечислители `config.ts`, фаза 1 (`tg-agent-pool-provision`)
и фаза 2 (`tg-agent-persona-deploy`) — оба существующих скилла остаются в работе
(R18, AC-9).

---

## 12. Trade-offs и риски

- **11.1 Имя персоны в имени каталога.** Выбор `workspace-reserve-<persona>-<K>` даёт
  дешёвый пер-персонный отбор `readdir`-ом, но накладывает ограничение на имена персон
  (не `<другая-персона>-<число>`). Для текущих персон выполнено; альтернатива — отдельное
  дерево `~/.openclaw/reserve/<persona>/<K>/`, но она ломает переиспользование
  `workspaceDir`/`validatePoolAccount`/`claimPoolAccountTo` и потребовала бы отдельного
  резолвинга путей. Выбран вариант с `workspace-`-префиксом ради максимального
  переиспользования примитивов.
- **11.2 Будущие сканеры `workspace-*`.** Невидимость резерва держится на префиксной
  фильтрации существующих перечислителей. Любой новый широкий обходчик обязан исключать
  резерв и пул — риск регресса; снижается тем, что канонический перечислитель один
  (`listAgentIds`).
- **Переиспользование пул-примитивов для резерва.** `validatePoolAccount`/
  `quarantinePoolAccount`/`claimPoolAccount` названы «про пул», но операция общая.
  Trade-off: не плодим близнецов (простота) ценой чуть размытой семантики имён —
  компенсируется комментариями и спекой `persona-account-reserve`.
- **Отказ от `applyPersonaToAccount` при активации.** Снимает риск повторного
  `USER_RESTRICTED` (канал не трогаем, R13) и ускоряет активацию: персона, канал и
  инвайт-ссылка нанесены при провиженинге; активация лишь перекеивает запись реестра
  (§6.4) без вызовов Telegram.
- **Инвайт-ссылка в скилле провиженинга, не в `private-invite-links` (R4, AC-11).**
  Аккаунт уходит в резерв полностью готовым (канал + пост + рабочая ссылка), активация
  ничего не публикует. Цена — косметический Telegram-«title» ссылки, остающийся
  `reserveId` после перекея (менять его — лишний вызов Telegram, не делаем).

---

## 13. Источники

- Требования: [requirements-v1.md](requirements-v1.md) (R1–R20, AC-1–AC-13).
- Переиспользуемая логика настройки: `docs/design/tg-agent-autoregistration/architecture.md`,
  `src/core/tdata/account-setup.ts` (`prepareAccount`, `createPersonaChannel`,
  `setupReplacementAccount`).
- Двухфазная модель и примитивы пула: `docs/design/tg-agent-pool-provisioning/`,
  `src/features/tg-agent-pool-provision/`, `src/features/tg-agent-persona-deploy/`,
  `src/core/pool-accounts.ts`.
- Потребитель-триггер: `docs/design/banned-account-replacement/`,
  `src/features/banned-account-replacement/{run,swap}.ts`.
- Инфраструктура: `src/core/config.ts` (`listAgentIds`, `listPoolAccountIds`,
  `workspaceDir`, `loadAccountConfig`, `loadAccountDefaults`), `src/scripts/dispatcher.ts`,
  `src/core/scheduler-control.ts`, `src/core/db/lifecycle-transitions.ts`.
- Detached-исполнение: `docs/decisions/0008-detached-execution-tool-watchdog.md`,
  `docs/decisions/0001-scripts-over-openclaw-agent.md`.
