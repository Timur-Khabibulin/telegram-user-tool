# Расщепление авторегистрации на пул + развёртывание персоны — архитектура

Design-doc (КАК). Источник требований (ЧТО) — [requirements-v1.md](requirements-v1.md)
(R1..R30, US-1..8, AC-1..15). Здесь фиксируется техническое решение по факту кода на
ветке `refactoring-2`.

Соседние доки, на которые всё опирается:
[tg-agent-autoregistration/architecture.md](../tg-agent-autoregistration/architecture.md)
(монолит, который расщепляем) и
[banned-account-replacement/architecture.md](../banned-account-replacement/architecture.md)
(первый потребитель пула — второй потребитель мы делаем параллельным ему).

Развилки, где выбор за координатором, помечены **[решение координатора]** и собраны в §13 —
до подтверждения в код не идут (принцип проекта «решение принимает человек»).

Статус: черновик архитектуры, до кода.

---

## 1. Резюме решения

Монолит `tg-agent-autoregistration` разрезается по естественному шву, который уже
частично прорезан в коде: `core/tdata/account-setup.ts` содержит **два** тела —
`prepareAccount` (полный монолитный конвейер) и `setupReplacementAccount` (настройка под
персону сессией агента, без 2FA/сброса сессий, добавлена для `banned-account-replacement`).
Мы формализуем этот шов в две способности:

- **Фаза 1 (продюсер пула)** — переиспользует весь bootstrap-контур автореги
  (`connectBootstrap`, `selectWorkingProxy`, `registerAgenticSession`, `readAccountPhone`,
  стейджинг+атомарный промоушен) и **гигиеническую** часть `prepareAccount`
  (удаление публичных каналов → смена 2FA → сброс чужих сессий). Персону не трогает
  (R8). Результат — `workspace-emptyAccount<K>`.
- **Фаза 2 (потребитель пула)** — **не** использует bootstrap. Берёт готовые пул-аккаунты
  «старейший первым», подключается **их агентской сессией** через `TelegramService`
  (как `tg-agent-channel-setup` и `banned-account-replacement`) и применяет персону
  ровно тем же `setupReplacementAccount` + инвайт-ссылка, что уже вызывает замена
  забаненного. Результат — `workspace-agent<N>`.

Ключевой архитектурный факт: **фаза 2 и persona-часть замены забаненного — это один и тот
же код**. Требование R20 прямо просит «чтобы устройство каналов нового агента совпадало с
тем, что даёт замена забаненного». Значит правильное решение — не писать вторую реализацию
применения персоны, а вынести уже существующую (`setupReplacementAccount` + экспорт
инвайта) в общий помощник и звать его из обоих потребителей. Это же автоматически закрывает
R28 (замена наделяет пул-аккаунт username персоны) и dev-развилку D.

Новое, чего в коде нет и что проектируется здесь:

1. Общий модуль пула `core/pool-accounts.ts`: порядок «старейший первым» + атомарный claim
   (dev C, R18/R19/R29) — вынимается из `banned-account-replacement/swap.ts`, чтобы оба
   потребителя ходили одним кодом и не потребляли аккаунт дважды.
2. Гигиенический экспорт `prepareEmptyPoolAccount` в `account-setup.ts` (dev A, R4–R6).
3. Общий помощник «применить персону к аккаунту сессией агента» (dev B/D, R20/R28).
4. Заготовка `~/.openclaw/account-defaults/default_agent_data.json` и её загрузчик; вынос
   apiId/apiHash/2fa из персоны (dev F, R26/R27).
5. Отдельный `loadPoolAccountConfig` для безымянного пул-аккаунта; общий `loadAccountConfig`
   остаётся строгим (dev E = E-b, R10).
6. Стейджинг/промоушен фазы 1 `staging/emptyAccount<K>` → `workspace-emptyAccount<K>`
   (dev G, R16).

Уровень изменения — **один OpenSpec change** на всю фичу (решено в explore).

---

## 2. Топология: две способности вокруг общего пула

```
Фаза 1 (продюсер)                     ПУЛ                     Фаза 2 (потребитель)
tg-agent-pool-provision ──produce──▶ workspace-       ──consume(oldest-first)──▶ tg-agent-persona-deploy
  bootstrap-сессия из tdata          emptyAccount<K>   \                          агентская сессия
  гигиена (каналы/2FA/сессии)                           \                         persona → workspace-agent<N>
  агентская сессия                                       \
  → staging/emptyAccount<K>                               └─consume(oldest-first)─▶ banned-account-replacement
                                                                                   (существующий, правится под R28)
```

Оба потребителя конкурируют за один пул и защищены одним механизмом атомарного claim
(§5). Порядок обхода — единый «старейший первым» (§5.1).

---

## 3. Фаза 1 — продюсер пула (dev A, dev G)

### 3.1 Что переиспользуется без изменений

Весь bootstrap-контур автореги переносится в фазу 1 как есть (это те же шаги R2/R3/R7):

| Модуль автореги | Роль в фазе 1 |
|---|---|
| `proxy-selection.ts` (`selectWorkingProxy`) | подбор мобильного прокси, R2, `proxy_failed` |
| `core/tdata/client.ts` (`connectBootstrap`, `readAccountPhone`) | bootstrap-сессия из tdata, R3 |
| `agentic-session.ts` (`registerAgenticSession`) | вторая (агентская) сессия, R7, `needs_manual_code` |
| `device-assignment.ts`, download-слой из `run.ts` | устройство и скачивание tdata-архива по ссылке |
| `staging.ts`-паттерн (tmp+rename статуса, атомарный промоушен) | R16, см. §3.4 |
| `retryManualCode` (из `run.ts`) | переезжает в фазу 1 целиком (R12) — тело не меняется, только другой финализатор промоушена |

### 3.2 Как разрезается `prepareAccount`

Сейчас `prepareAccount` (`account-setup.ts:232`) делает всё сразу:

