# tg-agent-autoregistration — архитектура

Design-doc (HOW). Источник требований (ЧТО) — [requirements-v1.md](requirements-v1.md).
Сценарий по шагам — [tg-agent-autoregistration-sequence.puml](tg-agent-autoregistration-sequence.puml).
Здесь фиксируются только решения, которые уже приняты; часть архитектуры (см. раздел
«Открыто») сознательно не детализирована — додумывать её сейчас означало бы выдавать
предположение за решение.

Статус: architecture-level решения приняты в explore-режиме, до кода. Спайк на реальных
данных (раздел 2.1) ещё не проводился.

---

## 1. Резюме решения

`Main` (сценарий) реализуется как **один** OpenClaw-тул в корневом `index.ts`,
делегирующий прямым вызовом функции (не подпроцессом, не LLM-циклом) в новый модуль
`src/features/tg-agent-autoregistration/run.ts` — по образцу `dispatcher.ts`/
`provision-mobile-proxy.ts`/`import-agent-pool.ts` (детерминированные one-shot скрипты),
а не по образцу `tg-agent-create*` (гранулярные тулы, которые LLM-агент ведёт пошагово
по `SKILL.md`). Причина: весь процесс (R-1…R-12 требований) детерминирован, ни на одном
шаге не нужно суждение оператора внутри цикла — LLM-цикл здесь был бы тем самым
антипаттерном, ради ухода от которого [0001-scripts-over-openclaw-agent.md](../../decisions/0001-scripts-over-openclaw-agent.md)
увёл фоновые скиллы в код.

Роль `TData` (расшифровка tdata-сессии → рабочая MTProto-сессия) реализуется тоже
**in-process TS-модулем**, без отдельного рантайма — на основе npm-пакета
`@mtcute/convert` (раздел 2.1). Отдельный подпроцесс/рантайм (вариант с Python/
`opentele`) рассматривался и отклонён — раздел 2.1.

`provision-proxy-for-new-agent.ts` переиспользуется **без изменений**, вызывается как
подпроцесс (режимы `--create-candidate`/`--delete-candidate`, уже существующие) —
явное решение координатора не трогать существующий продакшн-скрипт ради этой фичи.

---

## 2. Ключевые технические решения

### 2.1 Расшифровка tdata → рабочая MTProto-сессия: выбран `@mtcute/convert`

Сама «сессия» в MTProto — пара `{dcId, authKey}`. tdata — зашифрованное на диске
хранилище этой пары; формат официально не документирован ни Telegram, ни TDesktop,
известен только по реверс-инжинирингу сообщества (несколько независимых реализаций:
gist автора GramJS, `opentele`, `tdata-rs`, `mtcute`/`tdesktop-session`).

Рассмотрены три варианта:

