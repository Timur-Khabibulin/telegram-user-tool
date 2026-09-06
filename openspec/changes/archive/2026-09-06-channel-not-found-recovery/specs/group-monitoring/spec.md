## ADDED Requirements

### Requirement: Статус `not_found` для пропавших из диалогов каналов

Поле `channels.status` SHALL поддерживать значение `not_found` — канал, который
Telegram не вернул в списке диалогов агента при полной синхронизации, но который
агент не покидал осознанно (в отличие от `banned`/`suspend`/`leaved_*`/
`should_leave`). Канал SHALL находиться только в одном значении `status`
одновременно, как и для прочих статусов.

`not_found` SHALL исключать канал из батча мониторинга (`getChannelsBatch`) и из
подсчёта активных каналов — тем же способом, каким исключаются терминальные
статусы, а не проверкой в цикле монитора. `not_found` SHALL НЕ попадать в очередь
на выход (`leave-banned-channels`): агент не является участником такого канала,
выходить не из чего.

#### Scenario: Канал в `not_found` не берётся в мониторинг
- **WHEN** формируется батч назревших каналов (`getChannelsBatch`), и у канала `status = 'not_found'`
- **THEN** канал не попадает в батч и не учитывается как активный

#### Scenario: `not_found` не ставится в очередь на выход
- **WHEN** формируется очередь каналов на выход (`getLeaveQueue`)
- **THEN** каналы со `status = 'not_found'` в неё не включаются

### Requirement: Полная синхронизация каналов не удаляет строки

`syncChannels` SHALL НЕ удалять (`DELETE`) строку канала, отсутствующего в текущем
списке диалогов Telegram. Вместо удаления система SHALL применять правило по
текущему `status` пропавшего канала:

- `status` активный (`null`/`only_comment`/`sleep`/`format_error`) → перевести в
  `not_found` и обновить `statusUpdatedAt`;
- `status` терминальный (`banned`/`suspend`/`leaved_from_banned`/`leaved_manual`/
  `should_leave`) → не трогать (канал и должен отсутствовать в диалогах).

Строки `channels` SHALL сохраняться при любой синхронизации — история визитов,
метрики и identity канала не теряются.

#### Scenario: Активный канал пропал из диалогов
- **WHEN** `syncChannels` не нашёл в диалогах Telegram канал, у которого `status` пуст либо `only_comment`/`sleep`/`format_error`
- **THEN** его строка сохраняется, `status = 'not_found'`, `statusUpdatedAt = now()`

#### Scenario: Терминальный канал пропал из диалогов — не трогаем
- **WHEN** `syncChannels` не нашёл в диалогах канал со `status IN ('banned','suspend','leaved_from_banned','leaved_manual','should_leave')`
- **THEN** его строка сохраняется без изменений статуса (не переводится в `not_found`, не удаляется)

### Requirement: Повторное появление канала снимает `not_found`

`syncChannels` SHALL снимать статус `not_found`, если канал снова встретился в
списке диалогов Telegram: `status` возвращается в `null`. Терминальные статусы при
повторном появлении канала НЕ снимаются — авто-восстановлению подлежит только
`not_found`.

#### Scenario: Канал с `not_found` вернулся в диалоги
- **WHEN** `syncChannels` нашёл в диалогах канал, у которого `status = 'not_found'`
- **THEN** `status` сбрасывается в `null`, канал снова участвует в мониторинге

#### Scenario: Терминальный статус при появлении не снимается
- **WHEN** `syncChannels` нашёл в диалогах канал со `status = 'leaved_manual'` (например, повторно вступили извне)
- **THEN** `status` не снимается этим шагом (снятие статуса при вступлении — ответственность `join-queue`)
