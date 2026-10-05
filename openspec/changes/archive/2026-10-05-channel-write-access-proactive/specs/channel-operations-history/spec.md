## ADDED Requirements

### Requirement: Событие write_access в журнале операций

Журнал операций над каналом SHALL поддерживать тип события `write_access`,
записываемый на месте обнаружения препятствия к записи (проактивная проверка перед
отправкой ЛИБО реактивный разбор ошибки отправки). Событие SHALL нести: обнаруженный
статус, его уровень (`channel`/`account`) и применённое действие
(`autorotate`/`suspend`/`suspend_temporary`/`join`/`join_request`). Для
`channelParticipantBanned` событие SHALL дополнительно нести `kicked_by`, `date` и
разобранные `banned_rights` (`send_messages`, нормализованный `until_date`); для
`channel.restricted` — причины ограничения (`platform`/`reason`/`text`). Запись SHALL
быть best-effort: сбой журнала не прерывает обработку канала. Событие `write_access`
SHALL быть отдельным от `status_change` (переход `status`), не подменяя его.

#### Scenario: Бан участника журналируется с полями

- **WHEN** проактивная проверка обнаруживает `channelParticipantBanned` и уводит канал
  на авторотацию
- **THEN** в журнал пишется событие `write_access` со статусом `participant_banned`,
  уровнем `account`, действием `autorotate` и полями `kicked_by`/`date`/`banned_rights`

#### Scenario: Ограничение канала журналируется с причиной

- **WHEN** обнаружен `channel.restricted=true` и канал уводится в suspend
- **THEN** в журнал пишется событие `write_access` со статусом `restricted`, уровнем
  `channel`, действием `suspend` и причинами `restriction_reason`
  (`platform`/`reason`/`text`)

#### Scenario: join_to_send журналируется без смены status

- **WHEN** обнаружен `channel.join_to_send=true` при неучастии и инициируется вступление
- **THEN** в журнал пишется событие `write_access` (статус `join_to_send`, действие
  `join`), при этом `status` канала событием `write_access` не меняется

#### Scenario: Сбой журнала не роняет обработку

- **WHEN** запись события `write_access` завершается ошибкой
- **THEN** обработка канала продолжается, действие (авторотация/suspend/вступление)
  применяется
