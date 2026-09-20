# План: загрузка плагина telegram-user-tool из TS-исходников (source-checkout) в OpenClaw 2026.9.3

> Статус: **ВЫПОЛНЕНО 2026-09-13**. План собран в explore-режиме, затем реализован.
>
> Итог: плагин грузится из TS-исходников (`~/openclaw-plugins/telegram-user-tool`),
> origin=config, 51 тул, 0 диагностик; диспетчер/юниты работают с нового пути.
>
> **Два блокера всплыли уже при выполнении (не были в исходном анализе):**
> 1. `openclaw plugins uninstall` требует ВАЛИДНЫЙ конфиг — после `mv` каталога
>    `load.paths` указывал на исчезнувший путь → CLI отказывался. Фикс: сначала
>    `jq` поправить `load.paths` на новый путь (config valid), потом CLI.
> 2. **2026.9.3 требует манифест `contracts.tools`** со списком ВСЕХ тулов, иначе
>    `ERROR: plugin must declare contracts.tools before registering agent tools`
>    (по одной на тул). Добавлен блок `contracts.tools` (51 имя) в `openclaw.plugin.json`.
> 3. **Capability consent**: после linked-install нужен `openclaw plugins enable
>    telegram-user-tool --accept-capabilities`, иначе diagnostics-warning и тулы не
>    активны. `install -l ... --force --accept-capabilities` тоже требует флаг.
>
> Фактически выполненная последовательность: stop gateway+таймеры → `mv` каталог наружу
> → `jq` load.paths=новый путь (валидность) → `plugins install -l <новый> --force
> --accept-capabilities` → `plugins enable --accept-capabilities` → добавить
> `contracts.tools` в манифест → обновить 8 юнитов + shell-скрипт → daemon-reload →
> start gateway → поднять 64 таймера поимённо (glob для start не работает) →
> проверки (inspect: 51 тул/0 диаг; тик диспетчера; grep=0) → синхронизация репо
> (манифест с contracts, deploy/systemd, скиллы, доки, openclaw.json).
> Цель: gateway грузит плагин из `index.ts` (без сборки `dist/`), systemd-юниты и
> диспетчер работают, код можно править прямо на сервере без компиляции.

## Проблема

После миграции на OpenClaw 2026.9.3 плагин `telegram-user-tool` **не загружается** —
gateway пишет:

```
[plugins] installed plugin package requires compiled runtime output for TypeScript
entry index.ts: expected ./dist/index.js, ... TypeScript source fallback is only
supported for source checkouts and local development paths.
(plugin=telegram-user-tool, source=/root/.openclaw/extensions/telegram-user-tool)
```

Тул `tg_agent_autoregistration_run` (и все прочие тулы плагина) недоступны в боте.
Диспетчер (tsx-таймеры) при этом работает — он грузит `src/` напрямую, минуя
загрузчик плагинов OpenClaw.

## Корневая причина (многофакторная, подтверждена кодом и state)

Загрузчик 2026.9.3 требует компилированный JS, **только когда `origin === "global"`**:

```js
// node_modules/openclaw/dist/package-entry-resolution-*.mjs:266
function shouldRequireBuiltRuntimeEntry(origin) { return origin === "global"; }
// :357 — при requireBuiltRuntimeEntry && TS-вход → reject "installed plugin package"
```

При `origin === "config"` (путь выбран через `plugins.load.paths`) TS-вход
разрешён (доходит до загрузки исходника). Плагин же резолвится как `global` из-за
**связки трёх факторов**:

1. **Persisted install-record** в `/root/.openclaw/state/openclaw.sqlite`
   (`plugins.installedIndex.installRecords."telegram-user-tool"`):
   `source:"path"`, `installPath:"/root/.openclaw/extensions/telegram-user-tool"`,
   создан 2026-03-26. В discovery (`dist/discovery-*.mjs:1304-1314`) install-records
   разворачиваются с `origin:"global"` и `requireBuiltRuntimeEntry`.
2. **Физическое расположение** в `~/.openclaw/extensions/` (global-root). Скан
   global-каталога (`:1315`) классифицирует всё там как `origin:"global"`
   (пропуская только dirs из install-records: `skipRootDirKeys`).
