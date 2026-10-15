---
name: tg-agent-reserve-provision
description: "Третий путь подготовки платформы: из готовых tdata-сессий делает ПОЛНОСТЬЮ настроенные под персону аккаунты (персона + публичный канал с постом и инвайт-ссылкой + агентская сессия) и складывает их в резерв (workspace-reserve-<persona>-<K>) впрок. Используй, когда оператор хочет пополнить резерв готовых аккаунтов персоны. Триггеры: 'подготовь аккаунты в резерв', 'пополни резерв персоны', 'tg-agent-reserve-provision', 'provision в резерв'."
---

# tg-agent-reserve-provision — наполнение резерва готовых аккаунтов персоны

Скилл собирает параметры и запускает прогон отсоединённым фоновым процессом
(ops-скрипт), отчёт приходит в Saved Messages получателя отчётов. В отличие от
двухфазного пути (пул → персона), этот скилл делает всё в один прогон на свежем
аккаунте: гигиена + персона + публичный канал персоны с постом — поэтому создание
канала не упирается в `USER_RESTRICTED`. Готовый аккаунт уходит в резерв, а не в
рабочий контур; ввод в работу — отдельная активация (`tg-agent-reserve-activate`
или авто-замена банов).

Два существующих скилла (`tg-agent-pool-provision`, `tg-agent-persona-deploy`)
продолжают работать — этот добавлен в дополнение, не замещает их.

---

## Шаг 1 — Собрать параметры

> Для наполнения резерва укажи:
>
> • **personName** — имя персоны (шаблон `~/.openclaw/personas/<personName>/`;
>   канальные файлы `post.txt`, `channel_photo.*`, `channel_post_photo.*` обязательны —
>   канал создаётся)
>
> • **links** — ссылки на tdata-архивы, по одной на аккаунт (Mega folder-share
>   или Google Drive file-ссылка — вид определяется автоматически)
>
> • **twoFaPassword** — текущий 2FA-пароль аккаунтов пачки (один на весь прогон).
>   Необязателен: не указывать, если на аккаунтах пачки 2FA нет. Если пароль
>   пропустить, а 2FA на аккаунте всё же есть — этот аккаунт уйдёт в `setup_failed`,
>   остальная пачка не пострадает
>
> • **proxyRegion** — регион мобильного прокси для asocks
>
> • **maxProxyAttempts** — максимум попыток подбора прокси на аккаунт

Номер `reserve-<persona>-<K>` выдаётся автоматически (пер-персонная нумерация:
max присутствующих у этой персоны + 1). Общие `apiId`/`apiHash`/целевой 2FA берутся
из заготовки `~/.openclaw/account-defaults/default_agent_data.json`. Инвайт-ссылку в
приватный канал воронки скилл экспортирует и вставляет в пост сам (от `REPORT_AGENT_ID`)
— аккаунт уходит в резерв полностью готовым.

---

## Шаг 2 — Запустить прогон (в фоне, detached — ADR 0008)

Прогон идёт минуты и не должен исполняться синхронным вызовом тула (runtime режет
вызов по ~90 s watchdog). Запускаем ops-скрипт отсоединённым процессом через
`systemd-run`:

```
systemd-run \
  --unit="tg-reserve-provision-$(date +%s)" \
  --property=Type=oneshot \
  --property=WorkingDirectory=/root/openclaw-plugins/telegram-user-tool \
  --property=EnvironmentFile=-/root/.openclaw/secrets.env \
  --collect \
  /root/openclaw-plugins/telegram-user-tool/node_modules/.bin/tsx \
    src/scripts/ops/tg-agent-reserve-provision.ts \
    --person <имя персоны> \
    --links "<ссылки через запятую: Mega folder-share или Google Drive file>" \
    --two-fa-password "<текущий 2FA-пароль пачки; опустить, если 2FA нет>" \
    --proxy-region <регион прокси> \
    --max-proxy-attempts <лимит попыток>
```

2FA-пароль пачки можно не передавать флагом, а положить в env `TG_POOL_SOURCE_2FA`
(`secrets.env`) — безопаснее, секрет не уходит в командную строку/логи.

Скрипт скачивает архивы, затем обрабатывает пачку последовательно: подбор прокси →
bootstrap из tdata → гигиена (удаление унаследованных каналов, смена 2FA, сброс чужих
сессий) → профиль/username/фото → экспорт инвайт-ссылки + создание публичного канала
персоны с постом → регистрация второй (агентской) сессии → перенос в
`workspace-reserve-<persona>-<K>`. Ops-скрипт держит собственный жёсткий таймаут
(масштабируется по размеру пачки).

---

## Шаг 3 — Подтвердить запуск

`systemd-run` возвращает управление сразу. Сообщить оператору, что прогон запущен
и **отчёт придёт в Saved Messages получателя отчётов** (`REPORT_AGENT_ID`).

Статус каждого аккаунта в отчёте:
- `done` — аккаунт готов и в резерве, `workspace-reserve-<persona>-<K>` создан
- `proxy_failed` — не удалось подобрать прокси за `maxProxyAttempts` попыток
- `setup_failed` — ошибка Telegram API при подготовке/создании канала (текст в отчёте)
- `needs_manual_code` — код авторизации не пришёл вовремя; повторяется только
  регистрация второй (агентской) сессии, гигиена и канал уже применены
  (`tg_agent_reserve_provision_retry_code`)

Неуспешные записи остаются в стейджинге
`~/.openclaw/tg-agent-reserve-provisioning/staging/reserve-<persona>-<K>/` до разбора.

Ход прогона: `journalctl -u tg-reserve-provision-<...> -f`.

---

## Инструменты

| Инструмент | Шаг | Файл |
|---|---|---|
| `systemd-run` → `ops/tg-agent-reserve-provision.ts` (detached) | 2 | src/scripts/ops/tg-agent-reserve-provision.ts → src/features/tg-agent-reserve-provision/run.ts |
