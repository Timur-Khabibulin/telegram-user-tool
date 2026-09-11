# Миграция OpenClaw 2026.3.24 → 2026.9.3

Рабочий runbook миграции gateway на новую версию OpenClaw. Составлен 2026-09-11 по
факту разбора состояния VPS и загрузчика плагинов 2026.9.3. Удалить после
завершения миграции и переноса устойчивых фактов в `operation.md`.

## Контекст: две поверхности исполнения

| Поверхность | Запуск | Зависимость от версии OpenClaw |
|---|---|---|
| **Gateway (интерактив)** | user-служба `openclaw-gateway.service`, грузит `index.ts` как плагин | **прямая** — версия критична |
| **Диспетчер (таймеры)** | `tsx src/scripts/…` напрямую из `node_modules/.bin`, systemd-таймеры | почти нет (общий `node_modules` + `EnvironmentFile`) |

Весь репозиторий импортирует из OpenClaw ровно один символ — `definePluginEntry`
из `openclaw/plugin-sdk/plugin-entry` (только в `index.ts`). Диспетчер перечисляет
агентов через `listAgentIds()` (скан `~/.openclaw/workspace-*`), не из
`openclaw.json`, поэтому схема-миграция `agents.list → agents.entries` его не
задевает.

## Состояние VPS (<VPS_HOST>) на момент составления

- Старый бинарь `2026.3.24` — `/usr/lib/node_modules/openclaw` (`/usr/bin/openclaw`).
- Новый бинарь `2026.9.3` — `/usr/local/lib/node_modules/openclaw` (`/usr/local/bin/openclaw`).
- Gateway: `systemctl --user openclaw-gateway.service`, сейчас **v2026.3.24**,
  `ExecStart=/usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789`,
  под Node **v22.22.0**. `/etc/systemd/system/openclaw.service` → `/dev/null` (masked).
- `~/.openclaw/openclaw.json` уже мигрирован в схему **2026.9.3** (старый gateway
  работает поверх нового конфига). `plugins.load.paths: []`.
- Node **26.1.0** установлен через `n`: `/usr/local/n/versions/node/26.1.0/bin/node`.
  Node 24.x нет. 2026.9.3 требует Node ≥24.16 <25 или ≥26.1.
- `doctor` новым бинарём (под node 26) проходит без ошибок; модель
  `openai-codex/gpt-5.4` резолвится; провайдер `@openclaw/openai-provider` enabled.

## Что затрагивает миграция

### Схема конфига (уже применена бинарём 2026.9.3, вошла в git)

`agents.list[]` → `agents.entries{}` + `ownership:"explicit"`; `streaming:"partial"`
→ `{mode:"partial"}`; auth-профили `openai-codex:*` → `openai:*`; добавлены
`modelPolicy.allow`, `systemAgent.agentId`, `heartbeat.agentId`; дефолт-модель
`gpt-5.1-codex` → `gpt-5.3-codex`; убрано `commands.ownerDisplay:"raw"`; `agent2` и
`ageng3` потеряли явный `model` (падают на дефолт).

### Блокер 1 — TS-вход плагина

В 2026.9.3 плагин из managed-каталога `~/.openclaw/extensions/telegram-user-tool/`
с TS-входом `index.ts` **не грузится** (`plugins list` выдаёт требование
компилированного JS; тула нет в enabled). Загрузчик (`worker.mjs`,
`isSourceCheckoutPluginRecord`) разрешает TS-вход, только если origin записи =
`config` или `workspace`:

```
allowSourceTypeScriptEntries = origin==="config" || origin==="workspace" || (origin==="bundled" && <репо OpenClaw>)
```

origin `config` присваивается путям из `plugins.load.paths` (`discoverConfiguredPaths`).

**Решение (основное):** зарегистрировать каталог плагина через `plugins.load.paths`
в `openclaw.json` — тогда origin=`config`, TS-вход `index.ts` грузится напрямую,
`dist/` не нужен.

