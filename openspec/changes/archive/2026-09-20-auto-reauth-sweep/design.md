## Context

Ограничение `need_update_session` ставится при сломанной сессии агента (класс ошибок
`AUTH_KEY_UNREGISTERED`/`SESSION_REVOKED`/`AUTH_KEY_DUPLICATED`/… — см. спеку
`agent-restrictions`). Снять его можно, выпустив новую MTProto-сессию; для этого уже
есть чистая функция `reauthFromTdata(agentId, password2fa, log): ReauthFromTdataOutcome`
(`src/features/tg-agent-reauth-from-tdata/run.ts`), которая коннектится по tdata из
`workspace-<agentId>/tdata/`, регистрирует новую сессию, пишет `sessionString` и при
успехе сама снимает ограничение (`clearRestriction`). Сейчас её дёргает только оператор
(скилл `tg-agent-reauth-from-tdata`). tdata у агентов автpрегистрации лежит в workspace
(`promoteToWorkspace` делает `renameSync(staging → workspace-<agentId>)`, а `tdata/` уже
в staging из скачивания), поэтому автоматизация реальна для основной массы флота.

Ограничения читаются из общей `agent_restrictions` (одна строка на agentId). Сейчас есть
`getActiveRestriction` (per-agent) и `listRestrictionsSince` (для funnel-report), но нет
запроса «все активные с заданным типом» — свипу он нужен.

## Goals / Non-Goals

**Goals:**
- Ежесуточно автоматически реавторизовать агентов с `need_update_session` через tdata.
- Невосстановимые авто-ретраем случаи (`tdata_missing`, `password_rejected`) отделить в
  отдельную ручную очередь (`manual_reauth`), которую свип не трогает.
- Выявленный при реавторизации бан переводить в `banned`.
- Не ломать достоверность суточного funnel-report (метка `restricted_at`).

**Non-Goals:**
- Не менять `reauthFromTdata` — переиспользуем как есть.
- Не автоматизировать доставку/подкладывание tdata и ввод верного 2FA — это остаётся
  ручным (выход из `manual_reauth` через существующий скилл).
- Не вводить счётчик попыток/бэкофф (ограничение v1 — бесконечный ретрай транзиентных).
- Не добавлять наблюдаемость сверх journal-логов (ни Saved Messages, ни журнал операций
  каналов, ни новые таблицы).

## Decisions

### D1 — Платформенный systemd-таймер, а не per-agent задача диспетчера
Свип — кросс-агентная операция над общей `agent_restrictions`, поэтому это отдельная
oneshot-задача на своём таймере (по образцу `periodic/channel-rotation.ts` +
`deploy/systemd/tg-channel-rotation.service/.timer`), а не запись в таблице `tasks`.
Как systemd-oneshot она по природе не ограничена per-tool-call watchdog'ом — ожидание
кода в `reauthFromTdata` спокойно живёт.
_Альтернатива:_ per-agent задача диспетчера — отклонено: ограниченный агент диспетчером
не запускается вовсе (в этом суть ограничения), значит его собственная задача не
стартует; свип обязан быть внешним по отношению к per-agent циклу.

### D2 — Переиспользовать reauthFromTdata как есть, свип только оркестрирует
Свип: `listActiveByType('need_update_session')` → последовательный цикл →
`reauthFromTdata(agentId, undefined, log)` (2FA по умолчанию из шаблона персоны) →
маппинг исхода. Никаких изменений в самой реавторизации. Последовательно и с изоляцией
ошибок — как per-account цикл автpрега.

### D3 — Новый тип `manual_reauth` для терминальных «нужна ручная»
`tdata_missing`/`password_rejected` авто-ретраем не чинятся. Оставить их как
`need_update_session` — значит свип будет брать их каждый день впустую (лишние
подключения, а для `code_timeout`-подобных — отправка кода на аккаунт). Вводим отдельный
тип `manual_reauth`: свип выбирает только `need_update_session`, поэтому в `manual_reauth`
агенты в выборку не попадают. Диспетчер уже трактует любую активную строку как стоп —
спека требует явно добавить `manual_reauth` в «всегда-активные», доработки кода
диспетчера не требуется (он не различает типы, кроме TTL у `suspend`).
_Альтернатива:_ флаг в `reason` — отклонено: «состояние в reason» грязно и легко
проглядеть.

