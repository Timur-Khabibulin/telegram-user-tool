## Context

Персона агента (`SOUL.md`) сегодня физически копируется в
`workspace-<agentId>/SOUL.md` при регистрации агента (см. proposal.md —
«Why»). `soulPath()`/`readPersona()` в `src/core/config.ts` и
`src/scripts/dispatcher.ts` читают именно эту копию на каждый прогон
диспетчера, без кэша между процессами (каждый прогон — отдельный short-lived
процесс, systemd `tg-agent@<agentId>.service`, один процесс = один агент).

Источник шаблонов для копирования — `src/core/tg-agent-autoregistration/
persona-template.ts` (`loadPersonaTemplate`), читающий
`~/.openclaw/tg-agent-autoregistration/templates/<personName>/`. Этот же
модуль и путь используются ещё в трёх местах: `staging.ts`
(`promoteToWorkspace` — перенос staging → workspace при завершении
регистрации), `tg-agent-reauth-from-tdata/run.ts` (читает
`default_agent_data.json` шаблона `"maria"` для пароля 2FA при повторной
авторизации из tdata) и `tdata/account-setup.ts` (загрузка фото/поста в
профиль при первичной настройке аккаунта). Единственная используемая на
сегодня персона — `maria` (см. `DEFAULT_PASSWORD_TEMPLATE` в
`tg-agent-reauth-from-tdata/run.ts`).

Диспетчер — единственный consumer персоны как *текста промпта*
(`ctx.persona` → `llm.complete({ system: persona, ... })`, см.
`src/skills/types.ts`). Остальные потребители `persona-template.ts` работают
не с текстом `SOUL.md`, а с бинарными/JSON-файлами шаблона (фото, `post.txt`,
`profile_data.json`) — это разовая настройка TG-профиля аккаунта, которая
после этого change не меняется.

## Goals / Non-Goals

**Goals:**
- Персона резолвится по ссылке (`persona` в `tg-account.json`), а не по
  копии файла в workspace агента.
- `SOUL.md` читается заново на каждый прогон диспетчера из общего каталога
  `~/.openclaw/personas/<personName>/` — правка текста применяется ко всем
  агентам с этой персоной без ручной рассылки.
- Отсутствие ссылки на персону или самого файла `SOUL.md` — фатальная
  ошибка прогона агента, а не тихий пустой промпт.
- Общий каталог персон переезжает на путь верхнего уровня
  (`~/.openclaw/personas/`), не завязанный по имени на фичу автогенерации.

**Non-Goals:**
- Не переносим на live-чтение остальные файлы шаблона (`post.txt`, фото,
  `profile_data.json`, `default_agent_data.json`) — они остаются
  одноразовой копией при регистрации, поведение не меняется.
- Не вводим отдельный `id`/`persona.json` внутри папки шаблона — ID персоны
  = имя папки (см. explore-обсуждение change: избегаем дублирования одного
  факта).
- Не меняем формат/схему самого `SOUL.md`.
- Миграция существующих агентов и каталогов на VPS — не часть кода этого
  change, отдельная операционная задача (см. «Migration Plan»).

## Decisions

### 1. Поле `persona` — обязательное в `tg-account.json`, валидируется в `loadAccountConfig`

`AccountConfig` (`src/core/config.ts`) получает поле `persona: string`.
`loadAccountConfig()` проверяет его наравне с `apiId`/`apiHash`/
`sessionString` (та же строка `if (!cfg.apiId || ...) throw new Error(...)`,
`persona` добавляется в проверку и в деструктуризацию результата).

Почему здесь, а не только при чтении `SOUL.md` в диспетчере: `tg.loadAccount
(agentId)` (`TelegramService.loadAccount`) вызывает `loadAccountConfig`
на Шаге 1 диспетчера — **до** подключения к Telegram и до `readPersona()`
(Шаг, где сейчас читается персона). Это уже единая точка «падает рано при
отсутствии» (см. комментарий в `dispatcher.ts:164`) для всех обязательных
полей аккаунта — валидация `persona` там же не создаёт новую точку отказа,
использует существующую.

Альтернатива — валидировать только в `readPersona()`/при резолве шаблона:
отклонена, потому что развела бы проверку обязательных полей аккаунта на
два места и потеряла бы более раннее и однозначное сообщение об ошибке
(«отсутствует поле persona» вместо непрямого падения где-то ниже по потоку).

### 2. Общий корень персон — `personasRoot()` в `config.ts`, `persona-template.ts` импортирует его

Новая функция `personasRoot()` (`~/.openclaw/personas`) размещается в
`src/core/config.ts` — том же файле, где уже живут все прочие пути к данным
платформы (`workspaceDir`, текущий `soulPath`). `templatesDir(personName)`
в `persona-template.ts` меняет реализацию на
`path.join(personasRoot(), personName)` вместо собственного
`autoregistrationRoot()`.

`autoregistrationRoot()` (`~/.openclaw/tg-agent-autoregistration`) **не
удаляется** — он остаётся источником пути для `stagingRoot()`
(`staging.ts`), которая по смыслу — временная область незавершённой
регистрации, а не хранилище персон, и не должна переезжать вместе с
персонами.

