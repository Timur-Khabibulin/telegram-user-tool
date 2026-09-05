## 1. Общая детекция: `src/core/telegram/errors.ts`

- [x] 1.1 Импортировать `errors as gramjsErrors` из пакета `telegram` (по образцу
      `import { TelegramClient, Api } from "telegram"` в `service.ts:10` — тот же
      пакет, другой named export)
- [x] 1.2 `parseFloodWait(err: unknown): number | null` — `err instanceof
      gramjsErrors.FloodWaitError || err instanceof gramjsErrors.SlowModeWaitError` →
      вернуть `err.seconds`; иначе `null`. JSDoc: явно указать, что оба класса
      структурно объявляют `.seconds` (`node_modules/telegram/errors/RPCErrorList.d.ts`),
      а базовый `FloodError` — нет, поэтому проверяются два конкретных подкласса, не
      общий предок
- [x] 1.3 `export const MAX_INLINE_FLOOD_WAIT_SECONDS = 120` (подтверждено
      пользователем) — JSDoc: где используется (join-queue/monitor/dm-send через
      `dispatcher.ts`), почему не применяется к шести admin-скриптовым методам (см.
      design.md Non-Goals)

## 2. Убрать дубли, переключить на общую функцию

- [x] 2.1 `src/core/telegram/service.ts:163-167` — удалить локальный `parseFloodWait`,
      импортировать из `./errors`
- [x] 2.2 Проверить оба существующих вызова в `service.ts` (`sendDm` инлайн-ретрай,
      `joinWithRetry`) — сигнатура меняется с `parseFloodWait(msg: string)` на
      `parseFloodWait(err: unknown)`, вызовы вида `parseFloodWait(err.message ?? "")`
      переписать на `parseFloodWait(err)` (передавать сам объект ошибки, не `.message`)
- [x] 2.3 То же для шести методов (`resolveOwnChannel`, `resolveLinkedBroadcast`,
      `getChannelRecommendations`, `getChannelSubscribers`, `getChannelGateInfo`,
      `getRecentPosts`) — заменить `parseFloodWait(err?.message ?? "")` на
      `parseFloodWait(err)`
- [x] 2.4 `src/skills/util.ts:10-14` — удалить локальный `parseFloodWait`,
      импортировать из `../core/telegram/errors`
- [x] 2.5 `withFloodRetry` (`skills/util.ts:37-54`) — оба вызова
      (`parseFloodWait(err?.message ?? String(err))`,
      `parseFloodWait(retryErr?.message ?? String(retryErr))`) переписать на
      `parseFloodWait(err)`/`parseFloodWait(retryErr)`

## 3. Верхняя граница ожидания

- [x] 3.1 `withFloodRetry` (`skills/util.ts:37-54`) — перед `await sleep(waitSec *
      1000)` добавить проверку `waitSec >= MAX_INLINE_FLOOD_WAIT_SECONDS`: если да, не
      спать, вести себя как при `waitSec === null` сегодня (`throw err` — вызывающий,
      `sendReply` в `monitor.ts`/`monitor-v2.ts`, пропускает канал на этот прогон)
- [x] 3.2 `sendDm` инлайн-ретрай (`service.ts:798-815`) — та же проверка перед `await
      sleep(waitSec * 1000)`: если `waitSec >= MAX_INLINE_FLOOD_WAIT_SECONDS`, сразу
      `throw err` (существующая ветка ниже, `service.ts:817`), не пытаться отправить
- [x] 3.3 `joinWithRetry` (`service.ts:944-958`, внутри `joinDiscussionGroups`) — та же
      проверка: `waitSec >= MAX_INLINE_FLOOD_WAIT_SECONDS` → не спать и не повторять,
      сразу считать шаг проваленным (пробрасывать дальше, как сегодня при исчерпанном
      повторе). Реализовано как часть общего хелпера `callWithFloodHandling` (см. 4.5)

## 4. `joinDiscussionGroups` — детекция флуда на `ResolveUsername`/`GetFullChannel`

- [x] 4.1 Обернуть вызов `contacts.ResolveUsername` (`service.ts:909`) той же логикой,
      что уже есть у `JoinChannel` в `joinWithRetry`: поймать ошибку, `parseFloodWait`,
      ниже порога — `sleep` и один повтор, выше/не флуд — пробросить дальше как раньше
- [x] 4.2 То же для `channels.GetFullChannel` (`service.ts:919`)
- [x] 4.3 При флуде на любом из двух шагов — `floodWaits.push({ link, waitSeconds })`
      (тот же массив, что уже заполняет `joinWithRetry` на строке 950), до записи
      результата в `results`
- [x] 4.4 Не менять форму `results.push({ link, status: "skipped", ... })` для этих
      случаев — `status` остаётся `"skipped"` (внешний контракт `JoinResult` не
      расширяется, см. design.md Decisions), сигнал для маршрутизации — присутствие
      ссылки в `floodWaits`, не сам `status`
