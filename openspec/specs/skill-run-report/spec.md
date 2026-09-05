# skill-run-report Specification

## Purpose
TBD - created by archiving change improve-skill-reports. Update Purpose after archive.
## Requirements
### Requirement: Капабилити неактивна

Диспетчер SHALL NOT формировать и отправлять человекочитаемый отчёт прогона
в Saved Messages ни для одного рабочего агента — вся диагностика прогонов
ведётся через `runs`/`dispatcher_runs`/`error_log` (см. `run-log`). Все
предыдущие требования этой капабилити (рендер, длительность, счётчик
LLM-запросов, состав по типам скиллов) удалены как неприменимые; `details`
скиллов по-прежнему вычисляется кодом скиллов, но нигде не рендерится и не
сохраняется целиком.

#### Scenario: Отчёт в Saved Messages не формируется
- **WHEN** диспетчер завершает прогон любого скилла
- **THEN** в Saved Messages агента отчёт о прогоне не отправляется; исход прогона доступен через `runs` (per-agent `tasks.db`)

