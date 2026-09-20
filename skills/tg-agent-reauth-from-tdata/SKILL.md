---
name: tg-agent-reauth-from-tdata
description: "Re-authorizes an EXISTING Telegram agent using its own tdata session (Telegram Desktop), fully automatically — no manual code entry, no changes to profile/photos/channels/2FA. Use when an agent's session is dead (AUTH_KEY_DUPLICATED, need_update_session) AND a tdata folder for that account is available. Different from tg-agent-reauth (requires the operator to relay a code manually) and from tg-agent-autoregistration (creates a brand-new agent, destructive setup). Triggers: 'реавторизуй агента через tdata', 'tg-agent-reauth-from-tdata'."
---

# Telegram agent reauth from tdata

Реавторизация **уже существующего** агента через уже имеющуюся tdata-сессию —
без участия оператора в получении кода. Ничего в профиле/фото/каналах/2FA
агента не меняется — только выпускается новая `sessionString`.

Прогон идёт минуты (ожидание кода авторизации через tdata) и потому не исполняется
синхронным вызовом тула: runtime агента режет один вызов тула по таймауту (~90 s) и
убивает прогон на ожидании кода. Поэтому запускаем ops-скрипт **отсоединённым фоновым
процессом** через `systemd-run` — возврат мгновенный, прогон живёт в своём юните,
итог приходит в Saved Messages получателя отчётов.

---

## Шаг 1 — Собрать данные и убедиться, что tdata на месте

Спросить у оператора **сразу оба параметра** (интерактивного ввода посреди прогона
нет — detached-процесс не может спросить пароль по ходу):

> Для реавторизации через tdata укажи:
>
> • **agentId** — какого агента реавторизовать (например `agent207`)
>
> • **2FA-пароль** аккаунта. Если не знаешь — напиши «дефолт», будет взят пароль
>   шаблона персоны по умолчанию

Проверить, что `~/.openclaw/workspace-<agentId>/tdata/` уже существует на сервере
(например, через skill `vps`: `ls ~/.openclaw/workspace-<agentId>/tdata/`). Если папки
нет:

**СТОП.** Напиши пользователю и жди ответа:

```
На сервере нет ~/.openclaw/workspace-<agentId>/tdata/. Загрузи туда папку tdata с
этого аккаунта и напиши, когда будет готово.
```

Не переходи к Шагу 2 без подтверждения, что tdata на сервере есть.

---

## Шаг 2 — Запустить прогон (в фоне, detached)

Выполнить на ВПС (cwd плагина). `--password2fa` добавлять только если оператор дал
явный пароль; при «дефолт» — флаг опустить (скрипт возьмёт пароль шаблона персоны).

```
systemd-run \
  --unit="tg-reauth-$(date +%s)" \
  --property=Type=oneshot \
  --property=WorkingDirectory=/root/openclaw-plugins/telegram-user-tool \
  --property=EnvironmentFile=-/root/.openclaw/secrets.env \
  --collect \
  /root/openclaw-plugins/telegram-user-tool/node_modules/.bin/tsx \
    src/scripts/ops/tg-agent-reauth-from-tdata.ts \
    --agent-id <agentId> \
    [--password2fa "<2FA-пароль>"]
```

Скрипт подключается через tdata агента, регистрирует новую MTProto-сессию (код
перехватывается автоматически), перезаписывает **только** `sessionString` в
`tg-account.json` и снимает активное ограничение агента. Остальные поля профиля не
трогаются.

---

## Шаг 3 — Подтвердить запуск

`systemd-run` возвращает управление сразу — прогон уже идёт в фоне. Сообщить
оператору, что прогон запущен, и что **итоговый статус придёт в Saved Messages
получателя отчётов** (`REPORT_AGENT_ID`) по завершении — тот же адресат, что у
ежедневной сводки. Синхронно ждать результат в чате не нужно.

Отчёт по завершении содержит один терминальный статус прогона:
- `done` — реавторизован, новая `sessionString` записана, ограничение снято
- `agent_not_found` — `tg-account.json` агента не найден
- `tdata_missing` — папки tdata по ожидаемому пути нет или она неполна (текст — в отчёте)
- `connect_failed` — не удалось расшифровать tdata или подключиться через прокси агента
- `code_timeout` — код авторизации не пришёл вовремя
- `password_rejected` — использованный 2FA-пароль не подошёл
- `error` — прочая ошибка (текст — в отчёте)

При любом отказе прогон завершается — интерактивного «пришли другой пароль/повтори»
внутри прогона нет. Повтор = новый запуск Шага 2 (при `password_rejected` — с верным
`--password2fa`).

Отдельного `gateway restart` не требуется: диспетчер читает `tg-account.json` заново
на своём ближайшем тике.

Напомнить оператору: **не открывать эту же tdata локально в Telegram Desktop
параллельно** — иначе сессия может снова задублироваться.

Ход прогона до отчёта можно смотреть в journal его юнита:
`journalctl -u tg-reauth-<...> -f` (имя юнита — из вывода `systemd-run`).

---

## Инструменты

| Инструмент | Шаг | Файл |
|---|---|---|
| `systemd-run` → `ops/tg-agent-reauth-from-tdata.ts` (detached) | 2 | src/scripts/ops/tg-agent-reauth-from-tdata.ts → src/features/tg-agent-reauth-from-tdata/run.ts |

Plugin-тул `tg_agent_reauth_from_tdata` (index.ts) остаётся для точечных случаев, но
для операторского прогона не используется — он исполняется синхронно внутри хода
агента и потому упирается в per-tool-call таймаут runtime.