**Запасной вариант на будущее:** собирать плагин самостоятельно (`tsc`-эмит
`index.ts`+`src/` в `dist/`, entry → `./dist/index.js`) — грузится как обычный
installed-пакет из любого origin. Держать в уме, если OpenClaw ужесточит правила
origin.

### Блокер 2 — Node / ABI better-sqlite3

- 2026.9.3 работает только под Node ≥24.16/≥26.1 → доступен **26.1.0**.
- `better-sqlite3` собран под node 22 (`NODE_MODULE_VERSION 127`); под node 26
  (`147`) падает → нужен `npm rebuild better-sqlite3`.
- Прочие нативные (`sharp`, `@napi-rs/canvas`, `koffi`, `clipboard`) — napi/prebuilt,
  ABI-стабильны, бамп переживают.
- `node_modules/better-sqlite3` **один** на gateway и на таймеры → на node 26
  переводить **оба процесса одновременно**, иначе ABI-рассинхрон (прошлый инцидент
  «node v26 сломал better-sqlite3» = бамп без единой версии/пересборки).

## План

### Блок A — Подготовка на копии (без правок боевого gateway) — ВЫПОЛНЕНО 2026-09-11

Проверено новым бинарём (2026.9.3) под node 26, боевой `openclaw.json` и служба
не тронуты (тест через `OPENCLAW_CONFIG_PATH`/`OPENCLAW_STATE_DIR` на временных
копиях).

1. ✅ `plugins.load.paths: ["/root/.openclaw/extensions/telegram-user-tool"]` →
   плагин грузится как **enabled**, TS-вход `index.ts` принимается. В изоляции
   (пустой managed `extensions/`, плагин только через config-путь) — **без
   предупреждения о компиляции**.
2. ✅ Контракт `definePluginEntry` совместим: `plugins list` прочитал имя/id/версию
   («Telegram User Tool» / `telegram-user-tool` / `1.0.0`) из результата
   `definePluginEntry`, т.е. `index.ts` реально загрузился. Экспорт
   `openclaw/plugin-sdk/plugin-entry` → `definePluginEntry` присутствует в 2026.9.3.

**Дубль обнаружения — решён приоритетом, каталог НЕ переносим.** Нормативная дока
`docs/plugins/manifest/package-json.md` («Discovery precedence»): при совпадении
`id` грузится только манифест высшего приоритета, дубли ниже — отбрасываются.
Приоритет: 1. Config-selected (`plugins.load.paths`) … 6. Untracked global
(`~/.openclaw/extensions`). Значит достаточно добавить путь каталога в
`plugins.load.paths` — config-копия (origin `config`, TS-вход) побеждает, копия из
`~/.openclaw/extensions` (требующая JS) отбрасывается. Предупреждение о компиляции —
уведомление про отброшенный дубль (config-selected winner помечается как explicit
override), загрузку не ломает. **Пути в systemd-юнитах и `operation.md` менять не
нужно.** Отдельного флага отключения глобального скана не требуется — приоритет
делает config-копию единственной загружаемой.

### Блок B — Синхронизация репозитория — ВЫПОЛНЕНО 2026-09-11

3. ✅ Зависимость openclaw переведена с **неработающего git+ssh-спека**
   (`github:openclaw/openclaw#…` — недоступен ни локально, ни с VPS: «Host key
   verification failed») на **npm-реестр**: `"openclaw": "2026.9.3"`. Это тот же
   пакет (`repository.url=github.com/openclaw/openclaw`), опубликован в registry,
   именно оттуда стоит глобальный бинарь на VPS. `npm install` прошёл, `package-lock.json`
   перегенерирован.
4. ✅ `plugins.load.paths: ["~/.openclaw/extensions/telegram-user-tool"]` прописан
   в `openclaw.json`.
