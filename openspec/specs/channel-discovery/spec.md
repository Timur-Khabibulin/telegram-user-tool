# channel-discovery Specification

## Purpose
TBD - created by archiving change channel-discovery. Update Purpose after archive.
## Requirements
### Requirement: Operator keyword discovery run

The discovery skill SHALL let an operator start a discovery run from a free-text sphere:
the LLM proposes keywords, the operator refines the list, and the operator sets the run
parameters `N` (target channel count), `min_subscribers` and `er_min`. The agreed
parameters SHALL be passed to the discovery script.

#### Scenario: Operator enters a sphere

- **WHEN** the operator enters a free-text sphere (e.g. «психология»)
- **THEN** the skill returns LLM-generated keyword suggestions for that sphere

#### Scenario: Operator refines keywords

- **WHEN** the operator edits the suggested keyword list (keeps, removes, adds)
- **THEN** the refined keyword list is what the discovery script searches by

#### Scenario: Operator sets run parameters

- **WHEN** the operator provides `N`, `min_subscribers` and `er_min`
- **THEN** these parameters are passed as arguments to the discovery script

### Requirement: ER explanation before threshold

Before requesting `er_min`, the skill SHALL explain how ER is computed (engagement by
reach, normalized %) so the operator sets a meaningful value.

#### Scenario: ER is explained first

- **WHEN** the skill asks the operator for `er_min`
- **THEN** the skill has already explained, in its first message, how ER is computed

### Requirement: Subscriber filter

The discovery script SHALL exclude channels whose subscriber count is below
`min_subscribers`, using counts already present in the search results without extra
requests.

#### Scenario: Below subscriber threshold

- **WHEN** a candidate channel has subscribers below `min_subscribers`
- **THEN** it is excluded before any ER request is made

#### Scenario: At or above subscriber threshold

- **WHEN** a candidate channel has subscribers at or above `min_subscribers`
- **THEN** it proceeds to the ER gate

### Requirement: ER quality gate

The discovery run SHALL determine each candidate's ER (engagement by reach, normalized %)
and SHALL exclude channels whose ER is below `er_min`. ER SHALL be determined only for
candidates that passed the subscriber gate. The means of obtaining ER is an implementation
detail.

#### Scenario: Below ER threshold

- **WHEN** a candidate channel's ER is below `er_min`
- **THEN** it is excluded and not collected

#### Scenario: At or above ER threshold

- **WHEN** a candidate channel's ER is at or above `er_min`
- **THEN** it is kept and counted toward `N`

### Requirement: Incremental selection to target

The discovery script SHALL search and filter until it collects `N` new channels or
exhausts the search space (all keywords × all pages), whichever comes first. Once `N` is
reached it SHALL stop and issue no further requests. `N` applies to the whole run, not per
agent.

#### Scenario: Target reached

- **WHEN** the script has collected `N` new channels
- **THEN** it stops and makes no further source requests

#### Scenario: Search space exhausted before target

- **WHEN** all keywords and pages are exhausted before `N` is collected
- **THEN** the script stops with the channels collected so far

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

