# Деплой task-scheduler

Инфраструктура сервера (не часть релиза кода). Эти шаги выполняются вручную на
VPS один раз; `daemon-reload` нужен только при изменении самих шаблонов юнитов.

## 1. systemd-юниты (раздел 5)

Три шаблонных файла на всех агентов (`%i` = `agentId`):

```
deploy/systemd/tg-agent@.service   # Type=oneshot, ExecStart дисп., Slice, TimeoutStartSec=3600
deploy/systemd/tg-agent@.timer     # OnCalendar=*:0/10, RandomizedDelaySec=60
deploy/systemd/tg-agents.slice     # CPUQuota=70%, MemoryMax=2G (ConcurrencySoftMax закомм. — нужен systemd>=256)
```

Установка (5.4):

```bash
cp deploy/systemd/tg-agent@.service /etc/systemd/system/
cp deploy/systemd/tg-agent@.timer   /etc/systemd/system/
cp deploy/systemd/tg-agents.slice   /etc/systemd/system/
systemctl daemon-reload
```

Включение агента (делает OpenClaw-пульт, раздел 6):

```bash
systemctl enable --now tg-agent@<agentId>.timer
```

> `ConcurrencySoftMax=` требует systemd >= 256. На текущем VPS **systemd 255** —
> поэтому в `tg-agents.slice` строка закомментирована, нагрузку держат
> `CPUQuota`/`MemoryMax` + `RandomizedDelaySec`. После апгрейда до 256+ —
> раскомментировать. Проверить версию: `systemctl --version`.

## 1b. Дневная сводка прогонов (run-status-tracking)

Сводит таблицы `runs` всех агентов за завершившийся день (граница UTC+5) и шлёт
текст в Saved Messages админ-аккаунта. Два юнита:

```
deploy/systemd/tg-daily-summary.service   # oneshot, ExecStart=... daily-summary.ts --admin <agentId>
deploy/systemd/tg-daily-summary.timer     # OnCalendar=*-*-* 19:00:00 UTC (00:00 UTC+5), Persistent=true
```

`--admin <agentId>` в `ExecStart` задаёт аккаунт-получатель сводки (по умолчанию
`agent1` — поправить в `.service` при другом админе). Установка:

```bash
cp deploy/systemd/tg-daily-summary.service /etc/systemd/system/
cp deploy/systemd/tg-daily-summary.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tg-daily-summary.timer
```

Разовый прогон вручную (не дожидаясь таймера): `systemctl start tg-daily-summary.service`.
По запросу за текущий день — OpenClaw-инструмент `tg_daily_summary` (скилл
`skills/daily-summary`). Статус каждого прогона также виден в журнале:
`journalctl -g '\[run\]'` (строки `[run] agent=… status=…`).

## 1c. Воронка по агентам (funnel-tracking)

Раз в день собирает метрики воронки по всем агентам (активность в группах/DM,
просмотры поста и подписчики публичного канала из профиля каждого аккаунта) и по
agent1 — число заявок на вступление в приватный канал; пишет снапшоты и агрегаты
в `~/.openclaw/workspace-agent1/funnel.db` и шлёт отчёт в Saved Messages agent1.
Два юнита:

```
deploy/systemd/tg-funnel-tracker.service   # oneshot, ExecStart=... funnel-tracker.ts --admin agent1
deploy/systemd/tg-funnel-tracker.timer     # OnCalendar=*-*-* 19:10:00 UTC (00:10 UTC+5), Persistent=true
```

ID приватного канала и админ-агент берутся из `src/core/config.ts`
(`FUNNEL_PRIVATE_CHANNEL_ID`, `FUNNEL_ADMIN_AGENT_ID`) — в юните их указывать не
нужно. Установка:

```bash
cp deploy/systemd/tg-funnel-tracker.service /etc/systemd/system/
cp deploy/systemd/tg-funnel-tracker.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tg-funnel-tracker.timer
```

Разовый прогон вручную (не дожидаясь таймера): `systemctl start tg-funnel-tracker.service`.
По запросу за текущий момент — OpenClaw-инструмент `tg_funnel_report` (скилл
`skills/funnel-report`); он считает срез «на сейчас» и снапшотов не пишет. И
таймер, и инструмент берут id из `config.ts` — env-переменные не используются;
скрипт принимает необязательный `--private-channel <id>` как переопределение.

> **Требование:** agent1 должен быть админом приватного канала с правом
> «Добавлять участников» (`invite_users`) — иначе подсчёт заявок вернёт
> `CHAT_ADMIN_REQUIRED` и в отчёте строка заявок будет помечена недоступной
> (остальные метрики собираются как обычно).

## 2. codex OAuth (раздел 7.4)

Один общий `auth.json` на всех агентов (общий пул лимита ChatGPT Plus):

```
~/.openclaw/codex-auth/auth.json
```

Первый логин выполняется локально, затем файл копируется на VPS:

```bash
# локально
codex login                                  # создаёт ~/.codex/auth.json
scp -i ~/.ssh/vps_key ~/.codex/auth.json \
    root@<host>:~/.openclaw/codex-auth/auth.json

# на VPS — права (файл записываемый владельцем для write-back рефреша токена)
chmod 700 ~/.openclaw/codex-auth
chmod 600 ~/.openclaw/codex-auth/auth.json
```