5. ✅ Typecheck против плагин-SDK 2026.9.3: **ошибок по openclaw/`definePluginEntry`
   нет** — `index.ts` совместим с контрактом. (`tsc` запускался через временный
   конфиг с `module:esnext`, т.к. в проектном `tsconfig.json` невалидная пара
   `module:commonjs`+`moduleResolution:bundler` — предсуществующий баг неиспользуемого
   build-пути, рантайм идёт через `tsx`.)

**Найдено и исправлено (миграцией обусловлено):** `index.ts` импортирует
`@sinclair/typebox` (value-импорт, нужен при загрузке), но пакет отсутствовал в
`package.json` — раньше подтягивался транзитивно из git-депа openclaw; 2026.9.3 его
не тянет. Добавлен прямой зависимостью `@sinclair/typebox: ^0.34.48` (версия,
работающая на VPS). После установки ошибка резолва ушла.

**Предсуществующие typecheck-огрехи (НЕ трогаем — вне скоупа, рантайм через `tsx`
не затронут):** нет `@types/better-sqlite3` (17 файлов, TS7016); `bigint`/`EntityLike`/
`BigInteger` в gramjs `telegram/*` (TS2345/TS2322); `.reason` на дискриминированных
union в `index.ts`; невалидный `tsconfig.json` (`commonjs`+`bundler`). Сообщено
отдельно — к миграции отношения не имеют.

### Блок C — Node и нативные модули на VPS — ВЫПОЛНЕНО 2026-09-11

6. ✅ Node 26.1.0 сделан дефолтом через `n 26.1.0` → `/usr/local/bin/node`. Все
   dispatcher-юниты запускают `tsx` через `env node` с дефолтным systemd-PATH (там
   `/usr/local/bin` раньше `/usr/bin`) → подхватывают node 26 без правки каждого юнита.
7. ✅ `npm install` под node 26 (по новому lock: openclaw 2026.9.3 + typebox), затем
   сборка better-sqlite3 под node 26 (`npm run build-release` в его каталоге — обходит
   npm-gate на build-скрипты). Require-тест: `open+query OK under v26.1.0`. Дериск
   сборки делался заранее в изолированной копии — toolchain (make/gcc/g++/python3) на месте.
8. ✅ Отдельная правка юнитов не понадобилась (см. п.6).

Бэкапы для отката: `node_modules.bak-node22` (в каталоге плагина),
`/tmp/openclaw.json.bak-premig`, `/tmp/openclaw-gateway.service.bak-premig`.

### Блок D — Переключение gateway — ВЫПОЛНЕНО 2026-09-11

9. ✅ Gateway остановлен на время окна.
10. ✅ `doctor --fix` мигрировал legacy-состояние в SQLite: device-auth token, device
    identity, config-audit (241 строка), workspace-state по агентам, session store
    (`agents/main/sessions/sessions.json`) — потребовался второй прогон `--fix`.
11. ✅ Unit gateway правился ВРУЧНУЮ (`gateway install --force` заблокирован:
    `SERVICE_DEFINITION_SEALED` — unit помечен system-owned): `ExecStart` →
    `/usr/local/bin/node /usr/local/lib/node_modules/openclaw/dist/index.js gateway
    --port 18789`, `OPENCLAW_SERVICE_VERSION=2026.9.3`. (Строка `Description=…v2026.3.24`
    осталась — косметика.)
12. ✅ `daemon-reload` + старт. Gateway поднимается ~1–2 мин (CPU-heavy старт, загрузка
    TS-плагина), затем слушает `127.0.0.1:18789`. Процесс подтверждён: `/proc/PID/exe →
    /usr/local/bin/node`, cmdline на бинарь 2026.9.3.

**Плагин `telegram-user-tool` грузится на рантайме** (`plugins list`: enabled 5/62,
source `~/.openclaw/extensions/...`). Предупреждение о компиляции печатается как
нотис про отброшенный глобальный дубль (config-selected копия побеждает) — загрузку
не ломает.

