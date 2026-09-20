# Tasks — auto-reauth-sweep

## 1. agent-restrictions: новый тип + запрос

- [x] 1.1 `src/core/db/agent-restrictions.ts`: добавить `manual_reauth` в
      `RestrictionType`.
- [x] 1.2 `src/core/db/agent-restrictions.ts`: новый запрос
      `listActiveByType(adminAgentId, type): AgentRestrictionRow[]` — активные строки
      заданного типа (для `suspend` учитывать истечение TTL, как в
      `getActiveRestriction`; для остальных типов TTL нет).

## 2. Свип-логика

- [x] 2.1 `src/features/agent-reauth-sweep/run.ts`: `runReauthSweep(log, adminAgentId)`
      — `listActiveByType(adminAgentId, 'need_update_session')`, последовательный цикл с
      изоляцией ошибок, по каждому агенту `reauthFromTdata(agentId, undefined, log)`.
- [x] 2.2 Маппинг исходов: `done` → ничего (снятие делает `reauthFromTdata`);
      `tdata_missing` → `upsertRestriction(..., 'manual_reauth', reason, null)`;
      `password_rejected` → `upsertRestriction(..., 'manual_reauth', 'дефолтный 2FA-пароль не подошёл', null)`;
      `error` → `classifyAccountError({ message: outcome.error })` (ОБЯЗАТЕЛЬНО обернуть
      строку в объект с `.message` — на голой строке classifyAccountError всегда вернёт
      null): бан → `upsertRestriction(..., 'banned', errText, null)`, иначе строку не
      трогать; `connect_failed`/`code_timeout`/`agent_not_found` → строку не трогать.
      Все ветки логировать.
- [x] 2.3 Вернуть сводку прогона (счётчики по исходам) для строки итога в лог.

## 3. Запускатор + systemd

- [x] 3.1 `src/scripts/periodic/reauth-sweep.ts`: тонкий oneshot-запускатор по образцу
      `periodic/channel-rotation.ts` (`--admin` опц., `runReauthSweep`, `process.exit`).
- [x] 3.2 `deploy/systemd/tg-reauth-sweep.service` + `tg-reauth-sweep.timer` — суточный
      запуск, offset от `leave-banned`/`channel-rotation` (отправки кода не в пик).

## 4. Отчёт-воронка

- [x] 4.1 `src/features/funnel/funnel-report.ts`: значок статуса для `manual_reauth`
      (иначе тип отобразится без значка).
- [x] 4.2 `src/features/funnel/funnel-collect.ts` (~стр. 365): добавить `manual_reauth`
      в условие пропуска MTProto-этапов 5-7 (наравне с `need_update_session`/`banned`) —
      сессия агента сломана, подключение гарантированно неуспешно; иначе funnel-collect
      будет впустую коннектиться и ловить таймаут.

## 5. Доки

- [x] 5.1 `docs/task-scheduling.md` / `docs/operation.md`: упомянуть новый суточный
      таймер `tg-reauth-sweep` (платформенная задача вне таблицы `tasks`, как
      `channel-rotation`/`daily-summary`).

## 6. Проверка

- [x] 6.1 Typecheck изменённых/новых файлов — без новых ошибок (0 новых; по проекту 45
      предсуществующих — better-sqlite3 типы и пр., baseline не изменился).
- [x] 6.2 Свип на реальных данных (прогон 2026-09-17, `systemctl start`): выборка 22
      `need_update_session`; итог `done=0 manual_reauth=5 banned=0 transient=17 not_found=0`;
      прогон пережил сбои всех агентов и завершился `Result=success` (process.exit(0), не
      завис); всё видно в `journalctl -u tg-reauth-sweep`. Ветки `tdata_missing→manual_reauth`,
      `connect_failed→транзиент`, `error(не бан)→транзиент` подтверждены. Ветки `done`/`banned`
      не сработали — среди 22 агентов не оказалось ни одного с рабочим прокси+tdata (все с
      мёртвым прокси/без tdata); их код идентичен ручному скиллу `tg-agent-reauth-from-tdata`.
- [x] 6.3 5 переводов в `manual_reauth` записались в `agent-restrictions.db` (reason
      «нет tdata: …»); после прогона `need_update_session=17` — эти 5 из выборки следующего
      свипа исключены; диспетчер трактует `manual_reauth` как ограничение (агент не
      запускается).