```
deleteExistingPhotos → deleteAdminedPublicChannels → change2FA → resetOtherSessions
→ applyProfile → uploadProfilePhotos → [createPersonaChannel]
```

Первые четыре — гигиена, последние три — персона. Фаза 1 берёт **гигиену без фото**:

Новый экспорт в `account-setup.ts`:

```
prepareEmptyPoolAccount(client, currentPassword, twoFaTarget, log):
    deleteAdminedPublicChannels(client, log)   // R4 — снять будущий CHANNELS_ADMIN_PUBLIC_TOO_MUCH
    change2FA(client, currentPassword, twoFaTarget, log)  // R5
    resetOtherSessions(client, log)            // R6
```

Все три приватных хелпера уже лежат в этом файле — новый экспорт зовёт их напрямую, без
вынесения каждого (тот же приём, которым уже сделан `setupReplacementAccount`). Поведение
`prepareAccount` не трогаем (он уходит в депрекейт вместе с монолитом, §12) — аддитивно.

**Фото — только фаза 2 (M1, решение координатора, закрыто).** Все фото профиля персоны
накатываются в фазе 2 вместе с профилем/username/каналом через сессию агента
(`uploadProfilePhotos` внутри `setupReplacementAccount`, §6). Фаза 1 фото **не ставит** и
унаследованные фото **не удаляет** — это часть инварианта обезличенного пула (R8/R9: пул
несёт сессию/2FA/чистые сессии, не идентичность). Чужие фото продавца снимает первый шаг
`setupReplacementAccount` (`deleteExistingPhotos`) уже при развёртывании персоны — отдельная
чистка в фазе 1 не нужна и была бы лишним RPC на свежем аккаунте (риск `FLOOD_WAIT` без
пользы). Требования фазы 1 (R4–R6) фото не упоминают — противоречия нет.

### 3.3 Порядок шагов фазы 1 на один аккаунт

Внутри `selectWorkingProxy` (на каждую попытку прокси):

```
connectBootstrap(tdata, proxy, apiId, apiHash, device)   // apiId/apiHash — из account-defaults (§8)
phone = readAccountPhone(client)
prepareEmptyPoolAccount(client, currentPassword=входной 2FA, twoFaTarget=общий 2FA)
agentic = registerAgenticSession(client, apiId, apiHash, phone, proxy, общий 2FA)
→ finalize: staging/emptyAccount<K> собран → promote (§3.4)
```

Статусы наследуются от автореги (R13): `done` / `proxy_failed` / `setup_failed` /
`needs_manual_code`. Классификация — та же (`TdataSetupError` → `setup_failed`,
исчерпание прокси → `proxy_failed`, таймаут кода → `needs_manual_code`).

### 3.4 Стейджинг и промоушен фазы 1 (dev G, R16)

Полный аналог `staging.ts` автореги, но ключ — `emptyAccount<K>`, а не `agent<N>`, и
собственный корень (автореговский `~/.openclaw/tg-agent-autoregistration/` уходит с
монолитом):

- Корень: `~/.openclaw/tg-agent-pool-provisioning/staging/emptyAccount<K>/`.
- Статус пишется tmp+`renameSync` (атомарно), как `writeStagingStatus`.
- На `done`: в стейджинге собирается полное содержимое (`tdata/` + `tg-account.json` без
  persona/username, §7), затем один `renameSync(staging/emptyAccount<K>,
  workspace-emptyAccount<K>)` — атомарен в пределах одной ФС. Аккаунт становится виден
  `listPoolAccountIds()` только после переноса (R16).
- Не-`done` остаётся в стейджинге до ручного разбора (R16, AC-3), не переиспользуется
  автоматически.

`tg-account.json` пул-аккаунта: `accountId = "emptyAccount<K>"`, `apiId`/`apiHash`/
`sessionString`/`proxy`/`device` — заполнены; `persona`/`username` **отсутствуют** (R10).

### 3.5 Нумерация K (R11, dev G)

`computeNextPoolLabel()` = (максимальная присутствующая на диске метка среди **всех**
`workspace-emptyAccount<K>*`) + 1; при пустом пуле → 1.

**Важно:** сканировать не `listPoolAccountIds()` (он исключает `.invalid` и не видит
`.incoming`), а сырые базовые имена `workspace-emptyAccount<K>` во всех вариантах суффикса
(`.invalid`, `.incoming` от замены). Иначе переиспользуемая метка (R11 допускает
переиспользование) может совпасть с именем карантинного каталога `workspace-emptyAccount5.invalid`
и создать визуальную коллизию. Метка берётся по base-числу K до суффикса. Для пачки из N
архивов метки назначаются диапазоном `[K0 .. K0+N-1]` вверх (как `computeAgentIdRange`),
с проверкой, что диапазон свободен в стейджинге и в пуле (аналог `checkAgentIdRangeFree`).

---

## 4. Фаза 2 — потребитель пула (dev B)

### 4.1 Вход и оркестрация

Вход: `{ personName, count M }` (R17). Детерминированный one-shot, как продюсер: тонкий
OpenClaw-тул/CLI делегирует в `features/tg-agent-persona-deploy/run.ts` (имя условно,
§10). Detached-прогон (ADR 0008, см. §9), отчёт в Saved Messages `REPORT_AGENT_ID` (R25, как
у всех фоновых).

Цикл добора до M (R18). Номер N не ведётся in-memory счётчиком — он аллоцируется атомарно на
ФС на каждый аккаунт (§4.3, M4), чтобы параллельные прогоны фазы 2 не столкнулись номерами:

```
собрано = 0
while собрано < M:
    poolId = nextOldest(listPoolAccountsOldestFirst())   // §5 — просто чтение списка
    if !poolId: break                        // пул исчерпан → частичный успех (R18/R25)

    // 1. Эксклюзивно забрать пул-аккаунт в нейтральный temp (двойное потребление — §4.3)
    tmp = workspace-.pool-claim-<pid>-<poolId>
    if !claimPoolAccountTo(poolId, tmp): continue        // ENOENT → забрал другой потребитель

    // 2. Валидация на своём каталоге (§4.2)
    if invalid:  quarantine(poolId); continue            // account_invalid, R24
    if net/proxy error: return tmp → workspace-<poolId>; continue

    // 3. Атомарно аллоцировать N и въехать в него (§4.3)
    agentId = claimAgentNumber(tmp)          // rename tmp → workspace-agent<N>.incoming, ENOTEMPTY→N++

    // 4. Применить персону и промоутнуть
    try:
        applyPersonaToAccount(agentId, template, username=generateUsername(nick))  // §6
        promote workspace-agent<N>.incoming → workspace-agent<N>                    // R21
        status[agentId] = done; собрано++
    except setup_failed: оставить workspace-agent<N>.incoming для ручного разбора (R24, R23)
```

### 4.3 Атомарная выдача номера N и параллельные прогоны (M4, R22)

**Решение координатора (закрыто): параллельные прогоны фазы 2 РАЗРЕШЕНЫ**, не
сериализуются. Значит in-memory `N_start = max+1` на прогон недопустим (два процесса
вычислят одинаковый старт и заминтят один N). Номер аллоцируется атомарной операцией ФС,
согласованной с уже атомарным claim пул-аккаунта (§5.2):

- **Два независимых атомарных rename на аккаунт.** (1) claim пула:
  `renameSync(workspace-<poolId>, workspace-.pool-claim-<pid>-<poolId>)` — эксклюзивность
  пула (двойное потребление → ENOENT у проигравшего, берёт следующий). (2) claim номера:
  `renameSync(<tmp>, workspace-agent<N>.incoming)` от кандидата `N = computeNextAgentNumber()`
  вверх; **ENOTEMPTY/EEXIST → N++ и повтор**. Живая резервация номера всегда непуста (в
  каталоге лежит аккаунт), поэтому rename на занятый номер надёжно падает ENOTEMPTY, а не
  «молча заменяет пустой каталог» — это и делает детект коллизии номера надёжным.
- `computeNextAgentNumber()` = (max среди `workspace-agent<N>` **и** транзиентных
  `workspace-agent<N>.incoming`) + 1 — стартовый кандидат уже учитывает чужие резервации,
  ENOTEMPTY-повтор закрывает узкую гонку между вычислением и rename.
- Имя `workspace-.pool-claim-*` нейтрально: не матчит ни `workspace-agent` (`listAgentIds`),
  ни `workspace-emptyAccount` (`listPoolAccountIds`) — temp невидим обоим листингам.
- **Восстановление:** на старте прогона осиротевший `workspace-.pool-claim-<pid>-<poolId>`
  (упавший процесс) возвращается в пул `renameSync(→ workspace-<poolId>)` — poolId несёт
  само имя. Осиротевший `workspace-agent<N>.incoming` без последующего промоушена — след
  `setup_failed`, разбирается вручную (не переиспользуется автоматически, R24).

**Согласованность с `banned-account-replacement`** (номера НЕ минтит): замена забирает пул в
`workspace-<bannedAgentId>.incoming` под уже существующий id забаненного агента и конкурирует
с фазой 2 только за сам пул-аккаунт (шаг 1, ENOENT у проигравшего). Коллизии номеров с
заменой нет по построению: кандидаты фазы 2 стартуют с `max(существующие agent<N>)+1`,
строго больше любого номера уже существующего (в т.ч. забаненного) агента, — поэтому
`workspace-agent<N>.incoming`, который минтит фаза 2, никогда не совпадёт с `.incoming`
заменяемого агента.

### 4.2 Валидация перед потреблением (R19, R24 `account_invalid`)

Симметрично `banned-account-replacement.findValidPoolAccount`: подключить пул-аккаунт его
агентской сессией, `getMe()`; аккаунтная ошибка (`classifyAccountError`) → карантин
`.invalid` + берётся следующий (R19/AC-15). Прочая ошибка (прокси/сеть) → пропуск без
карантина (останется в пуле). Разница с заменой: у фазы 2 валидация и claim — на одном
и том же аккаунте, поэтому валидируем **после** claim (иначе гонка между валидацией и
claim'ом другого потребителя). Порядок: `claim → validate → (invalid ? quarantine+next :
apply)`. Так claim — точка эксклюзивности, а валидация уже на «своём» каталоге.

Статусы фазы 2 (R24): `done` / `setup_failed` / `account_invalid`. `skipped` не вводится
(R24 — у обезличенного пул-аккаунта канала персоны быть не может, guard из
`tg-agent-channel-setup` здесь не нужен, но безвреден — см. §6).

---

## 5. Общий пул: порядок и claim (dev C, R18/R19/R29)

### 5.1 Порядок «старейший первым»

Сейчас `listPoolAccountIds()` (`config.ts:100`) возвращает каталоги в порядке
`fs.readdirSync` — это порядок ФС, не «старейший первым». R29 требует **единый**
согласованный порядок у обоих потребителей.

«Старейший» ≠ по метке K: R11 переиспользует метки, поэтому меньший K не значит старше.
Правильный якорь возраста — **время появления каталога в пуле** (промоушен фазы 1). Берём
`ctimeMs`/`birthtimeMs` каталога `workspace-emptyAccount<K>` (сортировка по возрастанию).
Новый экспорт:

```
listPoolAccountsOldestFirst(): string[]   // config.ts или core/pool-accounts.ts
    = listPoolAccountIds(), отсортированный по stat(dir).ctimeMs возрастанию
