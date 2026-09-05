# Чтение отчётов воронки с VPS по SSH

CSV-отчёты воронки лежат в `~/.openclaw/workspace-agent1/reports/` (владелец данных —
`FUNNEL_ADMIN_AGENT_ID`, по умолчанию `agent1`), имя файла — `funnel-<день>_<время>.csv`
(`<время>` — UTC, `HH-mm-ss`; второй вызов за те же сутки пишет отдельный файл, не
перезатирает предыдущий). Доступ — по ключу `~/.ssh/danil_vps_key`.

## Список файлов

```bash
ssh -i ~/.ssh/danil_vps_key root@<VPS_HOST> "ls -lt ~/.openclaw/workspace-agent1/reports/ | head -20"
```

## Прочитать файл в терминале, не скачивая

```bash
ssh -i ~/.ssh/danil_vps_key root@<VPS_HOST> "cat ~/.openclaw/workspace-agent1/reports/funnel-2026-07-30_14-23-05.csv"
```

## Скачать файл(ы) локально

Один файл (например, для Excel/Sheets):

```bash
scp -i ~/.ssh/danil_vps_key root@<VPS_HOST>:~/.openclaw/workspace-agent1/reports/funnel-2026-07-30_14-23-05.csv .
```

Все файлы за день (маска по дате в имени):

```bash
scp -i ~/.ssh/danil_vps_key "root@<VPS_HOST>:~/.openclaw/workspace-agent1/reports/funnel-2026-07-30_*.csv" .
```

## Найти значение по всем файлам

Например, все отчёты по agent5:

```bash
ssh -i ~/.ssh/danil_vps_key root@<VPS_HOST> "grep -h '^agent5,' ~/.openclaw/workspace-agent1/reports/funnel-*.csv"
```

## Собрать свой отчёт из БД

Кроме готовых CSV, можно запрашивать данные напрямую из SQLite-баз агентов на
сервере. Каждая база лежит в `~/.openclaw/workspace-<agentId>/<имя>.db`, схема
одинаковая у всех агентов. Ниже — базы, есть у каждого агента, если не
отмечено иное:

| База | Содержимое |
|---|---|
| `tg-channels.db` | каналы и DM-кандидаты |
| `tg-replies.db` | ответы и треды в группах |
| `dm-threads.db` | контекст личных диалогов |
| `tg-join-queue.db` | очередь вступления |
| `tasks.db` | расписание задач, журнал прогонов, error_log (лог ошибок аккаунта; таблица создаётся при первой ошибке — может отсутствовать) |
| `funnel.db` | метрики воронки (только у `FUNNEL_ADMIN_AGENT_ID`) |
| `discovery.db` | реестр найденных каналов channel-discovery (только у `FUNNEL_ADMIN_AGENT_ID`) |
| `private-invites.db` | реестр персональных инвайт-ссылок в приватный канал (только у `FUNNEL_ADMIN_AGENT_ID`) |
| `agent-restrictions.db` | ограничения агентов: banned / need_update_session / suspend (только у `FUNNEL_ADMIN_AGENT_ID`) |

Запрос по одному агенту — `sqlite3` через `ssh`, обязательно с `-readonly`
(не блокирует и не может испортить БД, даже если запрос кривой; диспетчер и
скиллы продолжают писать в неё параллельно):

```bash
ssh -i ~/.ssh/danil_vps_key root@<VPS_HOST> \
  "sqlite3 -readonly ~/.openclaw/workspace-agent5/tg-join-queue.db \
   \"SELECT status, COUNT(*) FROM join_queue GROUP BY status;\""
```

Запрос по **всем** агентам сразу — тот же запрос в цикле по каталогам
`workspace-*/` (агентов много, поэтому одной командой к одному файлу не
обойтись). Пример — то же самое, но по всем агентам с префиксом agentId:

```bash
ssh -i ~/.ssh/danil_vps_key root@<VPS_HOST> 'bash -s' <<'EOF'
for dir in ~/.openclaw/workspace-*/; do
  agent=$(basename "$dir" | sed 's/^workspace-//')
  db="${dir}tg-join-queue.db"
  [ -f "$db" ] || continue
  sqlite3 -readonly -separator '|' "$db" \
    "SELECT status, COUNT(*) FROM join_queue GROUP BY status;" 2>/dev/null \
    | sed "s/^/${agent}|/"
done
EOF
```

Меняется только имя файла БД (`db="${dir}<имя>.db"`) и сам SQL — остальное
(обход агентов, префикс) можно копировать без изменений. Для агрегации по всем
агентам (сумма/среднее/перцентиль) результат обычно ещё раз пропускается через
`awk`/`sort` — единого готового агрегата команда не даёт, только сырые строки
по каждому агенту.

## Запустить прогон вручную

По расписанию воронка собирается таймером `tg-funnel-tracker.timer` раз в день
(19:10 UTC). Запустить прогон вне расписания — тем же systemd-юнитом, он уже несёт
правильные `WorkingDirectory`/`EnvironmentFile`:

```bash
ssh -i ~/.ssh/danil_vps_key root@<VPS_HOST> "systemctl start tg-funnel-tracker.service"
```

Прогон разовый (`Type=oneshot`) и пишет новый CSV с текущим временем в имени — уже
существующие отчёты за день не перезатирает. Проверить результат:

```bash
ssh -i ~/.ssh/danil_vps_key root@<VPS_HOST> "systemctl status tg-funnel-tracker.service"
ssh -i ~/.ssh/danil_vps_key root@<VPS_HOST> "journalctl -u tg-funnel-tracker.service -S today -n 50"
```