3. **Нет `dist/index.js`** — плагин собран под запуск из TS-исходников
   (`package.json main:"dist/index.js"`, но `dist/` никогда не собирался; манифест
   `openclaw.plugin.json` → `extensions:["./index.ts"]`).

`load.paths` в одиночку не перебивает install-record — проверено эмпирически:
замена тильды на абсолютный путь в `load.paths` НЕ помогла (ошибка та же).

Важно: «прогоны» скилла ранее (скачивание tdata, setup_failed) делались моделью
**вручную через Bash**, а не тулом плагина — плагин не грузился всё это время.

## Что НЕ затрагивается переносом (проверено)

- **Все данные** идут от `os.homedir()/.openclaw/workspace-<agentId>/` (`src/core/config.ts`):
  БД (`tg-channels.db`, `tg-replies.db`, `funnel.db`, `discovery.db`, …), `tdata`,
  `personas`, стейджинг автарегистрации (`~/.openclaw/tg-agent-autoregistration/`).
  Ничего из этого не лежит в каталоге плагина.
- `logs/`, `imports/`, scratch-`.ts`, `.git`, `.idea`, `.rsync-exclude` лежат внутри
  каталога плагина и переедут вместе с ним; кодом в `src/` они не адресуются.

## Полная инвентаризация ссылок на путь `~/.openclaw/extensions/telegram-user-tool`

### Рантайм-критичное (сломается без правки)
- `openclaw.json` (VPS + репо) — `plugins.load.paths`.
- **State OpenClaw** `/root/.openclaw/state/openclaw.sqlite` — install-record
  (снять через `openclaw plugins uninstall --keep-files`, не редактировать БД руками).
- Live systemd-юниты `/etc/systemd/system/` — **8 шт**: `tg-agent@.service`,
  `tg-channel-activity-update.service`, `tg-channel-activity-update-manual@.service`,
  `tg-channel-rotation.service`, `tg-daily-summary.service`, `tg-funnel-tracker.service`,
  `tg-review-listener.service`, `tg-distribution-listener.service`
  (per-agent `.timer` путь НЕ содержат — только шаблон `@.service`).
- `src/scripts/ops/channel-activity-update-manual.sh:25` — хардкод `cd <путь>`
  (код, деплоится, зовётся юнитом).

### Репо — источник истины (иначе редеплой вернёт старый путь)
- `deploy/systemd/*.service` — **8 копий** юнитов.
- `.claude/skills/vps/SKILL.md` (стр. 11, 51, 52) — маппинг деплоя.
- `skills/tg-agent-create/SKILL.md` (64, 102), `skills/tg-agent-create-v2/SKILL.md`
  (63, 90) — `cd <путь> && tsx …`.
- `.claude/skills/channel-metrics`, `.claude/skills/import-agent-pool`,
  `.claude/skills/mobile-proxy-provision` — тоже `cd <путь>`.

### Доки (обновить актуальные; историю не трогать)
- Обновить: `docs/operation.md`, `docs/architecture-diagrams.md`,
  `docs/design/team-deploy/team-deploy-v1.md`,
  `docs/design/universal-script-control/architecture.md`,
  `docs/openclaw-migration-2026.9.3.md`.
- Оставить как историю: `docs/decisions/0007-*`, `openspec/changes/archive/*`.

### Не путь (правки не требуют)
- `[telegram-user-tool]` — лог-теги в коде; `id:"telegram-user-tool"` — id плагина;
  `plugins.entries.telegram-user-tool.config` — ключ конфига;
  `.claude/settings.local.json` — локальные Windows-пути dev-машины (не VPS).

## Документированный способ (docs OpenClaw, НЕ ручной хак)

Источник: `node_modules/openclaw/docs/cli/plugins.md:376`,
`docs/plugins/building-plugins.md:192`, `docs/plugins/manifest/package-json.md:120`.

- `openclaw plugins install -l/--link <path>` — линкует локальный каталог **без
  копирования**, добавляет в `plugins.load.paths`; для неинтерактива — `--force`.
- TS-вход (`index.ts`) разрешён **только для source checkouts и local development
  paths** — а linked-install это как раз local dev (config-selected origin).
- Precedence (сверху вниз): **1. Config-selected (load.paths)** → 2. dev-source
  bundled → **3. Global install matching tracked record** (то, чем плагин является
  СЕЙЧАС) → … Config-selected бьёт tracked global.

