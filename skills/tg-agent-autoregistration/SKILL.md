---
name: tg-agent-autoregistration
description: "Массовая автоматическая регистрация Telegram-агентов платформы из готовых tdata-сессий (закупленных заранее аккаунтов). Используй, когда оператор хочет пачкой завести новых агентов из архивов tdata. Триггеры: 'заведи агентов из tdata', 'массовая регистрация агентов', 'tg-agent-autoregistration'."
---

# tg-agent-autoregistration — массовая регистрация агентов из tdata

Скилл собирает параметры у оператора и запускает весь прогон отсоединённым
фоновым процессом (ops-скрипт), а итоговый отчёт приходит в Saved Messages
получателя отчётов.
В отличие от `tg-agent-create`/`tg-agent-create-v2` здесь нет пошагового диалога —
весь процесс на пачку аккаунтов детерминирован и не требует суждения оператора
внутри цикла (см. `openspec/changes/tg-agent-autoregistration/design.md`, решение D1).

---

## Шаг 1 — Собрать параметры

При вызове спросить у оператора:

> Для регистрации агентов из tdata укажи:
>
> • **links** — ссылки на tdata-архивы, по одной на аккаунт (Mega folder-share
>   или Google Drive file-ссылка — вид определяется автоматически)
>
> • **twoFaPassword** — текущий 2FA-пароль аккаунтов пачки (один на весь прогон)
>
> • **createPublicChannel** — создавать ли публичный канал персоны при реге
>   (по умолчанию `true`, mode B — как раньше). `false` — mode A: рега без канала,
>   канал создаётся позже отдельным скиллом `tg-agent-channel-setup`
>
> • **startAgentNumber** — номер первого создаваемого агента (`agent<N>`)
>
> • **proxyRegion** — регион мобильного прокси для asocks
>
> • **maxProxyAttempts** — максимум попыток подбора прокси на аккаунт
>
> • **personName** — имя персоны (шаблон должен уже существовать в
>   `~/.openclaw/personas/<personName>/` на ВПС)

Зафиксировать все шесть параметров. Если чего-то не хватает — спросить только
недостающее. `twoFaPassword` обязателен — без него прогон не начнётся.

---

## Шаг 2 — Запустить прогон (в фоне, detached)

Прогон пачки идёт минуты (по одному аккаунту за раз, без параллелизма) и не
должен исполняться синхронным вызовом тула внутри хода агента: runtime агента
режет один вызов тула по таймауту (~90 s) и убивает прогон на середине. Поэтому
запускаем ops-скрипт **отсоединённым фоновым процессом** через `systemd-run` —
возврат мгновенный, прогон живёт в своём юните, логи идут в journal.

Выполнить на ВПС (cwd плагина, EnvironmentFile с `ASOCKS_API_KEY` для подбора
прокси):

```
systemd-run \
  --unit="tg-autoreg-$(date +%s)" \
  --property=Type=oneshot \
  --property=WorkingDirectory=/root/openclaw-plugins/telegram-user-tool \
  --property=EnvironmentFile=-/root/.openclaw/secrets.env \
  --collect \
  /root/openclaw-plugins/telegram-user-tool/node_modules/.bin/tsx \
    src/scripts/ops/tg-agent-autoregistration.ts \
    --links "<список ссылок через запятую: Mega folder-share или Google Drive file>" \
    --two-fa-password "<текущий 2FA-пароль пачки>" \
    --start-agent-number <номер первого агента> \
    --proxy-region <регион прокси> \
    --max-proxy-attempts <лимит попыток> \
    --person-name <имя персоны> \
    [--create-public-channel false]
```

`--create-public-channel false` добавлять только для mode A (рега без канала); по
умолчанию (флаг опущен) — mode B, с каналом.

Скрипт сам определяет вид каждой ссылки (Mega/Google Drive), скачивает и (для
Google Drive) распаковывает ZIP, затем обрабатывает всю пачку последовательно:
подбирает прокси, готовит аккаунт (2FA сменяется с `twoFaPassword` на пароль
персоны, очистка прежних фото/каналов, профиль, канал персоны), регистрирует
вторую (агентскую) MTProto-сессию, переносит готовый агент в `workspace-agent<N>`.
Телефон берётся из самого аккаунта (`getMe()`), tdata-сайдкары не читаются.

---

## Шаг 3 — Подтвердить запуск

`systemd-run` возвращает управление сразу — прогон уже идёт в фоне. Сообщить
оператору, что прогон запущен, и что **итоговый отчёт придёт в Saved Messages
получателя отчётов** (`REPORT_AGENT_ID`) по завершении — тот же адресат, что у
ежедневной сводки. Синхронно ждать результат в чате не нужно.

Отчёт по завершении содержит статус каждого аккаунта:
- `done` — агент готов, workspace-agent<N> создан
- `proxy_failed` — не удалось подобрать рабочий прокси за `maxProxyAttempts` попыток
- `setup_failed` — ошибка Telegram API при подготовке аккаунта (текст ошибки — в отчёте)
- `needs_manual_code` — код авторизации не пришёл вовремя; оператору нужно
  вручную скачать `tdata` со стейджинга на ВПС (`~/.openclaw/tg-agent-autoregistration/staging/agent<N>/`)
  и завершить вход самостоятельно — скилл для этого шага автоматизации не предоставляет

Для `proxy_failed`/`setup_failed`/`needs_manual_code` запись в стейджинге
остаётся до ручного разбора — повторный прогон с тем же диапазоном `agentId`
упрётся в проверку занятости диапазона, пока запись не разберут вручную.

Ход прогона до отчёта можно смотреть в journal его юнита:
`journalctl -u tg-autoreg-<...> -f` (имя юнита — из вывода `systemd-run`).

---

## Инструменты

| Инструмент | Шаг | Файл |
|---|---|---|
| `systemd-run` → `ops/tg-agent-autoregistration.ts` (detached) | 2 | src/scripts/ops/tg-agent-autoregistration.ts → src/features/tg-agent-autoregistration/run.ts |

Plugin-тул `tg_agent_autoregistration_run` (index.ts) остаётся для точечных
случаев и ретраев, но для пачки не используется — он исполняется синхронно внутри
хода агента и потому упирается в per-tool-call таймаут runtime.
