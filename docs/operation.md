# Эксплуатация

Как проект разворачивается и работает на сервере: общая схема, пути, systemd,
деплой, логи.

## Обзор

На VPS работает шлюз OpenClaw (`openclaw.service`, от пользователя `root`). Каждый
агент запускается systemd-таймером `tg-agent@<agentId>.timer` (heartbeat раз в 10
минут), который вызывает диспетчер. Дополнительно два таймера раз в день: дневная
сводка прогонов и сбор метрик воронки. Данные агентов хранятся в
`~/.openclaw/workspace-<agentId>/`. Доступ к серверу — по SSH-ключу
(`ssh -i ~/.ssh/vps_key root@<host>`).

## Соответствие путей репозиторий ↔ сервер

| Репозиторий | Сервер                                          |
|---|-------------------------------------------------|
| `index.ts` | `~/.openclaw/extensions/telegram-user-tool/index.ts` |
| `src/` | `~/.openclaw/extensions/telegram-user-tool/src` |
| `skills/` | `~/.openclaw/workspace/skills/`                 |
| `deploy/systemd/*` | `/etc/systemd/system/`                          |
| `openclaw.json` | `~/.openclaw/openclaw.json`                     |

Точка входа плагина — `index.ts` в корне репозитория и в корне расширения
(`~/.openclaw/extensions/telegram-user-tool/index.ts`), а не в `src/`: OpenClaw
обнаруживает плагины по `~/.openclaw/extensions/<name>/index.ts` (см.
`openclaw/docs/tools/plugin.md`). Импорты в нём указывают на `./src/core/...`.

Каталоги, которых нет в репозитории (создаются на сервере):

| Путь | Содержимое |
|---|---|
| `~/.openclaw/workspace-<agentId>/` | данные агента |
| `~/.openclaw/codex-auth/` | доступ к LLM (`auth.json`, `.env`) |

### Данные агента `~/.openclaw/workspace-<agentId>/`

| Файл | Содержимое |
|---|---|
| `tg-account.json` | учётные данные аккаунта |
| `SOUL.md` | персона |
| `tg-channels.db` | каналы и DM-кандидаты |
| `tg-replies.db` | ответы и треды в группах |
| `dm-threads.db` | контекст личных диалогов |
| `tg-join-queue.db` | очередь вступления |
| `tasks.db` | расписание задач и журнал прогонов |
| `funnel.db` | метрики воронки (только у админ-агента) |
| `discovery.db` | реестр найденных каналов channel-discovery (только у админ-агента) |
| `reports/` | CSV-отчёты анализа контента `channel-analysis-<UTC-ts>.csv` (только у админ-агента) |

Пути формируются в `src/core/config.ts`. Список агентов определяется по каталогам
`workspace-<agentId>`.

## systemd-юниты

Шаблоны в `deploy/systemd/`, устанавливаются в `/etc/systemd/system/`. `%i` = `agentId`.

| Юнит | Тип | Расписание | Назначение |
|---|---|---|---|
| `tg-agent@.service` | oneshot | — | запуск диспетчера агента |
| `tg-agent@.timer` | timer | `*:0/10`, `RandomizedDelaySec=60` | heartbeat агента |
| `tg-agents.slice` | slice | — | `CPUQuota=70%`, `MemoryMax=2G` для группы агентов |
| `tg-daily-summary.service/.timer` | oneshot/timer | `19:00 UTC` | дневная сводка прогонов |
| `tg-funnel-tracker.service/.timer` | oneshot/timer | `19:10 UTC` | сбор воронки |

Установка шаблонов:

```bash
cp deploy/systemd/* /etc/systemd/system/
systemctl daemon-reload
```

Включение таймеров:

```bash
systemctl enable --now tg-agent@<agentId>.timer
systemctl enable --now tg-daily-summary.timer
systemctl enable --now tg-funnel-tracker.timer
```

Таймер агента обычно включается из кода (`src/core/scheduler-control.ts`) при первой
активной задаче. Разовый запуск вне расписания: `systemctl start <unit>.service`.

`ConcurrencySoftMax=` в `tg-agents.slice` требует systemd >= 256; на VPS установлен
255, поэтому строка закомментирована. Нагрузку ограничивают `CPUQuota`, `MemoryMax`
и `RandomizedDelaySec`.

## Ёмкость каналов на агента

Сколько каналов мониторинга выдерживает один агент, не отставая от периода обхода.

Параметры (источник — код):