```

`banned-account-replacement.findValidPoolAccount` переводится с `listPoolAccountIds()` на
`listPoolAccountsOldestFirst()` — это и есть выполнение R29 для замены (сейчас она берёт в
произвольном порядке ФС).

**[решение координатора, минорное]** M2: якорь возраста — `ctimeMs` каталога (рекомендация,
не требует новых полей) либо явный `createdAt` в `tg-account.json` пула (устойчивее к
`cp`/переносам ФС, но лишнее поле). Рекомендую `ctimeMs`: пул-каталоги создаются
`renameSync` в пределах одной ФС и `cp`-переносов не переживают по-другому и сейчас.

### 5.2 Атомарный claim — общий примитив

`claimPoolAccount` сейчас живёт в `banned-account-replacement/swap.ts:56` и жёстко
переименовывает в `workspace-<agentId>.incoming` (форма, нужная замене для swap над живым
workspace). Фазе 2 нужен другой destination (номера агента ещё нет на момент claim — он
аллоцируется отдельным rename, §4.3). Общий примитив — «атомарно забрать пул-каталог в
произвольный dest, false на ENOENT»:

```
// core/pool-accounts.ts (новый) — общий дом пула
claimPoolAccountTo(poolId, destDir, log): boolean   // renameSync(workspace-poolId, destDir); ENOENT→false
quarantinePoolAccount(poolId, log): void            // renameSync(..., .invalid) — перенесён сюда
listPoolAccountsOldestFirst(): string[]
```

- Замена: `claimPoolAccountTo(poolId, workspace-<agentId>.incoming)` (её swap-логика и
  якоря `.incoming/.old` остаются в её `swap.ts` — не общие).
- Фаза 2: `claimPoolAccountTo(poolId, workspace-.pool-claim-<pid>-<poolId>)` — нейтральный temp
  до аллокации номера N (§4.3), затем второй rename `tmp → workspace-agent<N>.incoming`.

Двойное потребление исключено самим `renameSync`: пул-каталог физически один, выигрывает
ровно один claim, второй получает ENOENT и берёт следующий (R19/AC-9). Никаких lock-файлов.
`listPoolAccountIds` остаётся в `config.ts` (его зовёт и alert-путь замены); новый модуль
`core/pool-accounts.ts` импортирует его. **[решение координатора, минорное]** M3: держать
claim/quarantine в `core/pool-accounts.ts` (рекомендация — нейтральный дом для двух
потребителей) либо оставить в `swap.ts` и импортировать оттуда в фазу 2 (меньше файлов, но
«потребитель импортирует из другого потребителя» — хуже по зависимостям).

---

## 6. Общий шаг «применить персону» (dev B, dev D, R20/R28)

Persona-часть у фазы 2 и у замены забаненного **идентична по требованию** (R20 явно про
паритет). В коде она уже есть — `banned-account-replacement/run.ts:activateAndFinalize`,
шаги 1–2:

1. `setupReplacementAccount(client, template, username)` — сессией агента:
   `deleteExistingPhotos → deleteAdminedPublicChannels → applyProfile(username) →
   uploadProfilePhotos → createPersonaChannel` (публичный канал + пост + закреп).
2. приватная инвайт-ссылка: `exportChatInvite(FUNNEL_PRIVATE_CHANNEL_ID, {title: agentId})`
   от `REPORT_AGENT_ID` → `upsertPrivateInviteLink(...)` (ставит `post_updated=0` = «на
   перепубликацию»).

Выносим шаги 1–2 в общий помощник:

```
// core/tdata/apply-persona.ts (новый) или экспорт в account-setup.ts
applyPersonaToAccount(agentId, template, username, log):
    tg.loadAccount(agentId); tg.withActiveClient(c => setupReplacementAccount(c, template, username))
    invite.loadAccount(REPORT_AGENT_ID); link = exportChatInvite(...); upsertPrivateInviteLink(...)
