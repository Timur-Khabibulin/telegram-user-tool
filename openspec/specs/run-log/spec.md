# run-log Specification

## Purpose
TBD - created by archiving change run-status-tracking. Update Purpose after archive.
## Requirements
### Requirement: Запись прогона в таблицу runs

Диспетчер SHALL после каждого выполнения скилла записывать в таблицу `runs` (в per-agent `tasks.db`) строку со всеми полями прогона: `agentId`, `type` (тип скилла), `startedAt` (Unix-секунды начала прогона), `durationMs` (длительность), `status` (`success`|`error`), `error` (текст ошибки при `status = error`, иначе пусто), `llmCalls` (число фактических запросов к LLM за прогон). Запись SHALL выполняться для каждого прогона независимо от исхода (и `success`, и `error`). Сбой записи в `runs` SHALL НЕ прерывать прогон диспетчера.

#### Scenario: Успешный прогон записан
- **WHEN** скилл завершился со статусом `success`
- **THEN** в `runs` появляется строка с `status = success`, заполненными `agentId`, `type`, `startedAt`, `durationMs`, `llmCalls` и пустым `error`

#### Scenario: Ошибочный прогон записан с текстом ошибки
- **WHEN** скилл завершился со статусом `error`
- **THEN** в `runs` появляется строка с `status = error` и непустым `error`, извлечённым из `details` прогона

#### Scenario: Сбой записи не валит прогон
- **WHEN** запись в `runs` бросила исключение
- **THEN** диспетчер логирует ошибку и продолжает работу (сдвиг `nextRun`, отчёт в Saved Messages не отменяются)

### Requirement: Строка статуса прогона в journald

Диспетчер SHALL после каждого скилла эмитить в stdout (→ journald) одну строку со статусом прогона, содержащую `agentId`, тип скилла, статус, длительность и число LLM-запросов, пригодную для потокового поиска (`journalctl -g`).

#### Scenario: Статус виден в журнале
- **WHEN** диспетчер завершил прогон скилла
- **THEN** в journald есть строка с `agentId`, типом скилла, статусом (`success`/`error`), длительностью и числом LLM-запросов

### Requirement: Выборка прогонов за интервал

Модуль `core/db/runs.ts` SHALL предоставлять выборку прогонов агента за временной интервал — `getRunsBetween(agentId, startSec, endSec)` — возвращающую записи `runs`, у которых `startedAt` попадает в `[startSec, endSec)`. Схема `runs` SHALL создаваться идемпотентно (`ensureRunsSchema`).

#### Scenario: Возврат прогонов в окне
- **WHEN** вызывается `getRunsBetween` с границами окна
- **THEN** возвращаются только записи с `startedAt` в полуинтервале `[startSec, endSec)`

#### Scenario: Идемпотентное создание схемы
- **WHEN** `ensureRunsSchema` вызывается повторно
- **THEN** таблица `runs` создаётся, только если её ещё нет, без ошибок