НЕ редактировать `openclaw.json`/`openclaw.sqlite` руками — использовать CLI
`plugins uninstall` / `plugins install --link` / `plugins enable`.

## ВЫБРАН вариант B (полный перенос, без симлинка в итоге)

Целевой каталог исходников: **`/root/openclaw-plugins/telegram-user-tool`** — вне
managed-root (тот же диск `/root` → `mv` мгновенный; ~1.3G целиком). Вне extensions —
precedence чистый (только config-selected).

### Как «пропустить ссылку» перестаёт быть риском
1. **Критерий полноты — пустой grep.** После всех правок: `grep -rn
   "extensions/telegram-user-tool"` по репо (кроме `node_modules`, `docs/decisions/*`,
   `openspec/changes/archive/*`) И по VPS (`/etc/systemd`, `/root/.config/systemd`,
   `/root/.openclaw`, crontab, `.bashrc/.profile`) = **0 совпадений**. Ноль = доказано,
   что не пропущено ничего.
2. **Пауза всех `tg-*` юнитов на время миграции** (НЕ симлинк — симлинк внутри
   extensions сам форсит global). Таймеры/листенеры остановлены, переезд, запуск.
   Диспетчер идемпотентен — пропущенные тики восстановятся.
3. **Функциональная проверка каждого потребителя** (не «файл поправлен», а «работает»).

### ВАЖНО: `uninstall` стирает `plugins.entries.telegram-user-tool`
Включая `config` с `apiId/apiHash/sessionString`. Перед uninstall **сохранить** этот
блок и **вернуть** после install+enable. Полный бэкап `openclaw.json` — обязателен.

### Порядок выполнения
1. Preflight: нет активного прогона gateway; свежий бэкап `openclaw.json`; сохранить
   `jq '.plugins.entries."telegram-user-tool"'` в файл.
2. `systemctl --user stop openclaw-gateway.service`; остановить все `tg-*.timer` и
   листенер-сервисы (`tg-review-listener`, `tg-distribution-listener`).
3. `mkdir -p /root/openclaw-plugins` && `mv ~/.openclaw/extensions/telegram-user-tool
   /root/openclaw-plugins/telegram-user-tool` (сначала вынести — тогда uninstall не
   удалит файлы: managed-путь уже не существует).
4. `openclaw plugins uninstall telegram-user-tool` — снимает tracked-record + запись
   в load.paths + entries (файлы уже не в extensions → не трогаются).
5. `openclaw plugins install -l /root/openclaw-plugins/telegram-user-tool --force`.
6. `openclaw plugins enable telegram-user-tool`.
7. **Вернуть** сохранённый блок `plugins.entries.telegram-user-tool.config` в
   `openclaw.json` (gateway остановлен — перезаписи нет).
8. Обновить на VPS: 8 live-юнитов (`/etc/systemd/system/`) +
   `channel-activity-update-manual.sh` → новый путь; `systemctl daemon-reload`.
9. `systemctl --user start openclaw-gateway.service`; поднять таймеры/листенеры.
10. **Проверки**: лог без «requires compiled»; `plugins list --verbose` → origin
    config/linked + тулы; вызов тула ботом; тик `tg-agent@<N>`; по одному прогону
    периодических юнитов; grep старого пути на VPS = 0.
11. **Репо** (чтобы редеплой не вернул старый путь): `deploy/systemd/*` (8),
    `src/scripts/ops/channel-activity-update-manual.sh`, 6 скиллов (vps,
    tg-agent-create, tg-agent-create-v2, channel-metrics, import-agent-pool,
    mobile-proxy-provision), доки (`operation.md`, `architecture-diagrams.md`,
    `design/team-deploy`, `design/universal-script-control`,
    `openclaw-migration-2026.9.3.md`), `openclaw.json`. Затем grep репо = 0.

## Почему не дистрибутив (dist)

`src/` обязан оставаться на сервере ради диспетчера (tsx-таймеры). dist дал бы
двойную модель (плагин из dist, диспетчер из src) со split-brain при правке общих
`src/core/*` и сломал бы механизм `SCRIPT_PATH` (подпроцесс `tsx …provision-proxy.ts`
по пути от `__dirname`). Для одного сервера — лишняя сложность. Подробный разбор
рисков dist — в истории обсуждения.
