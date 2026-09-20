## ADDED Requirements

### Requirement: Discovery targets one persona

Прогон дискавери SHALL идти в рамках одной персоны: оператор задаёт целевую
персону, а найденные каналы раскладываются round-robin только по её активным
агентам. Дедуп прогона SHALL быть в рамках этой персоны (канал, закреплённый в
другой персоне, — валидный кандидат). Смешение агентов разных персон в одном прогоне
SHALL быть невозможно.

#### Scenario: Каналы раскладываются по агентам целевой персоны

- **WHEN** прогон дискавери идёт для персоны А
- **THEN** новые каналы получают только активные агенты персоны А, а канал,
  закреплённый лишь в персоне Б, не отбрасывается как известный

### Requirement: Отказ при персоне без активных агентов

Если у целевой персоны нет ни одного активного агента (или персона неизвестна),
прогон дискавери SHALL быть отклонён до начала сбора, без частичного прогона.

#### Scenario: Нет активных агентов персоны

- **WHEN** дискавери запускается на персону без активных агентов
- **THEN** прогон отклоняется до сбора с сообщением о причине

## MODIFIED Requirements

### Requirement: Run report to operator

On completion the discovery run SHALL report how many channels were found and
distributed per agent of the target persona and whether `N` was reached. If the
space was exhausted before `N`, the report SHALL state this explicitly.

#### Scenario: Target reached report

- **WHEN** the run reaches `N`
- **THEN** the operator receives counts of channels found and distributed per agent
  of the target persona

#### Scenario: Exhaustion report

- **WHEN** the run ends with fewer than `N` channels because the space was exhausted
- **THEN** the report explicitly states the shortfall (e.g. «найдено 320 из 500; слова исчерпаны»)
