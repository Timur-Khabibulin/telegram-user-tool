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

### Лимит подключений SSH (ufw)

Порт 22 защищён `ufw` через iptables-модуль `recent` (не `ufw limit` в дефолтном
виде — значения подняты вручную 2026-08-25, правки в `/etc/ufw/user.rules` и
`/etc/ufw/user6.rules`, строка `--dport 22 ... --update --seconds 60 --hitcount 30`):
не более **30 новых подключений за 60 секунд** с одного IP, иначе пакеты молча
дропаются (клиент видит `Connection timed out`, а не отказ в подключении).
Изначальный дефолт `ufw` — 6 подключений за 30 секунд — на практике ловился не
атакой, а собственной автоматизацией (много последовательных `ssh`/`scp` вызовов
подряд с одного IP). `fail2ban` (банит по проваленным попыткам авторизации, не по
числу подключений) остаётся отдельным, не изменённым уровнем защиты.

Правки в `user.rules`/`user6.rules` **не переживают** повторный `ufw limit 22/tcp`
или похожие команды — `ufw` перезапишет строку обратно на дефолт 6/30 без
предупреждения. При работе с ufw на этом сервере проверять текущее значение:
`iptables -S ufw-user-input | grep dport` (или `ufw6-user-input` для IPv6).

Даже с поднятым лимитом — не открывать много отдельных `ssh`/`scp` подряд без
необходимости: по возможности объединять несколько удалённых команд в один вызов
(`ssh host "cmd1 && cmd2 && cmd3"`). SSH ControlMaster/ControlPersist для этого
**не работает** в среде Git Bash на Windows (мультиплексирование требует настоящего
`fork()`, которого там нет — мастер-соединение умирает вместе с процессом, который
его создал, и не переживает границу отдельной команды).

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
| `~/.openclaw/personas/<personName>/` | общие шаблоны персон (`SOUL.md` и др.) — см. ниже |
| `~/.openclaw/codex-auth/` | доступ к LLM (`auth.json`, `.env`) |

### Данные агента `~/.openclaw/workspace-<agentId>/`

| Файл | Содержимое |
|---|---|
| `tg-account.json` | учётные данные аккаунта (включая `persona` — ссылка на шаблон персоны) |
| `tg-channels.db` | каналы и DM-кандидаты |
| `tg-replies.db` | ответы и треды в группах |
| `dm-threads.db` | контекст личных диалогов |
| `tg-join-queue.db` | очередь вступления |
| `tasks.db` | расписание задач и журнал прогонов |
| `funnel.db` | метрики воронки (только у агента `FUNNEL_ADMIN_AGENT_ID`) |
| `discovery.db` | реестр найденных каналов channel-discovery (только у агента `FUNNEL_ADMIN_AGENT_ID`) |
| `reports/` | CSV-отчёты: анализ контента `channel-analysis-<UTC-ts>.csv`, воронка `funnel-<день>_<время>.csv` (только у агента `FUNNEL_ADMIN_AGENT_ID`) |
| `private-invites.db` | реестр персональных инвайт-ссылок в приватный канал (только у агента `FUNNEL_ADMIN_AGENT_ID`), создаются от имени `REPORT_AGENT_ID` |

Владелец этих файлов (`FUNNEL_ADMIN_AGENT_ID`) и получатель ежедневных отчётов
(`REPORT_AGENT_ID`) — независимые константы, не обязаны совпадать (см.
[configuration.md](configuration.md)). `REPORT_AGENT_ID` дополнительно администрирует
приватный канал (подсчёт заявок, создание инвайт-ссылок) — `FUNNEL_ADMIN_AGENT_ID` этих
прав не имеет. `REPORT_AGENT_ID` — зарезервированный агент, не
выполняющий рабочих задач: исключён из `listAgentIds()`, не запускается диспетчером и не
ставится в расписание.

Пути формируются в `src/core/config.ts`. Список агентов (за исключением
`REPORT_AGENT_ID`) определяется по каталогам `workspace-<agentId>`.

### Персона `~/.openclaw/personas/<personName>/`