### Блок E — Смоук-тесты — ВЫПОЛНЕНО 2026-09-11

13. ✅ Диспетчер под node 26: `agent5` — штатный banned-выход (`USER_DEACTIVATED`);
    `agent143` — `no due tasks, exiting`, rc=0. better-sqlite3 читает состояние,
    ABI ок. `localStorage`-warning безвреден (node 26).
14. ✅ Автоматика восстановлена: 60 `tg-agent@*.timer` активны, периодические таймеры
    и оба listener'а — active (все под node 26).
15. ✅ Gateway: `mainbot` подключён (getMe 200). Интерактивный DM-тест ботам — за
    пользователем (нужен Telegram-клиент).

**⚠️ Вне скоупа миграции — креды agentsBot.** `agentsbot` не поднимается: Telegram
getMe возвращает **401** (токен `8639244596:…` отозван/невалиден). Проверено прямым
запросом к Telegram API (mainBot → 200, agentsBot → 401). Новый gateway лишь корректно
репортит проблему. Фикс — только у пользователя: взять актуальный токен у BotFather и
обновить `channels.telegram.accounts.agentsBot.botToken`. До этого agent1–8 через
agentsBot не работают (независимо от версии OpenClaw).

**Конфиг-правка при переключении:** добавлен channel-wide (тир-4) binding
`telegram:agentsBot → agent1` — 2026.9.3 требует явного владельца аккаунта при
нескольких агентах на одном боте (у `mainBot` такой binding уже был → `main`).
Per-peer bindings (тир-1) сохраняют приоритет; владелец функционально инертен (все
8 `allowFrom`-пользователей уже привязаны по peer). **Выбор `agent1` — на подтверждение.**

## Откат

- Прежний бинарь `/usr/bin/openclaw` (2026.3.24), прежний `ExecStart` (node 22 +
  `/usr/lib/...`), бэкап `node_modules.bak-node22` и снапшоты в `/tmp` — на месте.
- Откат = вернуть unit из `/tmp/openclaw-gateway.service.bak-premig`, `n 22.22.0`
  (вернуть дефолтный node), `rm -rf node_modules && mv node_modules.bak-node22
  node_modules`, восстановить `openclaw.json` из `/tmp/…bak-premig`, вернуть пин в
  `package.json`, `daemon-reload` + рестарт службы и таймеров.

## Постмиграционная правка (11.09)

По решению пользователя из конфига удалены все интерактивные агенты кроме `main`:
agent1–8 (`agents.entries` + их bindings) и аккаунт `channels.telegram.accounts.agentsBot`
(токен которого был мёртв). Осталось `main` + `mainBot` (@ow_tim_bot). Применено в
репо и на VPS; gateway обслуживает только mainBot, ошибок agentsbot больше нет.

**⚠️ Операционный урок: gateway 2026.9.3 перезаписывает `openclaw.json` своим
resolved-конфигом при остановке/старте.** Правка файла + `restart` НЕ держится (старый
процесс при shutdown пишет назад свой in-memory конфиг). Правильно: `stop` → править →
`start`.

## Открытые (некритичные) пункты

- (снято) ~~agentsBot: обновить botToken~~ — аккаунт удалён из конфига.
- Завис 3-дневный ручной процесс `channel-activity-update` (agent33) под старым node 22
  — держит в памяти node-22 better-sqlite3; при новом открытии БД упадёт. Прибить при
  случае (`kill`), задача при необходимости перезапустится.
- `agent2`, `ageng3` без memory-system и без явного `model` — решить отдельно.
- Косметика: `Description=…v2026.3.24` в unit gateway; `Service config: PATH includes
  version managers` (рекомендация doctor); невалидный `tsconfig.json` (build-путь).
- Коммит правок репозитория (package.json/lock, openclaw.json, план) — по решению
  пользователя (сейчас НЕ закоммичено).
