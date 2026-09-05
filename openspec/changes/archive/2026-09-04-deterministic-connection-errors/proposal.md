## Why

`TelegramService.ensureClient()` (`src/core/telegram/service.ts`) сворачивает три
структурно разные причины невозможности подключиться к Telegram в один и тот же
`ClientNotConnectedError("Client not connected")`:

- отсутствует обязательное поле аккаунта (`apiId`/`apiHash`/`sessionString`) —
  конфигурационный баг, ретраи бессмысленны;
- Telegram вернул RPC-ошибку 401 (например `AUTH_KEY_UNREGISTERED`) — сессия отозвана
  навсегда, ретраи бессмысленны, нужен человек с переавторизацией;
- все попытки `connect()` истекли по таймауту — временная перегрузка сети/VPS/прокси,
  само рассасывается, ретрай на следующем плановом тике осмысленен.

Эта потеря информации уже дважды приводила к тому, что диагностика требовала ручного
разбора `journalctl` по десяткам агентов вместо чтения `runs.error`/отчёта в Saved
Messages:

- 2026-07-06: 5 агентов (`agent13`, `agent15`, `agent21`, `agent25`, `agent26`) неделю
  подряд безуспешно ретраили `AUTH_KEY_UNREGISTERED` каждые 10 минут, пока не были
  вручную остановлены человеком, обнаружившим причину через сырые логи. Тот же прогон
  зафиксировал ещё 6 агентов с `FROZEN_METHOD_INVALID` и ~10 — с таймаутами подключения
  (см. `openspec/changes/report-agent-isolation/design.md`, Context — этот change решает
  соседнюю проблему той же природы: изоляцию получателя отчётов от потери сессии
  рабочим агентом, не саму классификацию ошибок).
- 2026-07-17: волна `connect timed out after 15s` у agent9/10/11/14/18/23/24/28/30/31/
  35/39/40/41/43 потребовала ручного сопоставления времени срабатывания heartbeat-таймеров
  и нагрузки VPS, чтобы отличить эту (временную, самовосстанавливающуюся) причину от
  первой (постоянной).

GramJS отдаёт структурные поля на RPC-ошибках (`err.code`, `err.errorMessage` —
`node_modules/telegram/errors/index.js:20-28`), а не только форматированную прозу —
классификация не требует хрупкого парсинга человекочитаемого текста.

## What Changes

- `src/core/telegram/errors.ts`: три конкретных, самоописывающих класса ошибок вместо
  одного generic —`MissingAccountConfigError`, `ConnectTimeoutError`,
  `SessionRevokedError` — каждый со своим текстом, называющим причину напрямую (какое
  поле отсутствует / сколько ждали и на какой попытке / сырой код+текст RPC-ошибки
  Telegram). Все три наследуются от `ClientNotConnectedError`, который становится
  абстрактным маркером: сам никогда не бросается, используется только для существующих
  `instanceof`-проверок «подключение мертво, прогон/цикл пора останавливать»
  (`dispatcher.ts`, 4 места в `discovery/similar.ts`) — эти проверки не меняются.
- `src/core/telegram/service.ts`: `ensureClient()` бросает конкретный класс в каждой из
  трёх точек сбоя вместо `return null`; `requireClient()` больше не нужен как
  null-в-throw обёртка.
- `src/core/db/tasks.ts`: новая функция `disableAllTasks(agentId)` — `enabled=0` для
  всех задач агента (аналог существующей `disableTask(agentId, type)`, без фильтра по
  `type`).
- `src/scripts/dispatcher.ts`: при `err instanceof SessionRevokedError` — вызов
  `disableAllTasks(agentId)` в дополнение к остановке прогона; при двух других причинах
  — поведение не меняется (прогон останавливается, `nextRun` сдвигается штатно).

## Capabilities

### New Capabilities

- `telegram-connection-errors`: сбои подключения к Telegram классифицируются по
  конкретной причине (`MissingAccountConfigError` / `ConnectTimeoutError` /
  `SessionRevokedError`), причина видна в `runs.error` и в отчёте Saved Messages без
  дополнительного разбора логов; подтверждённый отзыв сессии (`SessionRevokedError`)
  автоматически отключает все задачи агента.

### Modified Capabilities

- `task-scheduler`: добавляется примитив `disableAllTasks(agentId)` — массовое
  отключение всех задач агента, в дополнение к существующему поштучному `disableTask`.

## Impact

- Код: `src/core/telegram/errors.ts`, `src/core/telegram/service.ts`,
  `src/core/db/tasks.ts`, `src/scripts/dispatcher.ts`.
- Не затрагивается: `discovery/similar.ts` (использует базовый `instanceof
  ClientNotConnectedError`, продолжает работать без изменений, т.к. три новых класса —
  его наследники).
- Данные/миграции: нет — новая функция работает по существующей схеме `tasks`.
- Вне скоупа (Non-Goals — см. design.md): `FROZEN_METHOD_INVALID` и прочие
  RPC-ограничения аккаунта, не связанные с этапом `connect()`/`getMe()`; разброс
  heartbeat-таймеров агентов (`RandomizedDelaySec`/`AccuracySec`) — обсуждался отдельно
  как причина волны таймаутов 2026-07-17, но это тюнинг systemd-инфраструктуры, не
  классификация ошибок; увеличение `CONNECT_TIMEOUT_MS` 15s→60s — уже сделано и
  задеплоено отдельно, до этого change, как самостоятельный прямой фикс.