Персона агента — не файл в его workspace, а ссылка (поле `persona` в
`tg-account.json`) на общий шаблон `~/.openclaw/personas/<personName>/`. `SOUL.md`
шаблона читается диспетчером заново на каждый прогон — без кэша, без копии в
workspace агента. Правка `SOUL.md` шаблона применяется ко всем агентам с этой
персоной на следующем же прогоне, без действий над самими агентами. Несколько
агентов могут ссылаться на одну персону. Отсутствие поля `persona` в
`tg-account.json` или файла `SOUL.md` в каталоге персоны — фатальная ошибка,
прогон диспетчера для агента останавливается. Остальные файлы шаблона (`post.txt`,
`photo_profile_N.*`, `channel_photo.*`, `channel_post_photo.*`,
`default_agent_data.json`, `profile_data.json`) используются только при регистрации
агента — см. [configuration.md](configuration.md).

## systemd-юниты

Шаблоны в `deploy/systemd/`, устанавливаются в `/etc/systemd/system/`, кроме
`tg-agents-slots.conf` (правило `systemd-tmpfiles`, устанавливается в
`/etc/tmpfiles.d/` — см. ниже). `%i` = `agentId`.

| Юнит | Тип | Расписание | Назначение |
|---|---|---|---|
| `tg-agent@.service` | oneshot | — | запуск диспетчера агента через `flock`-семафор (см. ниже) |
| `tg-agent@.timer` | timer | `*:0/10`, `RandomizedDelaySec=120` | heartbeat агента |
| `tg-agents.slice` | slice | — | `CPUQuota=70%`, `MemoryMax=2G` для группы агентов |
| `tg-agents-slots.conf` | tmpfiles.d | — | создаёт `/run/tg-agents/slot-{0..15}.lock` при каждой загрузке |
| `tg-daily-summary.service/.timer` | oneshot/timer | `19:00 UTC` | дневная сводка прогонов |
| `tg-funnel-tracker.service/.timer` | oneshot/timer | `19:10 UTC` | сбор воронки |
| `tg-channel-activity-update.service/.timer` | oneshot/timer | `03:00 UTC` (ежедневно) | пересчёт охвата канала (avg_views/subs_count) и активности чата (active_writers_p50/p90) — TTL 30 дней на канал по каждой группе метрик независимо |
| `tg-review-listener.service` | simple, `Restart=always` | — (постоянно работает) | ручное ревью комментариев: единственный потребитель `getUpdates` общего Bot API-бота (post-comment-review), не по таймеру |

Установка шаблонов:

```bash
cp deploy/systemd/tg-agents-slots.conf /etc/tmpfiles.d/
systemd-tmpfiles --create /etc/tmpfiles.d/tg-agents-slots.conf
cp deploy/systemd/*.service deploy/systemd/*.timer deploy/systemd/*.slice /etc/systemd/system/
systemctl daemon-reload
```

Включение таймеров:

```bash
systemctl enable --now tg-agent@<agentId>.timer
systemctl enable --now tg-daily-summary.timer
systemctl enable --now tg-review-listener.service   # persistent service, не timer
systemctl enable --now tg-funnel-tracker.timer
systemctl enable --now tg-channel-activity-update.timer
```

Таймер агента обычно включается из кода (`src/core/scheduler-control.ts`) при первой
активной задаче. Разовый запуск вне расписания: `systemctl start <unit>.service`.

`ConcurrencySoftMax=` в `tg-agents.slice` требует systemd >= 256; на VPS установлен
255, поэтому директива не используется. Вместо неё потолок параллелизма
(`C=16`) реализован через `flock` прямо в `ExecStart` `tg-agent@.service`:
перебор `C` файлов-слотов (`/run/tg-agents/slot-N.lock`, создаются
`tg-agents-slots.conf`), первый успешно захваченный — запуск диспетчера, все
заняты — тихий выход без исполнения (`nextRun` не тронут, задача остаётся
due). Ядро освобождает лок автоматически при любом завершении процесса,
включая SIGKILL от OOM-killer — убитый прогон не держит слот занятым.
`CPUQuota`, `MemoryMax` и `RandomizedDelaySec` дополнительно ограничивают
суммарную нагрузку и разносят старты во времени.

## Ёмкость каналов на агента

Сколько каналов мониторинга выдерживает один агент, не отставая от периода обхода.

Параметры (источник — код):

| Параметр | Значение | Где |
|---|---|---|
| Батч за прогон | 50 | `DEFAULT_BATCH_LIMIT`, `src/core/db/channels.ts` |
| Период обхода канала | 72 ч | `PERIOD_SECONDS`, `src/skills/monitor.ts` |
| Интервал прогона монитора | каждые 3 ч | задача `monitor` в `tasks.db` |

