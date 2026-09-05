## 1. `src/core/config.ts` — конфигурация и пути персоны

- [x] 1.1 Добавить `persona: string` в `AccountConfig`.
- [x] 1.2 В `loadAccountConfig()` добавить `persona` в проверку обязательных
      полей (вместе с `apiId`/`apiHash`/`sessionString`) и в деструктуризацию
      результата.
- [x] 1.3 Добавить `personasRoot()` → `~/.openclaw/personas`.
- [x] 1.4 Добавить `personaSoulPath(personName: string)` →
      `path.join(personasRoot(), personName, "SOUL.md")`.
- [x] 1.5 Удалить `soulPath(agentId)` (единственный потребитель —
      `dispatcher.ts`, переведён на `personaSoulPath`).

## 2. `src/core/tg-agent-autoregistration/persona-template.ts`

- [x] 2.1 `templatesDir(personName)` — заменить реализацию на
      `path.join(personasRoot(), personName)`, импортируя `personasRoot` из
      `../config`.
- [x] 2.2 `autoregistrationRoot()` оставить без изменений (используется
      только для `stagingRoot()` в `staging.ts` — область staging персон не
      затрагивает).

## 3. `src/scripts/dispatcher.ts` — фатальная ошибка при отсутствии персоны

- [x] 3.1 `readPersona(personName)` — убран `try/catch`, читает
      `fs.readFileSync(personaSoulPath(personName), "utf-8")` напрямую —
      ошибка пробрасывается в `main().catch(...)` (существующий механизм
      фатального завершения диспетчера).
- [x] 3.2 `readPersona` вызывается после `tg.loadAccount(agentId)` (Шаг 1
      диспетчера) через новый `tg.getAccountConfig().persona` (публичный
      геттер на `TelegramService`) — `tg-account.json` не читается повторно.

## 4. `src/core/tg-agent-autoregistration/staging.ts`

- [x] 4.1 `promoteToWorkspace()` — убрана запись `SOUL.md` в
      `staging/`/`workspace-<agentId>/`.
- [x] 4.2 `persona` теперь часть самого `accountConfig` (поле `AccountConfig
      .persona`), отдельный параметр `personName`/`soulMdContent` в
      `promoteToWorkspace()` не нужен — сигнатура упрощена до
      `(agentId, accountConfig)`.
- [x] 4.3 `src/core/tg-agent-autoregistration/run.ts` —
      `finalizeProxyOutcome` принимает `personName` (из `template.
      personName`) вместо `soulMdPath`, кладёт его в `accountConfig.persona`;
      `template.soulMdPath` для копирования больше не читается (поле в
      `PersonaTemplate` осталось — по-прежнему валидирует наличие `SOUL.md`
      в шаблоне при `loadPersonaTemplate`).

## 5. Прочие потребители `persona-template.ts`

- [x] 5.1 `src/core/tg-agent-reauth-from-tdata/run.ts` — использует только
      `templatesDir()`, изменений не требует, резолвится на новый корень
      автоматически.
- [x] 5.2 `src/core/tdata/account-setup.ts` — использует только тип
      `PersonaTemplate` и данные из `loadPersonaTemplate()`, изменений не
      требует.

## 6. `skills/tg-agent-create/SKILL.md`

- [x] 6.1 Шаг 6 (`tg-account.json`) — добавлено поле `"persona": "<personName>"`
      в шаблон JSON; дефолт `maria` (единственная персона на платформе),
      явно спрашивать только если пользователь просит другую.
- [x] 6.2 Шаг 7 — убран `cp SOUL.md`. Если `<personName>` уже существует в
      `~/.openclaw/personas/` — шаг завершается сразу. Ветка «новая персона» —
      запросить текст у пользователя, создать `~/.openclaw/personas/<новое-имя>/
      SOUL.md`, не писать в workspace агента.
- [x] 6.3 (найдено при реализации, не было в исходном списке) —
      `create-agent-scaffold.sh` (комментарий + шаблон `AGENTS.md`) и
      `verify-agent.sh` (проверка B2) ссылались на `$ws/SOUL.md` напрямую —
      без правки скилл проверял бы несуществующий файл. `AGENTS.md` теперь
      указывает читать `persona` из `tg-account.json` и брать `SOUL.md` из
      `~/.openclaw/personas/<persona>/`; `verify-agent.sh` B2 проверяет то же
      через `jq`.

## 7. Документация

