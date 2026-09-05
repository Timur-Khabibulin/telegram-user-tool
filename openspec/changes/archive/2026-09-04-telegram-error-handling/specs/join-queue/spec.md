## ADDED Requirements

### Requirement: Статусная модель `join_queue.status`

Строка очереди SHALL иметь статус `pending` (начальное состояние и
состояние, в которое строка возвращается перед каждым следующим батчем из
`skipped`), `processing` (взята в текущий батч), `joined` (успешное
вступление, терминальный), `skipped` (временная причина отказа — флуд после
исчерпания повторов, или `CHANNELS_TOO_MUCH`) или `error` (постоянная
причина отказа — канал непригоден для вступления независимо от повторных
попыток).

#### Scenario: skipped возвращается в pending перед следующим батчем
- **WHEN** формируется очередной батч очереди на вступление
- **THEN** перед выборкой батча все строки со `status='skipped'`
  переводятся в `pending`

#### Scenario: error не ретраится автоматически
- **WHEN** формируется очередной батч очереди на вступление
- **THEN** строки со `status='error'` не попадают в батч ни на этом, ни на
  последующих прогонах — постоянное состояние, снимается только вручную

### Requirement: Ошибки при попытке вступления → error

При попытке вступления (поиск канала по username, получение информации о
канале, вступление — одна попытка, объединяющая три шага) ошибки
`USERNAME_NOT_OCCUPIED`, `USERNAME_INVALID`, `CHANNEL_PRIVATE`,
`CHANNEL_INVALID`, `USER_ALREADY_PARTICIPANT`, `INVITE_REQUEST_SENT`,
`INVITE_HASH_EXPIRED`, `INVITE_HASH_INVALID`, `USERS_TOO_MUCH` SHALL
переводить строку в `status='error'` с записью `errorMessage`.
`USER_BANNED_IN_CHANNEL`, возникший в контексте вступления, SHALL
обрабатываться на этой же ветке (`error`) — как и остальные ошибки этого
списка; отдельное поведение для него в контексте вступления не вводится.

#### Scenario: Постоянная причина отказа помечается error
- **WHEN** попытка вступления вернула `CHANNEL_PRIVATE`
- **THEN** строка получает `status='error'`, `errorMessage='CHANNEL_PRIVATE'`

#### Scenario: USER_BANNED_IN_CHANNEL при вступлении не меняет поведение
- **WHEN** попытка вступления вернула `USER_BANNED_IN_CHANNEL`
- **THEN** строка получает `status='error'` — то же поведение, что и для
  остальных ошибок этого Requirement, без выделения в отдельную ветку

### Requirement: CHANNELS_TOO_MUCH → skipped, отдельно от error-ветки

`CHANNELS_TOO_MUCH` (превышен лимит подписок аккаунта) SHALL переводить
строку в `status='skipped'` (не `error`), с записью `errorMessage` и
дополнительной записью в `error_log` (`skill_type='join-queue'`). Запись в
`agent_restrictions` НЕ создаётся.

#### Scenario: Лимит подписок — временная причина
- **WHEN** попытка вступления вернула `CHANNELS_TOO_MUCH`
- **THEN** строка получает `status='skipped'`, что означает возврат в
  `pending` перед следующим батчем — асимметрично `USERS_TOO_MUCH` (№22,
  `error`), осознанно (`telegram-errors.md`, №21)

### Requirement: FLOOD_WAIT при вступлении — до 2 повторов, затем skipped

При `FLOOD_WAIT_N`, возникшем на любом из трёх шагов попытки вступления,
SHALL применяться единая политика повтора (Requirement «Политика повтора
FLOOD_WAIT/SLOWMODE_WAIT» капабилити `group-monitoring`). Если после
исчерпания повторов ошибка сохраняется, либо время ожидания на очередном шаге
≥ порога — строка SHALL получить `status='skipped'` (не `error`).

#### Scenario: Флуд исчерпал повторы — skipped, не error
- **WHEN** `FLOOD_WAIT` при вступлении повторился после исчерпания попыток
  повтора
- **THEN** строка получает `status='skipped'`, а не `status='error'` —
  временная причина отказа, а не постоянная
