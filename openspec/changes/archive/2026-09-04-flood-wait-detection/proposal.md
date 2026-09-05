## Why

`parseFloodWait()` (две копии: `src/skills/util.ts:11`, `src/core/telegram/service.ts:164`)
определяет FLOOD_WAIT по regex `/FLOOD_WAIT[_ ](\d+)/i` на `err.message`. GramJS этот
формат в `err.message` никогда не отдаёт — сырой код Telegram (`FLOOD_WAIT_66030`)
парсится и переписывается ещё внутри GramJS (`RPCMessageToError`,
`node_modules/telegram/errors/index.js:20-28`) в человекочитаемую фразу:

```js
// node_modules/telegram/errors/RPCErrorList.js:41-51
class FloodWaitError extends FloodError {
    constructor(args) {
        this.message = `A wait of ${seconds} seconds is required` + ...;
        this.seconds = seconds;   // готовое число — есть, просто не читается
    }
}
```

Итог: `parseFloodWait` возвращает `null` на любой реальный флуд-вейт, в любом месте
кода, всегда. Это не гипотеза — проверено по логам: 6 агентов, 5 дней, 48727 строк —
буквальная подстрока `"FLOOD_WAIT"` (то, что должно было бы залогироваться при
успешном распознавании) встречается **0 раз**; `"A wait of ... seconds is required"`
(то, что реально прилетает и не распознаётся) — **296 раз**.

Задетые последствия:

- **join-queue** (`joinDiscussionGroups`, `service.ts:885-989`) — 294 из 296 случаев.
  `ResolveUsername`/`GetFullChannel` не обёрнуты никакой flood-логикой вообще (только
  `JoinChannel` через `joinWithRetry`); флуд там падает в общий `catch`, не совпадает ни
  с одним `skipCode`, и помечается `status: "skipped"` — **навсегда**, без повторных
  попыток. Платформенно: `skipped=11271` против `joined=7922` — пропущенных больше, чем
  успешных вступлений. Конкретный пример — agent199, 2026-08-01: 9 ссылок в батче, все
  9 получили `"A wait of 66030 seconds is required (caused by contacts.ResolveUsername)"`
  и ушли в `skipped` одним и тем же дневным лимитом на аккаунт, который сам по себе
  пройдёт максимум через ~18 часов — но канал больше никогда не будет предпринята
  попытка.
- **monitor / monitor-v2** (`sendReply` → `withFloodRetry`, `skills/util.ts:37-54`) —
  замысел `withFloodRetry` («подождать X и повторить один раз») не работает: любой
  флуд/slow-mode при отправке ответа сразу считается финальной ошибкой, канал
  пропускается на весь прогон, `errorCode="reply_failed"` пишется в `send_errors` и
  всплывает в ежедневном отчёте воронки как «проблемный канал» — хотя по логам это была
  пауза в 15 секунд (`monitor-v2, 2026-07-31: "A wait of 15 seconds is required before
  sending another message in this chat"`).
- **dm-send** (`service.ts:743-818`) — там же нормативно уже описано ожидаемое
  поведение (`openspec/specs/dm-send/spec.md:22-25`, Scenario «FLOOD_WAIT handled»:
  подождать и повторить один раз, при повторном — `{error: 'flood_wait'}`) — то есть
  этот change не добавляет новое поведение dm-send, а чинит уже специфицированное и уже
  сломанное.
- Шесть методов `service.ts` (`resolveOwnChannel`, `resolveLinkedBroadcast`,
  `getChannelRecommendations`, `getChannelSubscribers`, `getChannelGateInfo`,
  `getRecentPosts`) при флуде либо тихо возвращают `null` (флуд читается как «у канала
  нет обсуждения/профиля» — неверный вывод), либо пробрасывают сырую ошибку без типа.

Чинить только `parseFloodWait` недостаточно даже для join-queue: `skills/join-queue.ts:42`
отдельно проверяет `reason.includes("FLOOD_WAIT")` на **сыром тексте GramJS**, который
не содержит эту подстроку независимо от того, работает ли `parseFloodWait` — это
самостоятельное третье место с тем же паттерном бага.

Есть и обратная сторона фикса: `joinWithRetry`/`withFloodRetry`/dm-send сегодня спят
`await sleep(waitSec * 1000)` **без верхней границы** — код этот путь ни разу не
исполнялся в проде (`parseFloodWait` всегда возвращал `null` раньше него), поэтому
риск не проявлялся. С работающим детектом первый же флуд вида «66030 секунд» (реально
наблюдался) заставит скилл уснуть на ~18 часов внутри одного прогона диспетчера —
который жёстко ограничен `TimeoutStartSec=3600` (`openspec/specs/task-scheduler/spec.md`,
«Время прогона ограничено 1 часом»). Прогон будет убит по таймауту, следующая
запланированная задача того же агента не выполнится этот тик вообще (диспетчер
последователен на агента). Фикс детекта без верхней границы ожидания — новый инцидент,
не решение старого.

## What Changes

- Единая, структурная детекция вместо двух regex-копий: `parseFloodWait(err: unknown)`
  переносится в `core/telegram/errors.ts` (единственное место — «один факт, один дом»),
  проверяет `err instanceof errors.FloodWaitError || err instanceof
  errors.SlowModeWaitError` (namespace `errors` пакета `telegram`, GramJS), читает
  `.seconds`. `src/skills/util.ts` и `src/core/telegram/service.ts` импортируют её
  оттуда, локальные копии удаляются.
