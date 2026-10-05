## REMOVED Requirements

<!--
persona-channel-setup поглощается фазой 2 (tg-agent-persona-deploy): создание
публичного канала персоны через сессию агента — её частный случай. До архивации
этого change тул/скилл помечены [DEPRECATED]; архивация снимает требования ниже.
-->

### Requirement: Batch public-channel setup for already-registered agents
**Reason**: Создание канала через сессию агента стало частью применения персоны в фазе 2.
**Migration**: `tg-agent-persona-deploy` — «Применение персоны сессией агента» (публичный канал + пост + закреп).

### Requirement: Persona resolved from the agent's stored configuration
**Reason**: В фазе 2 персона задаётся на входе прогона и пишется в `tg-account.json` при промоушене.
**Migration**: `tg-agent-persona-deploy` — вход «персона + M», запись `persona` при промоушене в агента.

### Requirement: Skip agents that already have a personal channel
**Reason**: Фаза 2 работает с обезличенными пул-аккаунтами без канала; идемпотентность канала обеспечивает переиспользуемый шаг применения персоны.
**Migration**: `tg-agent-persona-deploy` — идемпотентное применение персоны (guard «канал уже есть» в общем шаге настройки).