| | **A1** — портировать gist | **A2 (выбран)** — `@mtcute/convert` | **C** — Python/`opentele` subprocess |
|---|---|---|---|
| Источник расшифровки | Личный TS-gist [painor](https://gist.github.com/painor/7ef6c68a1d5bdea01a2f58b1de147104) (автора GramJS), копируется в репозиторий как свой код | npm-пакет `@mtcute/convert` (часть проекта [mtcute](https://github.com/mtcute/mtcute)), обычная зависимость | Python-библиотека [`opentele`](https://github.com/thedemons/opentele), вызывается через `spawn`+JSON-протокол |
| Сборка итоговой GramJS-сессии | Писать самим (в несколько строк, но наш код) | **Уже есть в пакете** — `convertToGramjsSession()`, сверено побайтово с `node_modules/telegram/sessions/StringSession.js` этого проекта | Нужно — MTProto-логика (2FA/сессии/профиль/канал) в любом случае пишется на TS, Python отвечает только за конвертацию сессии |
| Новый рантайм на VPS | Нет | Нет | Да — venv/pip, первый Python-компонент в безнадзорном (не интерактивном) скрипте проекта |
| Сопровождение | Только мы, после портирования | Апстрим (`@mtcute/convert@0.31.0`, MIT, обновляется) | Апстрим объявлен неподдерживаемым |
| Версионный риск | Привязан к версии TDesktop, которой создан tdata; неизвестна заранее | Тот же риск — подтверждён самим мейнтейнером в исходниках: `ignoreVersion` JSDoc — «вероятность ошибок выше»; официальный пример — `// note: this might break»; комментарий в парсере — «nightmare to maintain» | Тот же риск, но инструмент признан индустрией самым обкатанным на реальных данных |

**Решение: A2.** При одинаковом версионном риске (он неустраним ни одним из вариантов —
это свойство формата, а не библиотеки) A2 не требует владеть портированным кодом
расшифровки самим (в отличие от A1) и не добавляет второй управляемый рантайм на VPS
(в отличие от C, где список новых операционных обязанностей — второй мониторинг,
восстановление венва, отсутствие journald-видимости, осиротевшие процессы при
`gateway restart`, второй каталог ошибок Telegram — существенно тяжелее выигрыша в
сегодняшней надёжности).

Подтверждённый прямым чтением исходников путь:

```typescript
import { convertFromTdata, convertToGramjsSession } from '@mtcute/convert'

const data = await convertFromTdata({ path: tdataPath })  // passcode не нужен — подтверждено (нет TDesktop passcode на закупленных аккаунтах)
const stringSession = convertToGramjsSession(data)        // готово для new StringSession(...)
```

Скрытая зависимость: `@mtcute/node` формально помечен `optional` в
`peerDependenciesMeta`, но по факту требуется в рантайме — дефолтный крипто-провайдер
динамически импортирует его, если свой не передать. Ставится вместе с
`@mtcute/convert`.

**Спайк подтверждён — не на локальном образце, а прямым прогоном в проде.**
Отдельный спайк-скрипт не понадобился: код (`connectBootstrap`) сразу запускался
на реальных закупленных tdata-архивах через `tg_agent_autoregistration_run`/
`tg_agent_autoregistration_retry_code`. Несколько прогонов подряд подтвердили:
`@mtcute/convert` корректно расшифровывает реальные tdata (проверено на
нескольких разных аккаунтах), собранная GramJS-сессия успешно проходит
`getMe()`, ESM/CJS-совместимость с `tsx`/`tsconfig.json` проекта — рабочая (ни
одной ошибки импорта за все прогоны). Минимум один аккаунт (`agent220`) прошёл
весь пайплайн до `done` целиком: расшифровка → 2FA/очистка/профиль/канал →
вторая сессия → перенос в `workspace-agent<N>`.

### 2.2 Две MTProto-сессии на аккаунт — обе остаются активными

Процесс регистрации создаёт две разные сессии, и обе доживают до конца прогона:

1. **Bootstrap-сессия** — собирается из `{dcId, authKey}`, полученных через
   `@mtcute/convert` (раздел 2.1). Ею выполняются `updateTwoFaSettings`,
   `resetAuthorizations`, `updateProfile`/`uploadProfilePhoto`, `createChannel`+
   `sendMessage`, и ею же принимается входящий код авторизации на шаге
   `readIncomingCode` (код приходит на уже залогиненное соединение, отдельного
   клиента для его приёма нет). В `tg-account.json` не попадает.
2. **Агентская сессия** — регистрируется отдельно, `authSendCode`(apiId/apiHash из
   `default_agent_data.json` персоны, R-D1) → `authSignIn` → `agentSessionString`.
   Это то, что пишется в `tg-account.json` (R-D4) и чем платформа пользуется дальше.

`resetAuthorizations()` вызывается **до** появления агентской сессии — чистит только
чужие/старые сессии на bootstrap-аккаунте, саму бутстрап-сессию и будущую агентскую не
затрагивает.

**Явное решение координатора: bootstrap-сессию после получения агентской не
разлогинивать.** На аккаунте намеренно остаются два активных устройства — это ближе к
поведению обычного пользователя (десктоп + телефон), чем аккаунт с единственной
сессией, появившейся из ниоткуда. Диаграмма/требования менять не нужно — они уже не
предполагают шага logout.

### 2.3 Методы аккаунта — точная карта GramJS/MTProto

Этой логики нет нигде в `src/core/telegram/service.ts` — пишется с нуля. Подтверждено
чтением `node_modules/telegram/tl/api.d.ts` и core.telegram.org/method/*, не по памяти:

| Шаг | Вызов | Источник/примечание |
|---|---|---|
| Смена 2FA | `client.updateTwoFaSettings({currentPassword, newPassword, hint})` | `client/2fa.d.ts` — готовый клиентский метод, SRP (`computeCheck`/`computeDigest`) уже внутри пакета |
| Сброс сессий | `Api.auth.ResetAuthorizations()` | **Не работает первые 24 часа после логина текущей сессии** — ошибка 406, реальное ограничение API, не миф. `auth.dropTempAuthKeys` — другой метод (PFS-ключи, не сессии устройств), не альтернатива |
| Профиль (имя/био) | `Api.account.UpdateProfile({firstName?, lastName?, about?})` | отдельный вызов от username |
| Username аккаунта | `Api.account.UpdateUsername({username})` | `tl/api.d.ts:21614` |
| Дата рождения | `Api.account.UpdateBirthday({birthday: new Api.Birthday({day, month, year?})})` | core.telegram.org/method/account.updateBirthday (Layer 223) — реальная, недавняя фича, не выдумка |
| Фото профиля (R-5, все `photo_profile_N`) | `client.uploadFile(...)` → `Api.photos.UploadProfilePhoto({file})`, в цикле по одному на файл | `client/TelegramClient.d.ts:825` |
| Канал | `Api.channels.CreateChannel({broadcast: true, title, about})` → `Api.channels.UpdateUsername({channel, username})` (паблик-юзернейм не параметр создания) | `tl/api.d.ts:27118/27198` |
| Пост | `Api.messages.SendMessage({peer: channel, message})` | `tl/api.d.ts:23319` |
| Закреп канала в профиле (R-6) | `Api.account.UpdatePersonalChannel({channel})` | core.telegram.org/method/account.updatePersonalChannel — требует уже существующий broadcast-канал с username (`PUBLIC_BROADCAST_EXPECTED` иначе), поэтому вызывается **после** создания канала+username |

**Не задокументировано Telegram** (не выдумывать числа): порог `ALBUM_PHOTOS_TOO_MANY`
(лимит фото профиля), поведение `FLOOD_WAIT` при 6+ вызовах подряд на свежем аккаунте.

### 2.4 Очистка предыдущего состояния аккаунта — безусловная, необратимая

Купленный tdata-аккаунт может нести фото/публичные каналы от прежнего использования.
**Явное решение координатора: удалять оба вида безусловно**, на каждом аккаунте,
независимо от того, упирается ли аккаунт в лимит публичных каналов — не только когда
это технически необходимо (R-13).

Уточнение причины, ради которой это нужно: `account.updatePersonalChannel`
документирует единственную ошибку — `PUBLIC_BROADCAST_EXPECTED`, конфликта с наличием
других публичных каналов у неё нет. Реальный конфликт — на шаге **создания нового**
канала персоны: `channels.updateUsername` может упасть с `CHANNELS_ADMIN_PUBLIC_TOO_MUCH`
(«вы админ слишком многих публичных каналов»), если унаследованные каналы уже заняли
недокументированный лимit. Безусловная очистка (решение координатора) снимает этот
риск заранее, не полагаясь на проверку лимита по месту.

| Шаг | Вызов | Источник/примечание |
|---|---|---|
| Найти фото | `Api.photos.GetUserPhotos({userId, offset, maxId, limit})` | → `photos.TypePhotos` |
| Удалить фото | `Api.photos.DeletePhotos({id: [...]})` | принимает `InputPhoto`, не тот же тип, что элемент ответа `GetUserPhotos` — нужна конвертация (`Utils.getInputPhoto()` в GramJS) |
| Найти публичные каналы аккаунта | `Api.channels.GetAdminedPublicChannels({forPersonal?, checkLimit?})` | официально документирован как «список каналов для `account.updatePersonalChannel`»; НЕ используем `checkLimit` (решение — очистка безусловная, не по факту лимита) |
| Удалить канал | `Api.channels.DeleteChannel({channel})` | **необратимо** — отступление от `docs/agent-playbook.md` («Обратимость»), сознательно принятое координатором для этого процесса. Ограничение: `CHANNEL_TOO_LARGE` — нельзя удалить канал > 1000 участников; такой отказ — обычная ошибка подготовки (`setup_failed`, R-1) |

Порядок в диаграмме: очистка — часть общего шага «подготовить аккаунт» (TData), после
`resetAuthorizations`, до применения нового профиля/фото/канала персоны.

---

## 3. Компоненты

| Компонент | Расположение | Роль |
|---|---|---|
| `Main` | `src/features/tg-agent-autoregistration/run.ts` (новый) | вся логика: R-8/R-10/R-11 на старте, цикл по аккаунтам, стейджинг, обе сессии, итоговый отчёт |
| CLI-двойник | `src/scripts/ops/tg-agent-autoregistration.ts` (новый) | тонкая обёртка над `run.ts`, по паттерну `core/+scripts/` остального репозитория |
| OpenClaw-тул | `index.ts` (корень, +1 регистрация) | `execute()` делегирует в `run.ts` напрямую, без LLM-цикла |
| `TData` | `src/core/tdata/` (новый) | `@mtcute/convert` (раздел 2.1) + методы аккаунта (раздел 2.3) + очистка предыдущего состояния (раздел 2.4) — этой логики сейчас нет нигде в `src/core/telegram/service.ts`, пишется с нуля |
| Подбор прокси | `src/scripts/ops/provision-proxy-for-new-agent.ts` (существующий, без изменений) | вызывается подпроцессом на каждую попытку (R-12) |
| Стейджинг | `~/.openclaw/tg-agent-autoregistration/staging/agent<N>/` (R-7/R-D3) | `status.json` пишется через tmp-файл+`renameSync` (атомарно); на `done` — сначала полностью собирается (`tdata/`+`tg-account.json`+`SOUL.md`), затем один `renameSync(staging, workspace)` — атомарен на уровне ОС в пределах одной ФС |
| Шаблоны персоны | `~/.openclaw/tg-agent-autoregistration/templates/<personName>/` (R-D1) | без изменений относительно требований |

Деплой не меняется — `scp`+`chown`+`openclaw gateway restart`, как для остального
Node/TS-кода. Единственная новая запись в `package.json` — `@mtcute/convert`
(+ неявно `@mtcute/node`).

---

## 4. Открыто (сознательно не спроектировано здесь)

- Точные TS-интерфейсы/сигнатуры функций `features/tg-agent-autoregistration/run.ts` и
  `core/tdata/` — не фиксировались в разговоре, будут определены при реализации.
- Каталог доменных ошибок `@mtcute/convert` (бросает ли `convertFromTdata` различимые
  исключения, которые ложатся на статусы R-1/R-9, или их нужно классифицировать
  вручную) — не проверялось.
- Численные пороги `ALBUM_PHOTOS_TOO_MANY`/лимит публичных каналов на аккаунт — не
  публикуются Telegram (раздел 2.3).
- Сработает ли 24-часовое ограничение `auth.resetAuthorizations` на конкретных
  закупленных tdata-аккаунтах — зависит от их реального возраста логина, неизвестного
  заранее (раздел 2.3).
- Остаточный риск падения процесса между «стейджинг собран» и `renameSync` (раздел 3) —
  координатор явно решил не заводить под это отдельный статус (см. requirements-v1.md,
  вопрос снят).
- Таймбокс на спайк варианта A2 (раздел 2.1) — управленческое решение.

---

## 5. Источники

- [Convert TDesktop tdata folders to GramJS sessions (painor)](https://gist.github.com/painor/7ef6c68a1d5bdea01a2f58b1de147104)
- [mtcute/mtcute — packages/convert](https://github.com/mtcute/mtcute/tree/master/packages/convert)
- [@mtcute/convert — npm](https://www.npmjs.com/package/@mtcute/convert)
- [mtcute — Converting sessions](https://mtcute.dev/guide/advanced/session-convert)
- [thedemons/opentele](https://github.com/thedemons/opentele)
- core.telegram.org/method/{auth.resetAuthorizations, auth.dropTempAuthKeys,
  account.updateBirthday, account.updatePersonalChannel} — Layer 223
- `node_modules/telegram/{client/2fa.d.ts, Password.d.ts, tl/api.d.ts,
  client/TelegramClient.d.ts}` — установленная в проекте версия GramJS
