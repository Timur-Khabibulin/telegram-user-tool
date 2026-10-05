---
name: tg-agent-pool-provision
description: "Фаза 1 платформы: из готовых tdata-сессий делает обезличенные пул-аккаунты (workspace-emptyAccount*) впрок, без персоны. Используй, когда оператор хочет пополнить пул подготовленных аккаунтов. Триггеры: 'подготовь аккаунты в пул', 'пополни пул', 'tg-agent-pool-provision', 'фаза 1'."
---

# tg-agent-pool-provision — производство пула обезличенных аккаунтов (фаза 1)

Скилл собирает параметры и запускает прогон отсоединённым фоновым процессом
(ops-скрипт), отчёт приходит в Saved Messages получателя отчётов. Фаза 1 НЕ
применяет персону — она делает только рабочую подготовку аккаунта. Применение
персоны — отдельный скилл `tg-agent-persona-deploy` (фаза 2).

---

## Шаг 1 — Собрать параметры

> Для подготовки пул-аккаунтов укажи:
>
> • **links** — ссылки на tdata-архивы, по одной на аккаунт (Mega folder-share
>   или Google Drive file-ссылка — вид определяется автоматически)
>
> • **twoFaPassword** — текущий 2FA-пароль аккаунтов пачки (один на весь прогон).
>   Необязателен: не указывать, если на аккаунтах пачки 2FA нет. Если пароль
>   пропустить, а 2FA на аккаунте всё же есть — этот аккаунт уйдёт в `setup_failed`,
>   остальная пачка не пострадает
>
> • **twoFaPasswordFile** — альтернатива `twoFaPassword`: имя файла в скачанном
>   архиве, где лежит текущий 2FA-пароль (например `password.txt`). Пароль читается
>   **пер-аккаунт** из своего архива — годится для пачек с разными паролями. Файл
>   ищется по имени во всём распакованном дереве. Взаимоисключающ с `twoFaPassword`;
>   файл не найден или пуст — этот аккаунт уйдёт в `setup_failed`
>
> • **proxyRegion** — регион мобильного прокси для asocks
>
> • **maxProxyAttempts** — максимум попыток подбора прокси на аккаунт

Персона и номер агента НЕ нужны — пул-аккаунт обезличен, номер `emptyAccount<K>`
выдаётся автоматически (max присутствующих + 1). Общие `apiId`/`apiHash`/целевой
2FA берутся из заготовки `~/.openclaw/account-defaults/default_agent_data.json`.

---

## Шаг 2 — Запустить прогон (в фоне, detached — ADR 0008)

Прогон идёт минуты и не должен исполняться синхронным вызовом тула (runtime режет
вызов по ~90 s watchdog). Запускаем ops-скрипт отсоединённым процессом через
`systemd-run`:

```
systemd-run \
  --unit="tg-pool-provision-$(date +%s)" \
  --property=Type=oneshot \
  --property=WorkingDirectory=/root/openclaw-plugins/telegram-user-tool \
  --property=EnvironmentFile=-/root/.openclaw/secrets.env \
  --collect \
  /root/openclaw-plugins/telegram-user-tool/node_modules/.bin/tsx \
    src/scripts/ops/tg-agent-pool-provision.ts \
    --links "<ссылки через запятую: Mega folder-share или Google Drive file>" \
    --two-fa-password "<текущий 2FA-пароль пачки; опустить, если 2FA нет>" \
    --proxy-region <регион прокси> \
    --max-proxy-attempts <лимит попыток>
```

Источник 2FA-пароля — на выбор (взаимоисключающи; опустить оба, если 2FA нет):
- `--two-fa-password "<пароль>"` — единый на всю пачку;
- `--two-fa-password-file password.txt` — имя файла в архиве, пароль читается пер-аккаунт.

Скрипт скачивает архивы, затем обрабатывает пачку последовательно: подбор прокси
→ bootstrap из tdata → удаление унаследованных публичных каналов → смена 2FA на
общий → сброс чужих сессий → регистрация второй (агентской) сессии → перенос в
`workspace-emptyAccount<K>`. Ops-скрипт держит собственный жёсткий таймаут.

---

## Шаг 3 — Подтвердить запуск

`systemd-run` возвращает управление сразу. Сообщить оператору, что прогон запущен
и **отчёт придёт в Saved Messages получателя отчётов** (`REPORT_AGENT_ID`).

Статус каждого аккаунта в отчёте:
- `done` — пул-аккаунт готов, `workspace-emptyAccount<K>` создан
- `proxy_failed` — не удалось подобрать прокси за `maxProxyAttempts` попыток
- `setup_failed` — ошибка Telegram API при гигиене (текст в отчёте)
- `needs_manual_code` — код авторизации не пришёл вовремя; повторяется только
  регистрация второй (агентской) сессии, гигиена уже применена

Неуспешные записи остаются в стейджинге
`~/.openclaw/tg-agent-pool-provisioning/staging/emptyAccount<K>/` до ручного разбора.

Ход прогона: `journalctl -u tg-pool-provision-<...> -f`.

---

## Инструменты

| Инструмент | Шаг | Файл |
|---|---|---|
| `systemd-run` → `ops/tg-agent-pool-provision.ts` (detached) | 2 | src/scripts/ops/tg-agent-pool-provision.ts → src/features/tg-agent-pool-provision/run.ts |