```

Оба потребителя зовут его. Фаза 2: `agentId = agent<N>`, `username` генерируется из персоны
(§6.1). Замена: `agentId` заменяемого, `username` — тоже генерируется из персоны (это и есть
правка dev D, §6.2).

**Guard «канал уже есть».** `banned-account-replacement` полагается на идемпотентность
(повтор активации после сбоя). Для фазы 2 повтора нет (сбой → `setup_failed`, аккаунт
остаётся в стейджинге, следующего забора того же аккаунта нет). Guard `getOwnPersonalChannel`
из `tg-agent-channel-setup` фазе 2 не обязателен, но общий помощник его сохраняет (безвреден,
делает помощник переиспользуемым для замены, где повтор возможен).

### 6.1 username фазы 2 (R20)

`username = generateUsername(template.profileData.nick)` — существующий генератор
`autoreg/username.ts:generateUsername` (nick + случайное слово + число). Он не завязан на
стейджинг (в отличие от `assignUsernameForAgent`, который персистит в `staging/username.txt`).
`generateUsername` переносим в общий дом (`core/pool-accounts.ts` или `core/tdata/`), т.к. им
теперь пользуются продюсер был не нужен, а **фаза 2 и замена** — да. Значение пишется в
`tg-account.json` агента до/в момент промоушена и применяется внутри `applyProfile`.

### 6.2 Правка consume-пути замены забаненного (dev D, R28)

Сейчас `swap.ts:buildIncoming:101` копирует `username` из пул-аккаунта в новый конфиг, а
`activateAndFinalize` читает `cfg.username` и падает, если его нет (`run.ts:191`). Пул теперь
**безымянный** (R10) → `cfg.username` будет `undefined` → активация замены сломается. Это
прямо отменяет прежнее решение banned-replacement M4 («брать username из пула»).

Правка: `buildIncoming` больше **не** копирует username из пула (его там нет);
`activateAndFinalize` вместо чтения `cfg.username` **генерирует** username из персоны
заменяемого агента (`generateUsername(template.profileData.nick)`), пишет его в
`tg-account.json` и передаёт в общий `applyPersonaToAccount`. Так замена наделяет обезличенный
аккаунт username персоны — R28, и сходится с фазой 2 (один код §6). Побочно (уже отмечено в
banned-replacement §6): публичный username агента меняется при каждой замене — неизбежно,
старый умер с аккаунтом.

### 6.3 Приватный канал агента — инвайт в общий канал воронки (R20, вариант А)

**Решение координатора (закрыто):** отдельный приватный канал на персону/агента **не
создаётся**. «Устройство каналов», которое фаза 2 обязана воспроизвести (на паритет с
которым ссылается R20), — это инвайт-ссылка в **общий** приватный канал воронки
`FUNNEL_PRIVATE_CHANNEL_ID`, экспортируемая `REPORT_AGENT_ID` и сохраняемая в
`private-invites.db` (§6, шаг 2). Это соответствует коду: ни автореги, ни замена, ни
`setupReplacementAccount` персонального приватного канала не заводят.

R20 в requirements приводится к этой редакции (вариант А) параллельно — правку требования
ведёт аналитик. Архитектура (§6) этому уже соответствует: фаза 2 делает **ровно то же**, что
замена — экспорт инвайта в общий канал воронки, `upsertPrivateInviteLink` с `post_updated=0`.

---

## 7. Схема `tg-account.json` пула и загрузчики (dev E, R10/R27)

Пул-аккаунт по R10 не несёт `persona` и `username`. Сейчас `loadAccountConfig`
(`config.ts:520`) **бросает**, если нет `persona`. А `TelegramService.loadAccount`
(`service.ts:288`) зовёт именно `loadAccountConfig`, и оба потребителя валидируют пул через
`tg.loadAccount(poolId)` → значит с безымянного пула это упадёт до `getMe()`.

Кто реально читает поле `persona` из загруженного конфига (grep): `dispatcher`,
`buildPersonaIndex`, `banned-replacement` (персона заменяемого **агента**, не пула),
`tg-agent-channel-setup`. **Все они работают по `listAgentIds()` (рабочие агенты), пул туда
не попадает.** Пул-аккаунт загружается только для (а) connect+`getMe` при валидации и (б)
применения персоны из **шаблона** (не из конфига). Значит `persona` в конфиге пула не нужна
никому.

**Решение координатора (закрыто): E-b — отдельный загрузчик пула, НЕ ослабление общего.**
`loadAccountConfig` **остаётся строгим** (требует `persona` — рабочий контур сохраняет
fail-fast как есть, тип `AccountConfig.persona` не трогается). Пул-аккаунт читается отдельным
загрузчиком:

- **`loadPoolAccountConfig(poolId): PoolAccountConfig`** — новый узкий загрузчик и тип. Валидирует
  только `apiId`/`apiHash`/`sessionString` (обязательны для connect), парсит `proxy`/`device`;
  **без** `persona`/`username`. `accountId = "emptyAccount<K>"` (пишет фаза 1) — важно для
  session-lock/clientKey (`accountId` идёт в `clientKey`); плейсхолдер `"default"` из
  `cfg.accountId ?? "default"` для пула нежелателен (два пул-аккаунта дали бы один clientKey).
- **`TelegramService.loadAccount(id, { pool?: boolean })`** — при `pool: true` грузит через
  `loadPoolAccountConfig` вместо `loadAccountConfig`. Оба потребителя вызывают
  `tg.loadAccount(poolId, { pool: true })` при **валидации** и применении персоны на пуле.
- Персона в конфиг пула не пишется до промоушена: итоговый `tg-account.json` собирается с
  `persona` уже под именем агента (как `buildIncoming` у замены / промоушен фазы 2), после
  чего загрузка идёт обычным строгим `loadAccountConfig`.

**Трейд-офф (принят координатором):** `loadPoolAccountConfig` дублирует чтение/валидацию
`proxy`/`device` из `loadAccountConfig` и вводит второй узкий тип + ветку в `loadAccount`.
Это приемлемо: явное разделение «рабочий агент» и «обезличенный пул-аккаунт» на уровне
загрузчиков не размывает fail-fast общего конфига и не ослабляет `AccountConfig.persona` для
40+ читателей (альтернатива E-a — `persona?`+`requirePersona`-флаг — отклонена именно из-за
ослабления типа в рабочем контуре). Дублирование парсинга proxy/device можно свести к
общему приватному хелперу `parseProxy/parseDevice`, чтобы оба загрузчика звали его —
рекомендация по реализации (не обязательна).

---

## 8. Общая заготовка учётных данных (dev F, R26/R27)

Сейчас apiId/apiHash/2fa лежат в `default_agent_data.json` **внутри** папки персоны и
читаются `loadPersonaTemplate` (`persona-template.ts:128,137`). Это общие для всех аккаунтов
значения — их место вне персоны (R26).

- **Рантайм-путь:** `~/.openclaw/account-defaults/default_agent_data.json` (тот же профиль,
  что `~/.openclaw/personas/`).
- **Исходник в репозитории:** новая папка `persona/account-defaults/default_agent_data.json`
  (рядом с `persona/persona-template/`, `persona/irina/` — они уже переехали под `persona/` по
  git-статусу). Деплой — тем же `scp`, что персоны (operation.md).
- **Загрузчик:** новый `loadAccountDefaults(): { apiId, apiHash, "2fa" }` (в
  `core/config.ts` или рядом с продюсером), читает рантайм-путь, валидирует три поля.
  **Читает его только фаза 1** (R27): apiId/apiHash идут в `connectBootstrap`/
  `registerAgenticSession`, общий 2FA — в `prepareEmptyPoolAccount`(target) и как «2fa
  агентской сессии» в `registerAgenticSession`.
- **Персона больше не содержит apiId/apiHash/2fa.** Из `PersonaTemplate` убирается
  `defaultAgentData`; `loadPersonaTemplate` перестаёт требовать/читать `default_agent_data.json`
  из папки персоны. Тип `DefaultAgentData` переезжает к загрузчику заготовки.
  Потребители `template.defaultAgentData` сегодня — только автореговский `run.ts` (уходит) и
  `retryManualCode` (переезжает в фазу 1, будет брать из заготовки). Фаза 2 и
  `tg-agent-channel-setup` `defaultAgentData` не читают — их не заденет.
- Файлы персон (`persona/*/default_agent_data.json`) и шаблон
  `persona/persona-template/default_agent_data.json` из папок персон удаляются (значения
  переносятся в единую заготовку) — **необратимое удаление данных персоны, §13/Q2, требует
  подтверждения человека** (agent-playbook «Обратимость»).

---

## 9. Detached-исполнение (ADR 0008)

Обе фазы — долгие прогоны: фаза 1 — пачка аккаунтов с подбором прокси и скачиванием
tdata-архивов (минуты–десятки минут), фаза 2 — цикл добора до M с per-account применением
персоны (минуты на аккаунт). Оба заведомо превышают per-tool-call watchdog runtime агента
(~90 s). Значит **обе фазы обязаны следовать**
[ADR 0008 «Detached-исполнение долгих операций вне per-tool-call watchdog»](../../decisions/0008-detached-execution-tool-watchdog.md)
— ровно как монолит-автореги уже следует ему сегодня. Ниже detached-контур сделан явным для
**обеих** фаз (в §3.3/§4.1 он упомянут вскользь — здесь связывается с 0008 нормативно).

### 9.1 Контракт тула/скилла (обе фазы)

- Логика — чистая функция `features/<phase>/run.ts` + ops-скрипт `src/scripts/ops/<phase>.ts`
  (ADR 0008, раздел «Решение»).
- OpenClaw-тул/скилл **только стартует detached job** через `systemd-run` (transient-юнит) и
  сразу возвращает управление; он НЕ исполняет прогон синхронно и НЕ возвращает итог ответом
  тула.
- Итог уходит **асинхронно в Saved Messages `REPORT_AGENT_ID`**, а не ответом тула (ADR 0008,
  «Последствия»: «Отчёт приходит асинхронно, а не ответом тула»). Для фазы 1 это R15, для
  фазы 2 — R25; один и тот же механизм доставки (образец —
  `ops/tg-agent-autoregistration.ts`, отправка `sendSavedMessage` после `main()`). Синхронный
  плагин-тул остаётся только для точечных случаев/ретраев, не для пачки — как у автореги.

### 9.2 Обязательный внутренний жёсткий таймаут (обе фазы)

ADR 0008, «Последствия»: «Каждый ops-скрипт обязан иметь внутренний таймаут — иначе зависший
процесс не снять» (в detached watchdog'а, который снял бы зависший процесс, нет). Требование к
**обоим** ops-скриптам:

- **Фаза 1 — критично:** цикл по пачке с подбором прокси и скачиванием архивов; висящий
  прокси-connect или ушедший в reconnect GramJS-клиент держат event loop живым. Автореговский
  `ops/tg-agent-autoregistration.ts` уже гасит это принудительным `process.exit(0/1)` после
  `main()` (висящие после reconnect GramJS-клиенты не отпускают `_updateLoop` даже после
  `disconnect()`) — фаза 1 наследует тот же приём и добавляет верхний timeout на прогон.
- **Фаза 2:** цикл добора до M с connect каждого пул-аккаунта на валидации/применении персоны;
  тот же обязательный timeout + принудительный exit.

Конкретные величины таймаутов — на реализации (§14 «Открыто»).

### 9.3 systemd (деплой обеих фаз)

Обе фазы — **operator-triggered one-shot detached job**, как автореги, а не периодическая
задача. Поэтому запускаются **transient-юнитом `systemd-run`** из своего `SKILL.md` (образец —
`skills/tg-agent-autoregistration/SKILL.md`, шаг 2), а НЕ committed `.service`-файлом в
`deploy/systemd/`. Committed юниты (`tg-agent@.service` — шаблонный per-agent heartbeat;
`tg-banned-replacement-sweep.service` — периодический sweep) — образец **только** для
периодических/шаблонных задач; для фаз их заводить не нужно. Параметры `systemd-run` — по
образцу автореги: `--property=Type=oneshot`, `WorkingDirectory=<cwd плагина>`,
`EnvironmentFile=-/root/.openclaw/secrets.env` (для `ASOCKS_API_KEY` — подбор прокси фазы 1),
`--collect`, запуск `tsx src/scripts/ops/<phase>.ts …`. Наблюдаемость и остановка — journal и
`systemctl` соответствующего transient-юнита (ADR 0008, «Последствия»: «наблюдаемость и
остановка — через systemd»).

---

## 10. Компоненты

| Компонент | Расположение | Роль |
|---|---|---|
| Фаза 1 `Main` | `src/features/tg-agent-pool-provision/run.ts` (новый) | оркестрация продюсера: скачивание, цикл по аккаунтам, bootstrap+гигиена+агентская сессия, стейджинг/промоушен, отчёт; `retryManualCode` переезжает сюда |
| Фаза 1 гигиена | `core/tdata/account-setup.ts` — новый экспорт `prepareEmptyPoolAccount` | R4–R6 без фото и без персоны (§3.2) |
| Фаза 1 стейджинг | `src/features/tg-agent-pool-provision/staging.ts` (новый) | `staging/emptyAccount<K>` → `workspace-emptyAccount<K>`, нумерация K (§3.4/3.5) |
| Фаза 2 `Main` | `src/features/tg-agent-persona-deploy/run.ts` (новый) | оркестрация потребителя: цикл добора до M, claim+валидация, applyPersona, промоушен в `workspace-agent<N>`, отчёт |
| Общий пул | `src/core/pool-accounts.ts` (новый) | `listPoolAccountsOldestFirst`, `claimPoolAccountTo`, `quarantinePoolAccount`, `generateUsername` (§5, §6.1) |
| Общий apply-persona | `core/tdata/apply-persona.ts` (новый) или экспорт в `account-setup.ts` | `applyPersonaToAccount` = `setupReplacementAccount` + инвайт (§6); зовут фаза 2 и замена |
| Заготовка creds | `core/config.ts` (+`loadAccountDefaults`), `~/.openclaw/account-defaults/`, репо `persona/account-defaults/` | dev F, §8 |
| Загрузчик конфига пула | `core/config.ts` — новый `loadPoolAccountConfig`/`PoolAccountConfig`; `TelegramService.loadAccount(id,{pool})` | dev E = E-b; общий `loadAccountConfig` остаётся строгим (§7) |
| Правка замены | `banned-account-replacement/{run.ts,swap.ts}` | username из персоны вместо пула (dev D, §6.2); переход на `listPoolAccountsOldestFirst` (§5.1); claim через общий примитив |
| Загрузчик персоны | `tg-agent-autoregistration/persona-template.ts` | убрать `defaultAgentData` (§8); файл переиспользуется фазой 2 (`loadPersonaTemplate(persona, true)`) |
| ops-скрипты (detached-вход) | `src/scripts/ops/tg-agent-pool-provision.ts`, `src/scripts/ops/tg-agent-persona-deploy.ts` (новые) | тонкие обёртки над `run.ts` каждой фазы; собственный жёсткий таймаут + `process.exit` (§9.2); отправляют отчёт в Saved Messages; стартуются `systemd-run` из SKILL.md (§9.3) |
| Скилл фазы 1 | `skills/tg-agent-pool-provision/SKILL.md` (новый) | вызываемость из OpenClaw: собрать параметры (ссылки/2FA/регион/лимит попыток), старт detached через `systemd-run` (§9); образец — `skills/tg-agent-autoregistration/SKILL.md` |
| Скилл фазы 2 | `skills/tg-agent-persona-deploy/SKILL.md` (новый) | вызываемость из OpenClaw: вход `persona + M`, старт detached через `systemd-run` (§9); тот же образец |
| Плагин-тулы | `index.ts` (+2 тула фаза1/фаза2) | синхронные обёртки только для точечных случаев/ретраев (не для пачки — §9.1); депрекейт старых тулов (§12) |

Деплой — `scp`+`chown`+`gateway restart` для кода, плюс новая заготовка `account-defaults/`
(§8) и два новых `SKILL.md`. Оба прогона стартуют **не** committed `.service`, а
transient-юнитом `systemd-run` из своих SKILL.md (§9.3, ADR 0008). Новых npm-зависимостей нет
(`@mtcute/convert` уже в проекте).

---

## 11. Трассировка требований → решение

| Требование | Где |
|---|---|
| R1 (вход фазы 1) | §4.1-продюсер, §3.3 |
| R2/R3/R7 (прокси/bootstrap/агентская сессия) | §3.1 (переиспользование автореги) |
| R4/R5/R6 (каналы/2FA/сессии) | §3.2 `prepareEmptyPoolAccount` |
| R8 (без персоны) | §3.2, §3.4 (конфиг без persona/username) |
| R9/R10 (готовность и состав пул-аккаунта) | §3.4, §7 |
| R11 (метка K, переиспользование) | §3.5 |
| R12 (retryManualCode) | §3.1 (переезд в фазу 1) |
| R13/R14/R15 (статусы, изоляция, отчёт в Saved) | §3.3, наследуется от автореги |
| R16 (атомарный перенос, не-done в стейджинге) | §3.4 |
| R17/R18 (вход M, добор старейшими) | §4.1, §5.1 |
| R19 (атомарный claim, невалидный→next) | §5.2, §4.2 |
| R20 (persona: username/профиль/фото/публ.канал/инвайт) | §6, §6.3 |
| R21/R22 (→ рабочий агент, метка N) | §4.1 |
| R23/R24 (изоляция, статусы done/setup_failed/account_invalid) | §4.1, §4.2 |
| R25 (отчёт с итоговой строкой M/X) | §4.1 |
| R26/R27 (общая заготовка, читает только фаза 1) | §8 |
| R28 (замена наделяет username персоны) | §6.2 |
| R29 (единый порядок старейший-первым) | §5.1 |
| R30 (депрекейт монолита и persona-channel-setup) | §12 |

---

## 12. Депрекейт прежних способностей (dev H = H-b, R30)

**Решение координатора (закрыто): H-b — пометить `[DEPRECATED]`, снять на архивации change.**

Под депрекейт: тулы `tg_agent_autoregistration_run`, `tg_agent_autoregistration_retry_code`,
`tg_agent_channel_setup` (`index.ts`), функции `runAutoregistration`/`renderReport`, экспорт
`prepareAccount`/`createPersonaChannel`-как-самостоятельный-тул, спеки
`openspec/specs/tg-agent-autoregistration` и `openspec/specs/persona-channel-setup`, скилл
`persona-channel-setup`.

Тонкость: **часть монолита переиспользуется** новыми фазами (`connectBootstrap`,
`registerAgenticSession`, `selectWorkingProxy`, `setupReplacementAccount`,
`createPersonaChannel`, `persona-template.ts`). «Депрекейт монолита» = убрать точки входа
(тулы/спеки/скилл), а не удалять переиспользуемые модули — они переезжают под новые фазы.

Механика H-b (в этом change):

- **Тулы в `index.ts`** — в `description` каждого префикс `[DEPRECATED — используйте
  tg_agent_pool_* / tg_agent_persona_*]`; регистрация и код **остаются рабочими** до архивации.
- **Скиллы/спеки** — `SKILL.md` старых скиллов и спеки автореги/`persona-channel-setup`
  помечаются deprecated в тексте; change фиксирует их как выводимые из употребления, но
  **физически не удаляет**.
- **Удаление** регистраций, спеков и скиллов — **при архивации change** (`openspec archive`),
  не в этом change.

Обоснование H-b (совпало с рекомендацией архитектора): монолит — единственный проверенный на
реальных закупленных tdata путь (его спайк подтверждён прогонами до `done`, см. autoreg
architecture §2.1); фазы 1/2 — код, пока не прошедший реальный tdata. Пометка вместо удаления
даёт период сосуществования: рабочий путь жив как страховка, пока не подтверждено, что фаза 1
даёт валидные пул-аккаунты, а фаза 2 — рабочих агентов. Удаление — отложенным шагом на
архивацию.

---

## 13. Развилки

**Инженерные, ЗАКРЫТЫ (dev A–G — рекомендация архитектора; M1/M4/M5/H/R20 — решения
координатора; в код после подтверждения):**

- **dev A** — гигиена фазы 1 = новый `prepareEmptyPoolAccount` (каналы→2FA→сессии), тело
  `prepareAccount` без фото/персоны (§3.2).
- **dev B** — persona-часть фазы 2 = общий `applyPersonaToAccount` (`setupReplacementAccount`
  + инвайт), сессией агента (§6).
- **dev C** — общий `core/pool-accounts.ts`: `listPoolAccountsOldestFirst` + `claimPoolAccountTo`
  (§5).
- **dev D** — замена генерирует username из персоны (не из пула), общий с фазой 2 (§6.2).
- **dev F** — заготовка `account-defaults/`, `loadAccountDefaults`, вынос из персоны (§8).
- **dev G** — стейджинг `staging/emptyAccount<K>` → `workspace-emptyAccount<K>`, нумерация по
  сырым base-именам (§3.4/3.5).
- **M1 (dev A, §3.2) = фаза 2.** Фото профиля персоны накатывает только фаза 2
  (`setupReplacementAccount`); фаза 1 фото не ставит и не удаляет (инвариант обезличенного пула).
- **M4 (§4.3) = параллельные прогоны разрешены.** Номер N — атомарная аллокация на ФС (два
  rename на аккаунт: claim пула + claim номера с ENOTEMPTY-повтором), не in-memory счётчик.
  Согласовано с `claimPoolAccountTo` и с `banned-replacement` (номера не минтит).
- **M5 (dev E, §7) = E-b.** Отдельный строгий `loadPoolAccountConfig`; общий `loadAccountConfig`
  не ослабляется. Дублирование парсинга proxy/device принято координатором.
- **H (dev H, §12) = H-b.** Старое помечается `[DEPRECATED]`, код/регистрации живут до
  архивации change; удаление — при архивации.
- **R20 (§6.3) = вариант А.** Приватного канала на агента не создаётся — инвайт в общий канал
  воронки; правку R20 в requirements ведёт аналитик параллельно.

**Требуют выбора координатора (минорные, инженерные):**

- **M2 (dev C, §5.1)** — якорь возраста для «старейший первым»: `ctimeMs` каталога
  (рекомендую) vs. явный `createdAt` в конфиге пула.
- **M3 (dev C, §5.2)** — дом claim/quarantine: `core/pool-accounts.ts` (рекомендую) vs.
  оставить в `swap.ts` замены.

**Вопросы на подтверждение (не инженерные развилки):**

- **Q2 (§8)** — удаление apiId/apiHash/2fa из папок персон (`persona/*/default_agent_data.json`)
  после переноса в общую заготовку — необратимое изменение данных персоны, нужно явное
  подтверждение человека (agent-playbook «Обратимость»).

---

## 14. Открыто (сознательно не спроектировано здесь)

- Точные TS-сигнатуры новых функций (`prepareEmptyPoolAccount`, `applyPersonaToAccount`,
  `claimPoolAccountTo`, `loadAccountDefaults`, финализаторы стейджинга фаз) — при реализации.
- Формат итогового отчёта фазы 2 (строка «запрошено M, создано X; пул исчерпан / Y невалидны»,
  R25) — текст на реализации.
- Имена новых способностей/фич-каталогов (`tg-agent-pool-provision` /
  `tg-agent-persona-deploy`) — рабочие, финал за координатором при заведении change.
- Поведение `FLOOD_WAIT` при серии persona-вызовов фазы 2 на «отлежавшемся» пул-аккаунте и
  реальное срабатывание 24-часового лимита `resetAuthorizations` в фазе 1 — не измерялось,
  наследуется из открытых вопросов autoreg architecture §4 (спайк на реальных tdata).
- Оркестрация OpenSpec (explore/propose один change на фичу) — вне архитектуры, за координатором.

---

## 15. Источники

- [requirements-v1.md](requirements-v1.md) — R1..R30, US/AC.
- [tg-agent-autoregistration/architecture.md](../tg-agent-autoregistration/architecture.md) —
  монолит, bootstrap-контур, карта MTProto-вызовов, стейджинг/промоушен.
- [banned-account-replacement/architecture.md](../banned-account-replacement/architecture.md) —
  первый потребитель пула, claim/quarantine/swap, `setupReplacementAccount`, инвайт.
- [ADR 0008 — Detached-исполнение вне per-tool-call watchdog](../../decisions/0008-detached-execution-tool-watchdog.md)
  — контракт detached-job, отчёт в Saved Messages, обязательный внутренний таймаут (§9).
- `skills/tg-agent-autoregistration/SKILL.md` — образец скилла с detached-стартом через
  `systemd-run` (шаг 2); `deploy/systemd/tg-agent@.service` — образец committed-юнита
  (для периодических задач, не для фаз).
- Код (источник истины, ветка `refactoring-2`):
  `src/core/tdata/account-setup.ts` (`prepareAccount`/`setupReplacementAccount`/`createPersonaChannel`),
  `src/core/config.ts` (`loadAccountConfig`/`listPoolAccountIds`/`listAgentIds`),
  `src/core/telegram/service.ts` (`loadAccount`),
  `src/features/banned-account-replacement/{run.ts,swap.ts}` (`claimPoolAccount`/`buildIncoming`/`findValidPoolAccount`),
  `src/features/tg-agent-autoregistration/{run.ts,staging.ts,username.ts,persona-template.ts,id-range.ts}`,
  `src/features/tg-agent-channel-setup/run.ts`, `src/features/private-invite-links/run.ts`,
  `index.ts` (регистрация тулов).