Канал переобрабатывается не ровно через 72 ч, а на ближайшем прогоне после
созревания. При интервале прогона `I` эффективный период = `ceil(72 / I) * I`, а
число прогонов за цикл = `эффективный период / I`.

Интервал (`I` = 3 ч) — базовый период, одинаковый у всех агентов; конкретный
cron дефолтной задачи `monitor` при этом у каждого агента свой (`0 0-23/3 * * *`,
`10 0-23/3 * * *`, …) — фаза старта распределяется round-robin, чтобы агенты не
опрашивали Telegram синхронно (`agent-schedule-offset`). На расчёт ёмкости ниже
это не влияет: меняется только момент старта внутри периода, не сам период.

**Ёмкость за цикл** = `число прогонов за цикл × батч`.
**Загрузка** = `каналов на агента / ёмкость за цикл`.

При текущем интервале 3 ч: эффективный период = `ceil(72/3)*3 = 72 ч` (делится
нацело, потерь на округление нет), 24 прогона за цикл, ёмкость = `24 × 50 = 1200`.

| Загрузка | Каналов на агента (батч 50, прогон 3 ч) |
|---|---|
| 70 % | 840 |
| 80 % | 960 |
| 90 % | 1080 |
| 95 % | 1140 |

Целевой ориентир — **70–80 % (840–960 каналов)**: остаётся запас на всплески
(непрошедшие каналы, `FLOOD_WAIT`, пропущенные тики). При 90–95 % запас почти
исчерпан, и любой сбой уводит фактический период переобработки за эффективные 72 ч.

Оговорки:

- Холостой прогон монитора (нет созревших каналов) частично не бесплатен: до
  проверки батча уже выполнен `listGroupChannels()` (`src/skills/monitor.ts`) —
  подключение к Telegram и листинг диалогов для синхронизации БД. Дозапрос
  статусов непрочитанности (`getDialogsForBatch`) выполняется только после
  проверки батча и пропускается полностью, если назревших каналов нет.
- `lastProcessedAt` каналов склонен группироваться (холодный старт обрабатывает их
  пачками по 40; выборка идёт `ORDER BY lastProcessedAt ASC`, FIFO держит кластеры).
  Из-за этого часть прогонов может быть пустой даже при средней загрузке < 100 %.

Модель батча (50 каналов / 3ч) относится к `monitor`/`monitor-v2`. `monitor-v5`
устроен иначе (human-pacing): полная синхронизация `listGroupChannels()` — не
каждый прогон, а не чаще раза в сутки; каналы на обработку отбираются
волнами случайного размера до мягкого суммарного потолка `V5_BATCH_LIMIT`
(20, не 50) — актуальные константы см. `core/config.ts`. `monitor-v3`
(`channel-post-watch`) устроен иначе — батча нет, каждый прогон (раз в 5ч)
обрабатывает ВСЕ активные каналы с публичным username сразу; проверка нового
поста идёт через веб-превью (`t.me/s/`), не через MTProto, и не расходует
бюджет запросов аккаунта на сам факт проверки. Реальные цифры длительности
прогона/нагрузки при росте числа каналов на агента пока не измерены на
проде — раздел будет дополнен после первых данных.

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

Команды без `-u <unit>` (например `-u '*'`) или без ограничения диапазона (`-S`/`--since`)
читают весь журнал (за недели аптайма) и могут надолго загрузить CPU, особенно в связке
с `grep`/`tail` по конвейеру в фоне. Такой фоновый процесс может остаться работать после
отключения SSH-сессии и держать нагрузку часами (см. инцидент 2026-06-22). Обязательно:

- ограничивать диапазон (`-S today`, `--since`/`--until`);
- оборачивать в `timeout <N>` любую команду `journalctl`, особенно запускаемую в фоне:
  `timeout 60 journalctl -u tg-agent@agent1 -g 'similar' | tail -100`.

По умолчанию журнал может храниться в памяти и теряться при перезагрузке. Включение
персистентного хранения:

```bash
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
```

Ротация — по размеру (настраивается в `/etc/systemd/journald.conf` или
`journalctl --vacuum-size=` / `--vacuum-time=`).