| Параметр | Значение | Где |
|---|---|---|
| Батч за прогон | 20 | `DEFAULT_BATCH_LIMIT`, `src/core/db/channels.ts` |
| Период обхода канала | 72 ч | `PERIOD_SECONDS`, `src/skills/monitor.ts` |
| Интервал прогона монитора | каждые 3 ч (`0 */3 * * *`) | задача `monitor` в `tasks.db` |

Канал переобрабатывается не ровно через 72 ч, а на ближайшем прогоне после
созревания. При интервале прогона `I` эффективный период = `ceil(72 / I) * I`, а
число прогонов за цикл = `эффективный период / I`.

**Ёмкость за цикл** = `число прогонов за цикл × батч`.
**Загрузка** = `каналов на агента / ёмкость за цикл`.

При текущем интервале 3 ч: эффективный период = `ceil(72/3)*3 = 72 ч` (делится
нацело, потерь на округление нет), 24 прогона за цикл, ёмкость = `24 × 20 = 480`.

| Загрузка | Каналов на агента (батч 20, прогон 3 ч) |
|---|---|
| 70 % | 336 |
| 80 % | 384 |
| 90 % | 432 |
| 95 % | 456 |

Целевой ориентир — **70–80 % (336–384 канала)**: остаётся запас на всплески
(непрошедшие каналы, `FLOOD_WAIT`, пропущенные тики). При 90–95 % запас почти
исчерпан, и любой сбой уводит фактический период переобработки за эффективные 72 ч.

Оговорки:

- Холостой прогон монитора (нет созревших каналов) не бесплатен: проверка стоит
  после `listGroupChannels()` и `getDialogs()` (`src/skills/monitor.ts`), то есть
  после подключения к Telegram и листинга диалогов.
- `lastProcessedAt` каналов склонен группироваться (холодный старт обрабатывает их
  пачками по 20; выборка идёт `ORDER BY lastProcessedAt ASC`, FIFO держит кластеры).
  Из-за этого часть прогонов может быть пустой даже при средней загрузке < 100 %.

## Деплой

Код копируется на сервер через `scp` (skill `vps` или `scp -i ~/.ssh/vps_key`) в
пути из таблицы соответствия выше. `daemon-reload` нужен только при изменении самих
юнитов. Файлы конфигурации и секретов (состав — в
[configuration.md](configuration.md)) размещаются на сервере по их путям.
Интерактивный логин (`codex login`) выполняется локально, результат копируется на
VPS через `scp`.

После копирования файлы плагина должны принадлежать `root` — иначе OpenClaw
блокирует загрузку (`blocked plugin candidate: suspicious ownership`). Файлы, залитые
с Windows через `scp`/`tar`, получают чужой uid, поэтому после деплоя плагина:

```bash
ssh -i ~/.ssh/vps_key root@<host> "chown -R root:root ~/.openclaw/extensions/telegram-user-tool"
```

Затем — рестарт gateway, чтобы подхватить изменения: `openclaw gateway restart`.

## Backfill реестра discovery (разово, перед первым прогоном)

Перед первым прогоном channel-discovery реестр `discovery.db` наполняется уже
известными каналами — иначе discovery может назначить уже вступлённый канал другому
агенту (пересечение). Операция разовая, идемпотентная (`INSERT OR IGNORE`), но
необратимая для реестра — запускать осознанно.

```bash
# 1) Из очередей вступления всех агентов (ссылки берутся из join_queue):
tsx src/scripts/discovery-backfill.ts --admin agent1

# 2) Публичные каналы, вступлённые помимо очереди (вручную, по их ссылкам):
tsx src/scripts/discovery-backfill.ts --manual "t.me/foo,t.me/bar" --manual-agent agent1
```

Каждый канал заносится с `assigned_agent` его текущего владельца. Повторный запуск
ничего не дублирует. После backfill discovery поддерживает реестр сам.

## Логи

Диспетчер пишет в stdout/stderr, systemd направляет вывод в journald; отдельных
файлов логов нет.

```bash
journalctl -u tg-agent@agent1 -f          # один агент
journalctl -u 'tg-agent@*' -f             # все агенты
journalctl _SYSTEMD_SLICE=tg-agents.slice -f
journalctl -g 'PEER_ID_INVALID'           # поиск по тексту (регэксп), без -u
journalctl -u tg-agent@agent1 -S today -p err
journalctl -g '\[run\]'                    # строки статуса прогонов
```

По умолчанию журнал может храниться в памяти и теряться при перезагрузке. Включение
персистентного хранения:

```bash
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
```

Ротация — по размеру (настраивается в `/etc/systemd/journald.conf` или
`journalctl --vacuum-size=` / `--vacuum-time=`).
