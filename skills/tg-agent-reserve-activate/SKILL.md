---
name: tg-agent-reserve-activate
description: "Ручная активация аккаунта из резерва готовых аккаунтов персоны: переводит выбранный workspace-reserve-<persona>-<K> в рабочий контур под новой меткой workspace-agent<N>, без создания канала (он уже готов). Используй, когда оператор хочет ввести в работу готовый аккаунт резерва по своему решению. Триггеры: 'активируй аккаунт резерва', 'введи в работу резерв', 'tg-agent-reserve-activate'."
---

# tg-agent-reserve-activate — ручная активация аккаунта резерва (триггер 2)

Скилл вводит в работу один готовый аккаунт резерва: присваивает ему метку рабочего
агента `agent<N>` и запускает прогрев. Публичный канал, пост и персональная
инвайт-ссылка уже готовы в резерве с момента провиженинга — активация их НЕ трогает
(поэтому не упирается в `USER_RESTRICTED`). Запись реестра инвайт-ссылок перекеивается
на финальный `agent<N>` без вызовов Telegram.

Это триггер 2. Триггер 1 (авто-замена забаненных из резерва той же персоны) работает
сам в суточном sweep `banned-account-replacement` — отдельного скилла не требует.

---

## Шаг 1 — Выбрать аккаунт резерва

> Укажи **reserveId** аккаунта, который вводим в работу, например `reserve-maria-3`.

Что есть в резерве по персонам — каталоги `~/.openclaw/workspace-reserve-<persona>-<K>`
(без суффиксов `.invalid`/`.incoming`). Старейшие по `ctime` — кандидаты в первую
очередь (тот же порядок, что у авто-замены).

---

## Шаг 2 — Запустить активацию (в фоне, detached — ADR 0008)

Активация валидирует аккаунт подключением (может занять до пары минут) и не должна
исполняться синхронным вызовом тула (runtime режет вызов по ~90 s watchdog). Запускаем
ops-скрипт отсоединённым процессом через `systemd-run`:

```
systemd-run \
  --unit="tg-reserve-activate-$(date +%s)" \
  --property=Type=oneshot \
  --property=WorkingDirectory=/root/openclaw-plugins/telegram-user-tool \
  --property=EnvironmentFile=-/root/.openclaw/secrets.env \
  --collect \
  /root/openclaw-plugins/telegram-user-tool/node_modules/.bin/tsx \
    src/scripts/ops/tg-agent-reserve-activate.ts \
    --reserve-id <reserve-<persona>-<K>>
```

Скрипт: валидация подключением (R19) → атомарный claim в `workspace-agent<N>.incoming`
(метка N = следующий свободный номер) → перепись `accountId=agent<N>` → промоушен в
`workspace-agent<N>` → финализация (перекей инвайт-записи, включение прогрева, посев
отложенных переходов). Ops-скрипт держит собственный жёсткий таймаут.

---

## Шаг 3 — Подтвердить запуск

`systemd-run` возвращает управление сразу. Сообщить оператору, что активация запущена
и **итог придёт в Saved Messages получателя отчётов** (`REPORT_AGENT_ID`).

Статус в отчёте:
- `done` — аккаунт активирован как `agent<N>`, прогрев включён
- `account_invalid` — аккаунт непригоден при проверке подключением, уведён в карантин
  (`workspace-reserve-<persona>-<K>.invalid`), не активирован
- `skip` — временная ошибка подключения (прокси/сеть); повторить позже, карантина нет
- `taken` — аккаунт исчез при заборе (уже активируется/забран другим процессом)

Ход прогона: `journalctl -u tg-reserve-activate-<...> -f`.

---

## Инструменты

| Инструмент | Шаг | Файл |
|---|---|---|
| `systemd-run` → `ops/tg-agent-reserve-activate.ts` (detached) | 2 | src/scripts/ops/tg-agent-reserve-activate.ts → src/features/persona-account-reserve/activate.ts |