`LlmClient` указывает на этот путь явно (`authFilePath` в `src/llm/client.ts`).
При `ensureFresh: true` (дефолт) протухший access token рефрешится и пишется
обратно в `auth.json` автоматически.

## 3. Fallback-ключ OpenAI (раздел 7.6)

`OPENAI_API_KEY` для запасной модели передаётся через `EnvironmentFile` сервиса:

```
~/.openclaw/codex-auth/.env        # OPENAI_API_KEY=sk-...
chmod 600 ~/.openclaw/codex-auth/.env
```

Путь объявлен в `tg-agent@.service` как `EnvironmentFile=-/root/.openclaw/codex-auth/.env`
(префикс `-` — файл необязателен: без него primary codex продолжает работать,
fallback просто недоступен).

> Сейчас fallback **отключён** (в `client.ts` `@ai-sdk/openai` закомментирован,
> модель только codex) — `.env`/`OPENAI_API_KEY` не требуется, пока fallback не вернут.

## 4. Эксплуатация: логи (journald)

Диспетчер пишет в **stdout/stderr**; systemd (`StandardOutput=journal`) направляет
вывод в **journald**. Отдельных файлов-логов нет — всё в системном журнале с тегом
юнита. Юниты: `tg-agent@<agentId>.service` (диспетчер), `tg-agent@<agentId>.timer`
(таймер), `openclaw.service` (gateway).

**Реалтайм (как `tail -f`):**

```bash
journalctl -u tg-agent@agent1 -f            # один агент
journalctl -u tg-agent@agent1 -n 100 -f     # + последние 100 строк сначала
journalctl -u 'tg-agent@*' -f               # все агенты
journalctl _SYSTEMD_SLICE=tg-agents.slice -f  # вся группа
```

**За день / интервал:**

```bash
journalctl -u tg-agent@agent1 --since "2026-05-31" --until "2026-06-01"
journalctl -u tg-agent@agent1 --since "2026-05-31 14:00" --until "2026-05-31 15:00"
journalctl -u tg-agent@agent1 -S today          # -S = --since
journalctl -u tg-agent@agent1 --since "1 hour ago"
```

**Полезные флаги:** `-o short-iso` (ISO-таймстемпы), `-p err` (только ошибки),
`-r` (свежие сверху), `--no-pager` (без less), `-g 'PEER_ID_INVALID'` (grep).

**По строке (содержимому), а не по юниту:** флаг `-g` / `--grep` ищет по тексту
сообщений во всём журнале — `-u` указывать не нужно:

```bash
journalctl -g 'PEER_ID_INVALID'                 # по всем юнитам сразу
journalctl -f -g 'PEER_ID_INVALID'              # реалтайм, как tail -f | grep
journalctl -g 'FLOOD_WAIT' -r --no-pager        # свежие сверху, без пейджера
```

- `-g` принимает **регэксп** (PCRE): `journalctl -g 'error|warn'`.
- Регистр **умный**: без заглавных в паттерне поиск нечувствителен; принудительно —
  `--case-sensitive=true`.
- Комбинируется с фильтрами — тогда grep работает внутри выборки:
  ```bash
  journalctl _SYSTEMD_SLICE=tg-agents.slice -g 'PEER_ID_INVALID' -f   # по всей группе
  journalctl --since "1 hour ago" -g 'flood' -p err                   # за час, ошибки
  ```

### Персистентность (логи переживают перезагрузку)

По умолчанию journald может быть **volatile** — журнал в `/run/log/journal`
(в памяти), теряется при ребуте. Проверка:

```bash
ls /var/log/journal 2>/dev/null && echo persistent || echo "volatile (только /run)"
journalctl --disk-usage
```

Чтобы логи сохранялись между перезагрузками:

```bash
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal   # выставит владельца/права
systemctl restart systemd-journald                    # переключит на persistent
```

(Эквивалент — задать `Storage=persistent` в `/etc/systemd/journald.conf` и
перезапустить `systemd-journald`.)

### Сколько будет файлов за месяцы работы

journald **не** создаёт по файлу на день/юнит и **не растёт безгранично**. Это
сегментированный бинарный журнал (`/var/log/journal/<machine-id>/*.journal`),
общий для всех юнитов; `-u` фильтрует по метаданным, а не по отдельным файлам.
Ротация — по размеру, не по дате, со встроенными лимитами (дефолты):

- `SystemMaxUse` — суммарный потолок (≈10% раздела, но не более **4 ГБ**);
- `SystemMaxFiles` — максимум **100** файлов-сегментов;
- `SystemKeepFree`, `MaxRetentionSec`, `MaxFileSec` — доп. ограничения.

При достижении лимита старые сегменты автоматически удаляются (vacuum). Поэтому за
несколько месяцев будет **скользящее окно**: не «N файлов по числу дней», а ≤100
сегментов суммарно в пределах ~4 ГБ (или 10% диска), старое затирается. Настроить
в `/etc/systemd/journald.conf` (напр. `SystemMaxUse=500M`, `MaxRetentionSec=1month`)
+ `systemctl restart systemd-journald`. Ручная чистка:

```bash
journalctl --vacuum-size=500M      # оставить не больше 500 МБ
journalctl --vacuum-time=30d       # удалить старше 30 дней
```
