## Why

Персона агента (`SOUL.md`) сегодня копируется файлом в `workspace-<agentId>/SOUL.md`
один раз при регистрации агента — либо `cp` с `workspace-agent1/SOUL.md`
(`tg-agent-create`), либо копированием текста из шаблона автогенерации
(`tg-agent-autoregistration`). После копирования связь агента с исходным
шаблоном персоны теряется: ни в одном конфиге не хранится, откуда персона
взята. Правка персоны требует ручной рассылки файла по всем
`workspace-<agentId>/` — при росте числа агентов и персон это не
масштабируется и легко расходится (агенты с одной и той же персоной незаметно
получают разный текст).

## What Changes

- Персона агента задаётся ссылкой на именованный шаблон — новое поле
  `persona` в `tg-account.json` (`personName`, совпадает с именем папки
  шаблона).
- Общий каталог шаблонов персон переезжает из
  `~/.openclaw/tg-agent-autoregistration/templates/<personName>/` в
  `~/.openclaw/personas/<personName>/` — путь верхнего уровня, не привязанный
  к фиче автогенерации (от него теперь зависит рантайм всех агентов).
- Текст промпта (`SOUL.md`) на каждом прогоне диспетчера читается ЖИВЬЁМ из
  `~/.openclaw/personas/<personName>/SOUL.md` — больше не копируется в
  `workspace-<agentId>/`. **BREAKING**: `workspace-<agentId>/SOUL.md`
  перестаёт быть источником персоны; уже существующие копии там становятся
  неактуальными.
- Остальные файлы шаблона персоны (`post.txt`, `photo_profile_N.*`,
  `channel_photo.*`, `channel_post_photo.*`, `default_agent_data.json`,
  `profile_data.json`) продолжают копироваться один раз при регистрации
  агента — это одноразовая настройка TG-профиля аккаунта, не промпт;
  поведение не меняется.
- Отсутствие `persona` в `tg-account.json` или отсутствие файла
  `personas/<personName>/SOUL.md` на диске — фатальная ошибка: прогон
  диспетчера для этого агента останавливается (сейчас — тихий пустой
  промпт + `log.warn`).
- `tg-agent-create` (Шаг 6/7) перестаёт копировать `SOUL.md` и вместо этого
  записывает `persona` в `tg-account.json`.

## Capabilities

### New Capabilities
- `persona-template`: хранение и разрешение персоны агента — поле `persona`
  в `tg-account.json`, общий каталог `~/.openclaw/personas/<personName>/`,
  правила ошибок при отсутствии персоны/файла.

### Modified Capabilities
- `llm-layer`: требование «Персона из SOUL.md без системных промптов
  OpenClaw» меняет источник — вместо пути внутри workspace агента персона
  читается из общего каталога `personas/<personName>/SOUL.md` по ссылке
  `persona` из `tg-account.json`; путь в текущей спеке
  (`~/.openclaw/agents/<agentName>/agent/SOUL.md`) уже расходится с кодом
  (см. `src/core/config.ts:297` — комментарий об этом расхождении) и
  заменяется актуальным.

## Impact

- `src/core/config.ts` — `soulPath`/`readPersona`-логика, тип `AccountConfig`
  (+ поле `persona`), `loadAccountConfig`.
- `src/scripts/dispatcher.ts` — `readPersona()`: фатальная ошибка вместо
  `try/catch` → `""`.
- `src/core/tg-agent-autoregistration/persona-template.ts` —
  `autoregistrationRoot()`/`templatesDir()`: новый корень путей
  (`~/.openclaw/personas/`), используется также в
  `src/core/tg-agent-autoregistration/run.ts`,
  `src/core/tg-agent-autoregistration/staging.ts`,
  `src/core/tg-agent-reauth-from-tdata/run.ts`,
  `src/core/tdata/account-setup.ts`.
- `src/core/tg-agent-autoregistration/staging.ts` — `promoteToWorkspace()`:
  убрать запись `SOUL.md` в workspace, писать `persona` в `tg-account.json`.
- `skills/tg-agent-create/SKILL.md` — Шаг 6/7: `persona` вместо `cp SOUL.md`.
- Документация: `docs/operation.md`, `docs/configuration.md`,
  `docs/README.md`, `docs/product.md`, `docs/knowledge-base-task.md`.
- Эксплуатация VPS (отдельно, вне кода, только с подтверждением оператора):
  перенос `tg-agent-autoregistration/templates/` → `personas/`, простановка
  `persona` в существующих `tg-account.json`, удаление устаревших
  `workspace-<agentId>/SOUL.md`.
