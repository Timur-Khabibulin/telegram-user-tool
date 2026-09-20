---
name: tg-agent-reauth
description: "DEPRECATED — выведен из эксплуатации. Re-authorize an EXISTING Telegram agent: obtains a fresh session string via auth tools and overwrites only the sessionString field in the agent's tg-account.json. Use when an agent's session is dead — e.g. AUTH_KEY_DUPLICATED, account frozen, manual logout, or session revoked — and the agent already exists (do NOT recreate it). For creating a brand-new agent use tg-agent-create instead."
---

# Telegram agent re-auth

> **DEPRECATED.** Скилл выведен из эксплуатации, использовать не нужно.

Переавторизация **уже существующего** агента. Не создаёт агента, не трогает биндинги,
файловую структуру и SOUL.md — только получает новую `sessionString` и
перезаписывает её в существующем `tg-account.json`.

Типичные триггеры: в логах `AUTH_KEY_DUPLICATED`, аккаунт заморожен, ручной
разлогин на устройстве, отозванная сессия.

> Важно про `AUTH_KEY_DUPLICATED`: отзыв ключа необратим. Старую `sessionString`
> восстановить нельзя — только выпустить новую. Перед переавторизацией убедись,
> что причина дубликата устранена (нет второго процесса/копии с тем же аккаунтом),
> иначе новый ключ умрёт так же.

---

## Шаг 1 — Запросить имя агента

**СТОП.** Напиши пользователю и жди ответа:

```
Какого агента переавторизовать? Пришли agentName (имя на английском, как в ~/.openclaw/workspace-<agentName>).
```

Запомни `<agentName>`.

---

## Шаг 2 — Прочитать существующий tg-account.json

Прочитать файл `~/.openclaw/workspace-<agentName>/tg-account.json`.

Если файла нет:

**СТОП.** Напиши пользователю и заверши скилл:

```
Не нашёл ~/.openclaw/workspace-<agentName>/tg-account.json — агент не существует
или имя указано неверно. Для создания нового агента используй скилл tg-agent-create.
```

Если файл есть — извлечь и запомнить: `accountId`, `apiId`, `apiHash`, `proxy`,
`device`, и `phoneNumber` (если поле присутствует).

Если в файле **нет** `phoneNumber`:

**СТОП.** Напиши пользователю и жди ответа:

```
В tg-account.json нет номера телефона. Пришли phoneNumber аккаунта <accountId> (формат +79001234567).
```

---

## Шаг 3 — Отправить код

**СТОП.** Напиши пользователю короткое сообщение и продолжай дальше:

```
Отправляю код на номер <phoneNumber>. Инструмент сделает до 3 попыток по 30 секунд каждая.
```

Вызвать с данными из `tg-account.json`:

```
tg_auth_send_code(
  apiId:       <apiId>,
  apiHash:     <apiHash>,
  phoneNumber: <phoneNumber>,
  proxy: {
    type:     "socks5",
    host:     <proxy.host>,
    port:     <proxy.port>,
    username: <proxy.username>,
    password: <proxy.password>
  }
)
```

Если ответ содержит поле `error`:

**СТОП.** Напиши пользователю:

```
Не удалось отправить код. Ошибка: <error из ответа>

Повторить попытку?
```

Ждать ответа. Если соглашается — повторить вызов. Если отказывается — завершить скилл.

Если успех — сохранить `phoneCodeHash` из ответа и перейти к шагу 4.

---

## Шаг 4 — Запросить код у пользователя

**СТОП.** Напиши пользователю и жди ответа. Не переходи к шагу 5 до получения кода:

```
Код отправлен в Telegram на номер <phoneNumber>.
Пришли код из Telegram.
Если на аккаунте включён 2FA — пришли также пароль.
```

---

## Шаг 5 — Войти и получить новую sessionString

Перед вызовом напиши пользователю:

```
Выполняю вход. Инструмент сделает до 3 попыток по 60 секунд каждая.
```

Вызвать:

```
tg_auth_sign_in(
  phoneNumber:   <phoneNumber>,
  phoneCodeHash: <phoneCodeHash из шага 3>,
  phoneCode:     <код от пользователя>,
  password:      <2FA пароль, если был прислан>
)
```

Если ответ содержит поле `error`:

**СТОП.** Напиши пользователю:

```
Не удалось войти. Ошибка: <error из ответа>

Повторить попытку? Если код истёк — нужно запросить новый (вернуться к шагу 3).
```

Ждать ответа:
- Если соглашается повторить с тем же кодом — повторить `tg_auth_sign_in`
- Если код истёк или нужен новый — вернуться к шагу 3
- Если отказывается — завершить скилл

Если успех — сохранить новую `sessionString` из ответа и перейти к шагу 6.

---

## Шаг 6 — Перезаписать sessionString в tg-account.json

Обновить **только** поле `sessionString` в файле
`~/.openclaw/workspace-<agentName>/tg-account.json`. Все остальные поля
(`accountId`, `apiId`, `apiHash`, `device`, `proxy`, `phoneNumber`) оставить
без изменений.

Перейти к шагу 7.

---

## Шаг 7 — Перезапустить gateway

```bash
openclaw gateway restart
```

---

## 8. Итог

**СТОП.** Напиши пользователю финальное сообщение:

```
Агент <agentName> переавторизован.
- TG-аккаунт: <accountId>
- Новая sessionString записана в tg-account.json
- Gateway перезапущен

Если ошибка была AUTH_KEY_DUPLICATED — убедись, что нет второго процесса/копии
с тем же аккаунтом, иначе новый ключ снова отзовётся.
```
