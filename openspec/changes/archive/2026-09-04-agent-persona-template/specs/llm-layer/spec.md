## RENAMED Requirements

- FROM: `### Requirement: Персона из SOUL.md без системных промптов OpenClaw`
- TO: `### Requirement: Персона из общего шаблона без системных промптов OpenClaw`

## MODIFIED Requirements

### Requirement: Персона из общего шаблона без системных промптов OpenClaw
Персона SHALL браться из общего шаблона `~/.openclaw/personas/<personName>/
SOUL.md`, где `<personName>` — значение поля `persona` из `tg-account.json`
агента, и передаваться как `system`-сообщение — без системных промптов
OpenClaw. Файл читается заново на каждый вызов диспетчера (не копируется в
рабочую папку агента и не кэшируется между процессами).

#### Scenario: SOUL.md шаблона персоны как system-сообщение
- **WHEN** оркестрация вызывает `complete({ system: soul, prompt })`
- **THEN** `soul` прочитан из `~/.openclaw/personas/<personName>/SOUL.md`
  (`<personName>` — персона агента из `tg-account.json`) и передан как
  `system`, системные промпты OpenClaw не применяются
