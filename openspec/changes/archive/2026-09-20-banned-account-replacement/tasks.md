# Tasks — banned-account-replacement

## 1. Пул и сужение перечня агентов

- [x] 1.1 `src/core/config.ts`: сузить `listAgentIds` до префикса `workspace-agent*`
      (исключить `workspace-emptyAccount*`, не задев ни одного рабочего агента);
      обновить inline-док «источник истины об агентах».
- [x] 1.2 `src/core/config.ts`: добавить `listPoolAccountIds()` — каталоги
      `workspace-emptyAccount*` (используется только sweep’ом).

## 2. Таблица отложенных переходов

- [x] 2.1 `src/core/db/lifecycle-transitions.ts` (новый): схема
      `lifecycle_transitions(id, agent_id, action, run_at, done)` в admin-workspace
      (по приёму `agent-restrictions.ts`); ленивое создание схемы.
- [x] 2.2 API: посев строк перехода (`seedTransitions(admin, agentId, [{action, runAt}])`),
      выборка назревших (`listDueTransitions(admin, now)`), пометка исполненной
      (`markDone(admin, id)`). Действия: `start_join_queue` | `enable_monitor_v5` |
      `disable_warmup`.

## 3. Read-функция реестра владения

- [x] 3.1 `src/core/db/discovery.ts`: `listAgentAssignmentLinks(admin, agentId)` —
      `canonical_link` из `channel_assignments` по `agent_id=<agentId>` (для
      наполнения join-queue на T0).

## 4. Подмена аккаунта (swap)

- [x] 4.1 `src/features/banned-account-replacement/swap.ts` (новый): claim свободного
      пул-аккаунта — атомарный `renameSync(workspace-emptyAccount<X>,
      workspace-<agentId>.incoming)`; при `ENOENT` — следующий свободный.
- [x] 4.2 Валидация выбранного аккаунта до потребления: подключение его сессией через
      его прокси + `getMe()`, классификация исхода `classifyAccountError`;
      невалидный/ограниченный — перенести в карантин `workspace-emptyAccount<N>.invalid`
      (M2), взять следующий свободный. `listPoolAccountIds` (1.2) должен исключать суффикс
      `.invalid`.
- [x] 4.3 Сборка содержимого `.incoming`: переписать `tg-account.json`
      (creds/username/proxy/device из пула, `persona` — от заменяемого агента,
      `accountId=agentId`); перенести `tasks.db` из старого workspace и перезаписать в
      ней только таблицу `tasks`; прочие рабочие БД пустыми; фазовый маркер
      `replacement.json = activating`.
- [x] 4.4 Атомарный swap: `rename(workspace-<agentId>, .old)` →
      `rename(.incoming, workspace-<agentId>)` → удалить `.old`.
- [x] 4.5 Восстановление на старте прогона: подмести якоря — до-swap `.incoming`
      доделать; осиротевший `.old` удалить (идемпотентно по фазовому маркеру).

## 5. Активация под персону (полная настройка, кроме смены 2FA — M3)

- [x] 5.1 `src/core/tdata/account-setup.ts`: новый экспорт
      `setupReplacementAccount(client, template, username, log)` — тело `prepareAccount`
      **без шагов `change2FA` и `resetOtherSessions`** (и без параметра `currentPassword`);
      переиспользует приватные хелперы: `deleteExistingPhotos`, `deleteAdminedPublicChannels`,
      `applyProfile`, `uploadProfilePhotos`, `createPersonaChannel` (guard «канал уже есть»
      через `getOwnPersonalChannel`). `prepareAccount` не менять.
- [x] 5.2 Шаг активации: `setupReplacementAccount` (5.1) → приватная инвайт-ссылка
      `upsertPrivateInviteLink` (`post_updated=0` = на перепубликацию). Идемпотентно.
      Username нового аккаунта — из `tg-account.json` пула (M4).

## 6. Оркестратор sweep

- [x] 6.1 `src/features/banned-account-replacement/run.ts` (новый):
      `runBannedReplacementSweep(log, adminAgentId)`. Фаза 1 — исполнить назревшие
      переходы (`listDueTransitions` → применить через `scheduler-control`
      enable/disable → `markDone`), с изоляцией сбоев.
- [x] 6.2 Фаза 2 — `listActiveByType(admin, "banned")`, последовательный цикл с
      per-agent изоляцией: восстановление незавершённой замены (4.5/маркер) → иначе
      выбор+валидация+claim пул-аккаунта (4.1–4.2) → сборка+swap (4.3–4.4) → активация
      (5.2) → при успехе: наполнить join-queue из `listAgentAssignmentLinks`
      (`addJoinQueue`), включить `account-warmup`, отложить старт join-queue, посеять
      строки переходов (2.2), снять маркер, снять `banned` (`clearRestriction`) —
      commit point.
- [x] 6.3 Алерт «пул пуст»: если есть кандидаты и нет пригодных пул-аккаунтов —
      оповестить оператора один раз в Saved Messages `REPORT_AGENT_ID` (M5). Дедуп —
      durable-флаг файлом `~/.openclaw/banned-replacement/pool-empty-alerted` (M6), сброс
      при появлении пригодного пул-аккаунта.
- [x] 6.4 Вернуть сводку прогона (счётчики: заменено, отложено, переходов исполнено,
      алерт) для строки итога в лог.

## 7. Запускатор + systemd

- [x] 7.1 `src/scripts/periodic/banned-replacement-sweep.ts` (новый): тонкий oneshot по
      образцу `periodic/reauth-sweep.ts` (`--admin` опц., вызов оркестратора,
      `process.exit`).
- [x] 7.2 `deploy/systemd/tg-banned-replacement-sweep.{service,timer}` — суточный
      таймер, `Persistent=true`, час с отступом от занятых слотов (§3.2 архитектуры).

## 9. Документация

- [x] 9.1 `docs/task-scheduling.md` / `docs/operation.md`: новый суточный таймер
      (платформенная задача вне таблицы `tasks`) и класс каталогов пула
      `workspace-emptyAccount*`, невидимый рабочему контуру.
- [x] 9.2 `docs/telegram-errors.md`: отметить, что `banned` теперь триггерит
      авто-замену и снимается автоматически по её завершении (раздел статусной модели
      `agent_restrictions.restriction_type`).
