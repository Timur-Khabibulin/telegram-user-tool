## Why

Текущие мониторы разошлись на два несовместимых типа поведения: `monitor` (v1)
читает весь чат обсуждения (непрочитанные сообщения, отвечает на общие
реплики, ведёт свои диалоговые ветки, копит DM-кандидатов), а `monitor-v3`/
`monitor-v4` — только конкретный пост канала (и, в `only_comment`, одну
конкретную ветку под ним), полностью игнорируя остальную активность чата.
Нужен скилл, который читает весь чат, как v1 — с той же логикой отбора и
генерации ответа, что и у v1 — но с более зрелой обработкой ошибок отправки,
уже отработанной на `monitor-v3`/`monitor-v4` (учёт `PEER_FLOOD`, банов
каналов, эскалации).

## What Changes

- Новый скилл `src/skills/monitor-v5.ts` (`runMonitorV5`) и `TaskType`
  `"monitor-v5"` — независимая, параллельно включаемая версия (тот же
  принцип аддитивности, что у `monitor-v2`/`monitor-v3`/`monitor-v4`).
- Логика чтения чата и данных, решение по общим сообщениям, DM-скоринг,
  ведение и продолжение диалоговых веток — **без изменений от `monitor.ts`
  (v1)**: синхронизация каналов, `getChannelsBatch` (батч + троттлинг по
  `lastProcessedAt`), `getDialogsForBatch`, `getMessages`, `classifyMessages`,
  `generateThreadReply`/`generateThreadContinuation`,
  `analyzeChannelMessages` + `generateReply` (отбор ≤1 общего сообщения для
  ответа + скоринг DM-кандидатов одним вызовом, как у v1).
- **Единственное отличие от `monitor.ts`** — обработка ошибок отправки: везде
  (новые ветки, продолжения, общие сообщения) заменена на классификацию
  `monitor-v3`/`monitor-v4` (`handlePostCommentSendError`/`PeerFloodError`/
  `ChannelSkipError`, `core/post-comment-send.ts`): учитывает `PEER_FLOOD`
  (приостановка агента), порог банов каналов (приостановка агента), переходы
  `status` канала в `banned`/`format_error` — вместо более простой инлайн-
  обработки, которая была в v1 (та не знает про эти статусы и эскалацию).
- Проверки поста канала (веб-превью, гейт по комментариям, `only_comment`) —
  **отсутствуют**. `monitor-v5` не делает ничего из того, что делает
  `monitor-v3`/`monitor-v4` в части постов — только чат.
- `monitor.ts`/`monitor-v4.ts` не меняются ни строкой.

## Capabilities

### New Capabilities
- `group-monitoring-v5`: чтение и ответ на сообщения в группе обсуждения
  (общие сообщения, ветки, DM-кандидаты — поведение `group-monitoring`,
  капабилити `monitor.ts`, без изменений), с обработкой ошибок отправки
  уровня `monitor-v4`.

### Modified Capabilities
(нет — `group-monitoring` (v1) и `channel-post-watch-v4` не меняются;
`monitor-v5` — новая, независимая способность)

## Impact

- `src/skills/monitor-v5.ts` — новый файл (копия-адаптация `monitor.ts`:
  чтение чата, решение по общим сообщениям и DM-скоринг без изменений;
  отправка — на `handlePostCommentSendError`).
- `src/core/db/channels.ts` — `SendErrorSource` += `"monitor_v5"`.
- `src/core/db/tasks.ts` — `TaskType` += `"monitor-v5"`,
  `DEFAULT_PERIODIC_SCHEDULE["monitor-v5"]` (те же 180 мин/Asia/Yekaterinburg,
  что и у `"monitor"`, — тот же каданс, что уже был у v1).
- `src/scripts/dispatcher.ts` — `SKILLS["monitor-v5"] = runMonitorV5`,
  LLM-логирование расширяется на `monitor-v5` (та же обёртка, что уже
  покрывает `monitor-v3`/`monitor-v4`/`channel-context`).
- `index.ts` — `taskTypeParam` (OpenClaw-тул `tg_scheduler_*`) += `"monitor-v5"`
  (пробел, который уже находили и чинили для `monitor-v3`/`monitor-v4` —
  не повторять для v5).
- `skills/scheduler-control/SKILL.md`, `docs/task-scheduling.md`,
  `docs/architecture.md` — новая строка `monitor-v5`.
- Наблюдаемое поведение: у агентов, которым явно включат `monitor-v5`, чат
  обсуждения снова читается и получает ответы на общие сообщения — тем же
  способом и с тем же качеством отбора, что и у `monitor` (v1); меняется
  только устойчивость к ошибкам отправки (флуд/баны/эскалация обрабатываются
  строже, как у `monitor-v4`).