Почему не оставить `templatesDir`/корень в `persona-template.ts`: этот
модуль называется и по смыслу принадлежит фиче автогенерации, но после
change от общего каталога персон зависит рантайм каждого агента (через
`config.ts`/`dispatcher.ts`) — более узкий модуль не должен быть источником
пути для более общего/центрального. Разместив `personasRoot()` в
`config.ts`, сохраняем «один факт — один дом»: все пути к данным платформы
резолвятся из одного файла.

### 3. Резолв `SOUL.md` — новая функция вместо `soulPath`

`soulPath(agentId)` в `config.ts` (текущая реализация:
`workspaceDir(agentId) + "/SOUL.md"`) заменяется на функцию, принимающую
персону, а не `agentId`:

```
personaSoulPath(personName: string): string
  → path.join(personasRoot(), personName, "SOUL.md")
```

`dispatcher.ts::readPersona(agentId)` резолвит `personName` через
`loadAccountConfig(agentId).persona` (или переиспользует уже загруженный
`AccountConfig`, если он доступен в этой точке потока — на Шаге, где сейчас
вызывается `readPersona`, `tg.loadAccount` уже отработал) и вызывает
`personaSoulPath(personName)`.

### 4. Фатальная ошибка при отсутствии файла — убрать `try/catch` в `readPersona`

Текущая реализация:

```ts
function readPersona(agentId: string): string {
    try {
        return fs.readFileSync(soulPath(agentId), "utf-8");
    } catch {
        log.warn(`[dispatcher] SOUL.md not found for agent ${agentId} — empty persona`);
        return "";
    }
}
```

Меняется на прямой `fs.readFileSync(personaSoulPath(personName), "utf-8")`
без перехвата ошибки. `main().catch((err) => { log.error(...); process.exit
(1); })` в самом низу `dispatcher.ts` уже перехватывает любое необработанное
исключение из `main()` и завершает процесс с ненулевым кодом — это
существующий механизм фатальных ошибок диспетчера, новый код им
переиспользуется, ничего дополнительно оборачивать не нужно.

`readPersona()` вызывается до `try/finally` блока, отвечающего за `tg.
disconnect()` (Шаг 5/6) — на этом этапе клиент Telegram ещё не подключался
(«подключается лениво при первой операции», `dispatcher.ts:194`), поэтому
исключение до входа в `try` не оставляет повисшего соединения.

### 5. ID персоны = имя папки шаблона

Без изменений относительно explore-решения: никакого отдельного `id`-поля
внутри `personas/<personName>/`. Уникальность имени папки в файловой
системе — уже достаточная гарантия уникальности ID.

## Risks / Trade-offs

- **[Риск] Опечатка в `persona` ломает прогон агента, где раньше был бы
  пустой (но рабочий) промпт.** → Это осознанное ужесточение (решение
  пользователя в explore-сессии): молчаливый пустой промпт хуже, чем
  видимая остановка прогона — агент с пустой персоной вёл бы себя
  непредсказуемо в проде, а не просто не работал.
- **[Риск] Изменение общего `SOUL.md` мгновенно влияет на всех агентов этой
  персоны без возможности отката по отдельному агенту.** → Это ожидаемое
  следствие цели change (единая точка правки). Если в будущем понадобится
  постепенный раскат/A-B персоны — потребуется отдельный механизм (не в
  рамках этого change).
- **[Риск] Циклический импорт между `config.ts` и `persona-template.ts`.**
  → Не возникает: `persona-template.ts` уже ни от чего в `core/` не
  зависит (только `fs`/`path`/`os`), а после change будет импортировать
  `personasRoot` из `config.ts` — направление зависимости одностороннее.

## Migration Plan

Код этого change сам по себе не трогает продовые данные. Разворачивание
требует отдельных ручных операционных шагов на VPS, **каждый — с явным
подтверждением оператора** (`agent-playbook.md`: необратимые операции с
данными только с подтверждения):

1. Скопировать (не переместить, до проверки) `~/.openclaw/
   tg-agent-autoregistration/templates/<personName>/` →
   `~/.openclaw/personas/<personName>/` для каждой существующей персоны
   (сегодня — только `maria`).
2. Добавить `"persona": "<personName>"` в `tg-account.json` каждого
   существующего агента.
3. Задеплоить новый код, перезапустить `openclaw gateway`.
4. Проверить прогон 1-2 агентов (`journalctl -u tg-agent@<agentId>`) —
   персона резолвится, ошибок нет.
5. Только после проверки — удалить устаревшие `workspace-<agentId>/
   SOUL.md` и старый каталог `tg-agent-autoregistration/templates/`.

Откат: пока шаг 5 не выполнен, старые файлы остаются на диске нетронутыми —
откат кода делает `workspace-<agentId>/SOUL.md` снова релевантным без
дополнительных действий.

## Open Questions

- Нет открытых вопросов — все развилки закрыты пользователем в
  explore-сессии перед созданием этого change.