### D4 — Транзиентные исходы не пишут в БД
`connect_failed`/`code_timeout`/небановая `error`/`agent_not_found` строку не трогают.
`upsertRestriction` всегда переставляет `restricted_at = now`; funnel-report по
`restricted_at` считает «кому наложено за сутки». Если писать на каждом транзиентном
ретрае — агент будет ежедневно всплывать как заново ограниченный. Поэтому терминальные
переходы (`manual_reauth`/`banned`) пишем, транзиентные — нет; агент остаётся
`need_update_session` и берётся следующим прогоном естественно.

### D5 — `error` через classifyAccountError, а не «любой error = бан»
`error` может быть транзиентным сбоем. Прогоняем текст через существующий
`classifyAccountError`: только бан-сигнатура → `banned`; иначе — транзиент (D4).
Важно: исход `error` из `reauthFromTdata` — это строка (`outcome.error`), а
`classifyAccountError` читает `.errorMessage`/`.message`; поэтому строку надо обернуть
(`classifyAccountError({ message: outcome.error })`) — на голой строке всегда null.
Следствие/ограничение: детект бана здесь по тексту сообщения (`ACCOUNT_BANNED_MESSAGES`),
без ветки `code === 401` — исходный Error с кодом до свипа не долетает (не меняем
`reauthFromTdata`, non-goal). Для банов это достаточно: бан-сигнатуры — текстовые.

### D6 — Новый тип должен знать не только диспетчер и funnel-report, но и funnel-collect
`funnel-collect` пропускает MTProto-этапы охвата для агентов с `need_update_session`/
`banned` (сессия сломана — подключение заведомо неуспешно). `manual_reauth` — тоже
сломанная сессия, поэтому его надо добавить в тот же список пропуска, иначе сбор охвата
будет впустую коннектиться и ловить таймаут. `suspend` в пропуск не входит (сессия
рабочая) — `manual_reauth` в этом смысле как `need_update_session`, не как `suspend`.

## Risks / Trade-offs

- **Бесконечный ретрай транзиентных (v1)** → приемлемо; риск в основном у `code_timeout`
  (ежесуточная отправка кода на аккаунт). Митигация вне v1: счётчик попыток → `manual_reauth`.
- **Старые агенты без tdata в workspace** → сразу уходят в `manual_reauth` (ожидаемо, это
  и есть сигнал «нужна ручная»), автоматизацию не ломает.
- **Дефолтный 2FA не у всех агентов актуален** → `password_rejected` → `manual_reauth`,
  оператор доводит вручную. Не пытаемся угадывать пароль.
- **Гонки с диспетчером нет** → агент под `need_update_session` диспетчером не
  запускается, пока свип его реавторизует.

## Migration Plan

1. `agent-restrictions.ts`: тип `manual_reauth` + запрос `listActiveByType`.
2. `features/agent-reauth-sweep/run.ts` (свип-логика) + `periodic/reauth-sweep.ts` (запускатор).
3. `deploy/systemd/tg-reauth-sweep.service/.timer`; включить таймер на ВПС, offset от
   `leave-banned`/`channel-rotation` (отправки кода не в пик).
4. `funnel-report.ts` — значок `manual_reauth`.
5. Doки (`task-scheduling.md`/`operation.md`).

Откат: отключить таймер (`systemctl disable --now tg-reauth-sweep.timer`) — платформа
возвращается к ручной реавторизации; тип `manual_reauth` в БД безвреден (диспетчер и так
трактует как стоп).

## Open Questions

- Нет: карта исходов, представление ручной очереди и наблюдаемость зафиксированы
  решениями D1–D5.
