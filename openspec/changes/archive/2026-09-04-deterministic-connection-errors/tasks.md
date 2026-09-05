## 1. Классы ошибок: `src/core/telegram/errors.ts`

- [x] 1.1 `ClientNotConnectedError` — сделать конструктор защищённым по смыслу (JSDoc:
      «абстрактный маркер, не бросать напрямую»), принимает `cause?: unknown`, передаёт
      его в `super(message, { cause })`
- [x] 1.2 `MissingAccountConfigError extends ClientNotConnectedError` — конструктор
      принимает имя отсутствующего поля (`"apiId" | "apiHash" | "sessionString"`),
      формирует сообщение вида `` `tg-account.json: отсутствует ${field}` ``
- [x] 1.3 `ConnectTimeoutError extends ClientNotConnectedError` — конструктор принимает
      таймаут в мс, номер последней попытки, `MAX_ATTEMPTS`, опционально прокси-адрес;
      сообщение включает все параметры (по образцу текущего
      `` `connect timed out after ${N}s` ``, дополненного попыткой и прокси)
- [x] 1.4 `SessionRevokedError extends ClientNotConnectedError` — конструктор принимает
      `code: number` и `errorMessage: string` (сырые поля RPC-ошибки GramJS), формирует
      сообщение вида `` `${code}: ${errorMessage}` ``
- [x] 1.5 Каждый подкласс выставляет собственный `this.name` (по образцу существующих
      `FloodWaitError`/`ClientNotConnectedError`)

## 2. Классификация в `ensureClient()`: `src/core/telegram/service.ts`

- [x] 2.1 Ветка «нет apiId/apiHash» — `throw new MissingAccountConfigError("apiId")`
      (или `"apiHash"`, в зависимости от того, какое поле пусто), сохранить
      существующий `log.error` перед throw
- [x] 2.2 Ветка «нет sessionString» — `throw new MissingAccountConfigError("sessionString")`
- [x] 2.3 В цикле попыток — после исчерпания `MAX_ATTEMPTS`, определить `err.code === 401`
      (GramJS RPC-ошибка) → `throw new SessionRevokedError(err.code, err.errorMessage)`;
      иначе (таймаут или другая ошибка) → `throw new ConnectTimeoutError(CONNECT_TIMEOUT_MS,
      attempt, MAX_ATTEMPTS, account.proxy)`, передать исходный `err` как `cause`
- [x] 2.4 Изменить сигнатуру `ensureClient()` на `Promise<TelegramClient>` (убрать `| null`
      из типа, убрать финальный `return null;`)
- [x] 2.5 `requireClient()` — убрать `if (!client) throw ...`, оставить прямой возврат
      результата `ensureClient()`

## 3. Примитив в БД: `src/core/db/tasks.ts`

- [x] 3.1 `disableAllTasks(agentId: string): void` — `UPDATE tasks SET enabled = 0 WHERE
      agentId = @agentId` (без фильтра по `type`, по образцу `disableTask`)
- [x] 3.2 JSDoc: когда используется (подтверждённый отзыв сессии — все задачи агента
      останавливаются разом, не по одной по мере срабатывания расписания)

## 4. Диспетчер: `src/scripts/dispatcher.ts`

- [x] 4.1 Импортировать `SessionRevokedError` (и, если нужно для типизации, остальные два
      класса) из `../core/telegram/errors`
- [x] 4.2 В `catch` вокруг вызова скилла — добавить ветку `if (err instanceof
      SessionRevokedError) { disableAllTasks(agentId); log.error(...) }` до/вместо общей
      ветки `instanceof ClientNotConnectedError`; общая ветка (`clientDisconnected = true;
      break`) продолжает срабатывать для всех трёх подклассов
- [x] 4.3 Убедиться, что `formatError(err)` (уже используется в `status.details.error`)
      отражает конкретное сообщение — новых изменений в `formatError`/`core/errors.ts` не
      требуется
- [x] 4.4 Обновить лог-строку `` `${type}: client not connected, stopping agent run` `` —
      заменить статичный текст на `formatError(err)`, чтобы конкретная причина была видна
      прямо в этой строке, не только в `runs.error`

## 5. Деплой и проверка

- [x] 5.1 Локальная типопроверка (`tsc --noEmit` или эквивалент проекта) — новые классы,
      изменённая сигнатура `ensureClient`/`requireClient`. Прямой `tsc --noEmit` по
      `tsconfig.json` не проходит (`TS5095: 'bundler' requires module 'preserve'/'es2015'+`
      — несовместимость `moduleResolution`/`module` в самом `tsconfig.json`,
      предсуществующая, не связана с этим change: `tsconfig.json` уже модифицирован
      на этой ветке до начала работы над deterministic-connection-errors). Проверено
      point-in-time инвокацией `tsc` с явными флагами (`--moduleResolution bundler
      --module esnext --target es2016 --strict --skipLibCheck`) по четырём изменённым
      файлам + `discovery/similar.ts` — единственная ошибка, которую вызвала правка
      (`errors.ts` TS2554: `Error` с 2 аргументами не типизирован под `target es2016`),
      исправлена (см. 1.1: `cause` — собственное поле класса, не второй аргумент
      `super()`). Оставшиеся ошибки (`better-sqlite3` module resolution во всех
      `core/db/*.ts`, `bigint`/`BigInteger` в нетронутых местах `service.ts`) —
      предсуществующие, вне этого change
- [x] 5.2 Скопировать на VPS: `src/core/telegram/errors.ts`, `src/core/telegram/service.ts`,
      `src/core/db/tasks.ts`, `src/scripts/dispatcher.ts`; перезапустить gateway
      (5.3/5.4 из первоначального плана — ручные проверки таймаута и отзыва сессии на
      живом агенте — сняты решением пользователя, не выполняются в рамках этого change).
      Задеплоено `scp` на все 4 файла, `openclaw gateway restart` выполнен. Проверено:
      процесс `openclaw-gateway` поднят (PID новый, слушает `127.0.0.1:18789`/`[::1]:18789`).
      Побочно подтверждено ранее известное расхождение (см. `report-agent-isolation`
      tasks.md §4a.5): systemd-юнит `openclaw.service` `disabled`/не отслеживает этот
      процесс — `openclaw gateway restart` управляет им напрямую, не через systemd; не
      связано с этим change
- [x] 5.5 Проверить, что `discovery/similar.ts` (4 места `instanceof ClientNotConnectedError`)
      продолжает прерывать обход при любой из трёх причин — без изменений в самом файле.
      Типопроверка файла отдельно — новых ошибок нет; `instanceof` против абстрактного
      предка компилируется и матчит все три подкласса без правок в файле