- [x] 7.1 `docs/operation.md` — убран `SOUL.md` из таблицы файлов
      `workspace-<agentId>/`, добавлен раздел «Персона
      `~/.openclaw/personas/<personName>/`» со связью через `persona` в
      `tg-account.json`.
- [x] 7.2 `docs/configuration.md` — `templates/<personName>/` вынесен из
      таблицы `tg-agent-autoregistration` в отдельный раздел «Персона —
      `~/.openclaw/personas/<personName>/`» (общий каталог, не специфичный
      для автогенерации); в таблицу `tg-account.json` добавлено поле
      `persona`.
- [x] 7.3 `docs/README.md` — строка про корневой `SOUL.md` исправлена на
      `~/.openclaw/personas/<personName>/SOUL.md` (сервер, вне репозитория).
- [x] 7.4 `docs/product.md` — «Агент… со своей персоной» и раздел
      «Персона» обновлены: ссылка на общий шаблон вместо «своей»/«под
      аккаунт». `docs/knowledge-base-task.md` — раздел «SOUL.md — конфиг
      runtime-продукта» дополнен строкой про расположение вне репозитория и
      ссылку через `persona`.
- [x] 7.5 `docs/architecture.md` — `SkillContext` (`agentId`, `persona`,
      `tg`, `llm`, `log`) описывает только интерфейс скилла (persona —
      строка текста), путь к источнику не называет — изменений не требует.

## 8. Проверка

- [x] 8.1 `npx tsc --noEmit` — в затронутых файлах (`config.ts`,
      `dispatcher.ts`, `persona-template.ts`, `staging.ts`,
      `tg-agent-autoregistration/run.ts`, `telegram/service.ts`) новых ошибок
      нет. `tsconfig.json` в целом сейчас не собирается штатным `tsc`
      (`moduleResolution: bundler` требует `module: preserve`/`es2015+`,
      а стоит `commonjs`) — это существующая проблема конфигурации, не
      связанная с этим change (видна в `git diff tsconfig.json` как чужая
      правка, уже была в рабочем дереве до начала этой сессии). Проверено
      через `tsc --noEmit --moduleResolution node --module commonjs`, что
      обходит только эту проблему конфигурации.

## 9. Операционная миграция на VPS (вне кода, только с подтверждением оператора)

- [x] 9.1 Скопировано `~/.openclaw/tg-agent-autoregistration/templates/maria/`
      → `~/.openclaw/personas/maria/` (единственная персона на платформе).
      `diff -r` пустой, `md5sum SOUL.md` совпадает с любым `workspace-*/SOUL.md`.
- [x] 9.2 `"persona": "maria"` добавлено во все 140 существующих
      `tg-account.json` через `jq` (атомарно, tmp+mv на файл). Все 140 после
      правки — валидный JSON, поле подтверждено. 2 workspace без
      `tg-account.json` (`agent32`, `agent38`) — уже были нерабочими до этого
      change, не трогались.
- [x] 9.3 Задеплоен код (`config.ts`, `dispatcher.ts`, `telegram/service.ts`,
      `tg-agent-autoregistration/{persona-template,staging,run}.ts`) и скилл
      (`tg-agent-create/SKILL.md` + `scripts/*.sh`) на VPS, `chown -R
      root:root` на `extensions/` и `personas/`, `openclaw gateway restart`
      выполнен успешно. Перед деплоем сверен diff локальных файлов с уже
      развёрнутыми на сервере — расхождений, кроме ожидаемых правок этого
      change, не найдено.
- [x] 9.4 `agent1` — прогнан вручную (`systemctl start tg-agent@agent1`):
      `tg_load_account` прошёл (значит `persona` в `tg-account.json`
      провалидировалась), `no due tasks, exiting` — нормальный холостой
      выход, задач в очереди не было. Дополнительно — прямой вызов
      `loadAccountConfig()`+`personaSoulPath()` (тот же код, что использует
      `readPersona` в диспетчере) для `agent1`/`agent27`/`agent220`: у всех
      `persona=maria`, `SOUL.md` читается, 7917 байт — совпадает с размером
      файла в общем каталоге.
- [x] 9.5 Удалено (с явного подтверждения): 142 файла
      `workspace-<agentId>/SOUL.md` и каталог
      `tg-agent-autoregistration/templates/`. `~/.openclaw/personas/
      maria/SOUL.md` не затронут. Gateway перезапущен, `agent1` прогнан
      повторно — `tg_load_account` проходит, поведение не изменилось.