- [x] 4.5 Вынесено в общий хелпер `callWithFloodHandling(link, fn)` внутри
      `joinDiscussionGroups` — используется всеми тремя шагами (`ResolveUsername`,
      `GetFullChannel`, `JoinChannel`), `joinWithRetry` как отдельная функция удалена

## 5. `skills/join-queue.ts` — маршрутизация по структурному признаку

- [x] 5.1 `runJoinQueue` (`join-queue.ts:36-48`) — заменить `if
      (reason.includes("FLOOD_WAIT"))` на `if (summary.floodWaits.some((fw) => fw.link
      === result.link))`
- [x] 5.2 Убедиться, что `updateJoinQueue(agentId, result.link, "error", reason, log)`
      по-прежнему получает осмысленный `reason` для `lastError` (сейчас `result.reason`
      для флуд-случаев после п.4 будет содержать сырой текст GramJS «A wait of N
      seconds...» — это ОК и даже полезнее для диагностики, чем raw text без
      классификации)

## 6. `monitor.ts` / `monitor-v2.ts` — не путать «отложено по флуду» с «канал
   проблемный»

- [x] 6.1 Решено с пользователем: да, нужен отдельный `errorCode`
- [x] 6.2 `errorCode: "flood_deferred"` заведён в `sendReply`-обвязке
      `monitor.ts`/`monitor-v2.ts` (`recordSendError`), отдельно от `reply_failed` —
      различение по `parseFloodWait(err) !== null`. `problemChannels`/
      `errorBreakdown` (`core/db/channels.ts`) группируют по `errorCode` уже сегодня
      (generic `GROUP BY errorCode`) — новый код автоматически попадает отдельной
      строкой, без правок в отчётном коде

## 7. Спеки

- [x] 7.1 `openspec/changes/flood-wait-detection/specs/flood-wait-detection/spec.md` —
      сверено с реализацией, изменений не потребовалось (описан на уровне поведения,
      не конкретных значений)
- [x] 7.2 `openspec/changes/flood-wait-detection/specs/group-monitoring/spec.md` —
      добавлен Scenario про отдельный `errorCode`, не искажающий отчёт воронки

## 8. Проверка и деплой фикса

- [x] 8.1 Типопроверка изменённых файлов (точечно, флагами `--moduleResolution
      bundler --module esnext --target es2016 --strict --skipLibCheck` — см.
      прецедент `deterministic-connection-errors` tasks.md §5.1). Единственные
      ошибки — предсуществующие (`better-sqlite3` module resolution, `bigint`/
      `BigInteger` в нетронутых местах `service.ts`), не связаны с изменениями этого
      change; вручную прослежена логика `joinDiscussionGroups`/`sendDm`/
      `withFloodRetry`/`join-queue.ts` на реальном кейсе agent199 (FloodWaitError
      66030s на `ResolveUsername`) — трассировка подтверждает: `floodWaits.push` →
      `status:"error"` в очереди, `lastError` заполнен вместо пустого
- [x] 8.2 Деплой на VPS выполнен: 8 файлов (`core/telegram/errors.ts`, `service.ts`,
      `skills/util.ts`, `skills/join-queue.ts`, `skills/monitor.ts`,
      `skills/monitor-v2.ts`, `core/db/join-queue.ts`,
      `scripts/join-queue-backfill.ts`) собраны на базе актуальной версии,
      развёрнутой на VPS (не текущего локального рабочего дерева — оно на момент
      деплоя содержало 179 незакоммиченных файлов несвязанного продолжающегося
      рефакторинга; каждый из 8 файлов сверен побайтово, чтобы исключить только
      флуд-фикс без постороннего дрейфа, см. design.md). `chown -R root:root` и
      `openclaw gateway restart` выполнены, новый процесс `openclaw-gateway`
      подтверждён (слушает `127.0.0.1:18789`). Все 8 файлов сверены на VPS побайтово
      после деплоя — совпадают с собранными версиями

## 9. Бэкфилл существующих `skipped` (только после §8.2)

- [x] 9.1 Разовый скрипт `src/scripts/join-queue-backfill.ts` написан (по образцу
      `discovery-backfill.ts`/`channel-metrics.ts`): вызывает новую
      `resetSkippedToPending(agentId, log)` в `core/db/join-queue.ts` для каждого
      агента. **Не запущен** — по дизайну запускается только после деплоя §1-6 на VPS
      (см. design.md Migration Plan); в этой сессии деплоя не было
- [x] 9.2 Разбивка по пакетам реализована как CLI-параметры (`--batch-size`, default
      10; `--delay-seconds`, default 300) — не зашитое число, оператор выбирает при
      запуске (закрывает design.md Open Question про график)
- [x] 9.3 Лог до/после на агента реализован (`joinQueueStats` до, `reset` после,
      строка в лог на каждого агента + итог по всем батчам)
