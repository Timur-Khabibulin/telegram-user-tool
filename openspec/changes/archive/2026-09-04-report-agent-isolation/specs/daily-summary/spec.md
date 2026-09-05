## RENAMED Requirements

- FROM: `### Requirement: Доставка дневной сводки админ-аккаунту по расписанию`
- TO: `### Requirement: Доставка дневной сводки получателю по расписанию`

## MODIFIED Requirements

### Requirement: Перечисление агентов

`core/config.ts` SHALL предоставлять `listAgentIds()`, возвращающий идентификаторы всех
агентов по директориям `~/.openclaw/workspace-<agentId>`, за исключением
`REPORT_AGENT_ID` — он не возвращается, даже если его workspace-каталог существует.

#### Scenario: Перечисление по директориям workspace

- **WHEN** вызывается `listAgentIds()`
- **THEN** возвращаются `agentId` из всех каталогов `workspace-*`, кроме `REPORT_AGENT_ID`

#### Scenario: Зарезервированный агент не входит в сводку

- **WHEN** строится дневная сводка прогонов
- **THEN** `REPORT_AGENT_ID` не обходится и не появляется в структурной разбивке `perAgent`, даже если у него есть workspace-каталог

### Requirement: Доставка дневной сводки получателю по расписанию

Standalone-скрипт `src/scripts/daily-summary.ts --send-as <agentId>` SHALL построить
сводку за завершившийся день UTC+5, загрузить указанный аккаунт через
`TelegramService` и отправить текст сводки в его Saved Messages. Значение по
умолчанию — `REPORT_AGENT_ID`; аргумент допускает явное переопределение. systemd-таймер
`tg-daily-summary.timer` SHALL запускать скрипт раз в день на границе дня UTC+5
(19:00 UTC).

#### Scenario: Сводка ушла в Saved Messages получателя

- **WHEN** отработал `daily-summary.ts` (со значением `--send-as` по умолчанию или явно заданным)
- **THEN** в Saved Messages указанного аккаунта появляется текст дневной сводки за завершившийся день

#### Scenario: Запуск без флага использует REPORT_AGENT_ID

- **WHEN** `daily-summary.ts` запущен без `--send-as`
- **THEN** сводка уходит в Saved Messages `REPORT_AGENT_ID`

#### Scenario: Запуск по таймеру раз в день

- **WHEN** наступает граница дня UTC+5 (19:00 UTC)
- **THEN** `tg-daily-summary.timer` запускает `tg-daily-summary.service`, который формирует и отправляет сводку