- Разовый бэкфилл после деплоя: `status='skipped' → status='pending', attempts=0` по
  всем агентам, размазанный по времени (не одним запросом сразу по всем 140+ агентам —
  см. design.md Decisions). Ссылки проходят через уже починенную классификацию на своих
  штатных плановых прогонах join-queue; результат — `joined` (флуд-ложь исправлена),
  `skipped` (подтверждённая постоянная причина, на этот раз верно) или `error`
  (застряло на флуде дольше `MAX_ATTEMPTS` — редкий случай, виден в БД, не путается со
  `skipped`). `lastError` для этих строк не восстанавливается (исходная причина не была
  сохранена) — бэкфилл даёт ссылке новую попытку, не объясняет задним числом старую.
- Новая константа верхней границы инлайн-ожидания (рабочее имя
  `MAX_INLINE_FLOOD_WAIT_SECONDS`, предлагается 120с — см. design.md Open Questions)
  — общая политика для всех мест, где сегодня безусловный `sleep(waitSec * 1000)`:
  `joinWithRetry` (join-queue), `withFloodRetry` (monitor/monitor-v2), инлайн-ретрай
  dm-send. Ниже порога — прежнее поведение (подождать инлайн, повторить один раз). На
  пороге и выше — не спать, считать «не в этот прогон», через существующие механизмы
  повтора на следующий плановый тик (для join-queue — статус `error`, для
  monitor/dm-send — канал/кандидат пропускается в рамках этого прогона, как и сегодня
  при не-flood ошибке).
- `joinDiscussionGroups` (`service.ts:885-989`) — `ResolveUsername`/`GetFullChannel`
  получают ту же flood-детекцию и ту же политику порога, что уже есть у `JoinChannel`
  (сейчас обёрнут только он). Флуд на любом из трёх шагов пишется в уже существующий
  `floodWaits: Array<{link, waitSeconds}>` (`JoinSummary.floodWaits`,
  `service.ts:66,893,1001` — сейчас туда попадает только `JoinChannel`).
- `skills/join-queue.ts:41-47` — вместо `reason.includes("FLOOD_WAIT")` на свободном
  тексте проверяется структурный признак: ссылка присутствует в
  `summary.floodWaits`. Правильная маршрутизация (`status: "error"`, ретрай на
  следующем плановом батче) перестаёт зависеть от содержимого текста ошибки.

## Capabilities

### New Capabilities

- `flood-wait-detection`: платформа SHALL распознавать флуд-ограничения Telegram
  (`FLOOD_WAIT`, slow-mode) по структурному типу исключения GramJS, а не по тексту
  сообщения; ожидание внутри прогона SHALL быть ограничено сверху, чтобы не превышать
  таймаут прогона диспетчера.

### Modified Capabilities

- `group-monitoring`: добавляется нормативное поведение (сегодня не специфицировано
  вовсе) — флуд/slow-mode при отправке ответа в канал ретраится один раз в пределах
  порога ожидания и не считается «ошибкой отправки» канала, если ретрай успешен.

## Impact

- Код: `src/core/telegram/errors.ts` (новое: `parseFloodWait`,
  `MAX_INLINE_FLOOD_WAIT_SECONDS`), `src/core/telegram/service.ts` (удаление локальной
  копии `parseFloodWait`, импорт из `errors.ts`, расширение `joinDiscussionGroups`,
  применение порога в `joinWithRetry` и в инлайн-ретрае `sendDm`), `src/skills/util.ts`
  (удаление локальной копии, импорт из `core/telegram/errors.ts`, применение порога в
  `withFloodRetry`), `src/skills/join-queue.ts` (маршрутизация по `floodWaits` вместо
  текста).
- dm-send: контракт (`openspec/specs/dm-send/spec.md`) не меняется текстом — уже
  описанное поведение начинает реально работать, спек-дельта не нужна.
- Данные: одноразовый бэкфилл (`UPDATE join_queue SET status='pending', attempts=0
  WHERE status='skipped'`) по `tg-join-queue.db` каждого агента — не схемная миграция,
  разовое переклассифицирование существующих строк через уже исправленный код. Часть
  из 11271 строк осядет обратно в `skipped` (правильно, окончательно), часть станет
  `joined`, часть может застрять в `error` — см. design.md Migration Plan.
- Не затрагивается: `resolveOwnChannel`, `resolveLinkedBroadcast`,
  `getChannelRecommendations`, `getChannelSubscribers`, `getChannelGateInfo`,
  `getRecentPosts` и их вызывающие (`channel-analysis/run.ts`, `discovery/similar.ts`,
  `scripts/channel-metrics.ts`, `scripts/channel-coverage-update.ts`) автоматически
  получают рабочую детекцию через общий `parseFloodWait`, но остаются без верхней
  границы ожидания — это одноразовые admin-скрипты (`tsx src/scripts/...`), не
  запускаются через `dispatcher.ts`/systemd-таймер и не подпадают под
  `TimeoutStartSec=3600`, поэтому порог для них не в скоупе (см. design.md Non-Goals).
