## Why

`channels.CreateChannel` отклоняется `USER_RESTRICTED` (403): аккаунт под антиспам-
ограничением Telegram **на уровне аккаунта** (подтверждено @SpamBot), которое блокирует
создание публичного канала независимо от сессии и возраста аккаунта. Двухфазная модель
(фаза 1 делает обезличенный пул → фаза 2 позже наносит персону и создаёт канал) из-за
этого не работает — создание канала в фазе 2 всегда упирается в ограничение. Единый
процесс `tg-agent-autoregistration` создаёт публичный канал сразу при настройке аккаунта
из tdata, в один прогон, и это работает (подтверждено заказчиком).

Требования и архитектура зафиксированы в
[docs/design/persona-account-reserve/requirements-v1.md](../../../docs/design/persona-account-reserve/requirements-v1.md)
(R1–R20, AC-1…AC-13) и
[docs/design/persona-account-reserve/architecture.md](../../../docs/design/persona-account-reserve/architecture.md).

## What Changes

- Добавляется **третий путь подготовки аккаунта** — единый «провижен-в-резерв»: из tdata
  за один прогон полностью настраивает аккаунт под персону (логика = `tg-agent-autoregistration`:
  гигиена → профиль/фото → публичный канал персоны с постом → вторая сессия), **с
  экспортом персональной инвайт-ссылки воронки и вставкой её в пост внутри скилла**, и
  кладёт готовый аккаунт в **резерв**, а не в рабочий контур.
- Вводится состояние **«резерв»** (`workspace-reserve-<persona>-<K>`, пер-персонная
  нумерация, невидимо рабочему контуру за счёт префикса — без правок перечислителей; без
  прогрева/задач до активации). Резерв разбит по персонам.
- Вводится **активация** (резерв → активен): валидация подключением → атомарный claim →
  финализация жизненного цикла; публичный канал/пост при активации не создаются и не
  трогаются; запись реестра инвайт-ссылок перекеивается `reserveId → agentId` без вызовов
  Telegram.
- Два триггера активации: **(1)** доработанный `banned-account-replacement` берёт из
  резерва аккаунт той же персоны, что у забаненного (вместо настройки обезличенного пула);
  при непригодном — добор следующего; при пустом резерве персоны — агент остаётся `banned`
  + разовый пер-персонный алерт, без фолбэка на обезличенный пул. **(2)** новый скилл
  ручной активации — присваивает `agent<N>` в момент активации.
- Два существующих скилла (`tg-agent-pool-provision`, `tg-agent-persona-deploy`) и логика
  ядра `core/tdata/account-setup.ts` **не меняются** — новый путь добавляется в дополнение.

## Capabilities

### New Capabilities
- `persona-account-reserve`: единый провижен-в-резерв (полная настройка под персону за один
  прогон + помещение готового аккаунта в пер-персонный резерв), состояние «резерв» и его
  невидимость рабочему контуру, активация (валидация → claim → финализация, без создания
  канала) и два триггера активации (замена банов из резерва + ручная активация).

### Modified Capabilities
- `banned-account-replacement`: источником замены становится резерв готовых аккаунтов той
  же персоны (вместо «взять обезличенный пул-аккаунт и настроить под персону»); персона
  к каналу повторно не применяется, канал не создаётся; добор следующего пригодного при
  непригодном; при пустом резерве нужной персоны — агент остаётся `banned` с разовым
  пер-персонным оповещением, без фолбэка на обезличенный пул.

## Impact

- **Новые модули:** `src/features/tg-agent-reserve-provision/{run,staging}.ts`,
  `src/features/persona-account-reserve/activate.ts`, `src/core/reserve-accounts.ts`,
  `src/scripts/ops/tg-agent-reserve-provision.ts`, `src/scripts/ops/tg-agent-reserve-activate.ts`,
  `skills/tg-agent-reserve-provision/SKILL.md`, `skills/tg-agent-reserve-activate/SKILL.md`.
- **Правятся:** `src/features/banned-account-replacement/run.ts` (источник = резерв,
  перекей инвайт-записи, пер-персонный алерт), `src/core/db/private-invites.ts` (новый
  `rekeyPrivateInviteLink`), `index.ts` (+3 регистрации тулов).
- **Переиспользуется без изменений:** `core/tdata/account-setup.ts`, `core/pool-accounts.ts`
  (валидация/карантин/claim), `banned-account-replacement/swap.ts`, `scheduler-control.ts`,
  `lifecycle-transitions.ts`, перечислители `config.ts`.
- **Новое файловое пространство:** `~/.openclaw/workspace-reserve-<persona>-<K>`,
  `~/.openclaw/tg-agent-reserve-provisioning/staging/<reserveId>/`,
  `~/.openclaw/banned-replacement/reserve-empty-alerted-<persona>`.
- Telegram API — те же вызовы, что уже используются (`channels.CreateChannel`,
  `account.UpdatePersonalChannel`, `exportChatInvite`); новых нет.
- Не затрагиваются: фаза 1 `tg-agent-pool-provision`, фаза 2 `tg-agent-persona-deploy`
  (остаются рабочими — оба пути сосуществуют).
