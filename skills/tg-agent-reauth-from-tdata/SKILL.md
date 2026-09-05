---
name: tg-agent-reauth-from-tdata
description: "Re-authorizes an EXISTING Telegram agent using its own tdata session (Telegram Desktop), fully automatically — no manual code entry, no changes to profile/photos/channels/2FA. Use when an agent's session is dead (AUTH_KEY_DUPLICATED, need_update_session) AND a tdata folder for that account is available. Different from tg-agent-reauth (requires the operator to relay a code manually) and from tg-agent-autoregistration (creates a brand-new agent, destructive setup). Triggers: 'реавторизуй агента через tdata', 'tg-agent-reauth-from-tdata'."
---

# Telegram agent reauth from tdata

Реавторизация **уже существующего** агента через уже имеющуюся tdata-сессию —
без участия оператора в получении кода. Ничего в профиле/фото/каналах/2FA
агента не меняется — только выпускается новая `sessionString`.

Детерминированный процесс, без пошагового диалога с суждениями оператора
(см. `openspec/changes/tg-agent-reauth-from-tdata/design.md`).

---

## Шаг 1 — Запросить агента и убедиться, что tdata на месте

**СТОП.** Напиши пользователю и жди ответа:

```
Какого агента реавторизовать через tdata? Пришли agentId (например agent207).
```

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

## Шаг 2 — Вызвать реавторизацию

**СТОП.** Напиши пользователю короткое сообщение и продолжай дальше:

```
Реавторизую agent<N> через tdata...
```

Вызвать:

```
tg_agent_reauth_from_tdata(agentId: <agentId>)
```

(`password2fa` не передавать при первом вызове — инструмент сам попробует пароль
шаблона персоны по умолчанию.)

---

## Шаг 3 — Обработать результат по `kind`

- **`done`** — успех. Перейти к Шагу 4.
- **`agent_not_found`** — агента с таким `agentId` не существует.
  **СТОП.** Сообщить пользователю и завершить скилл.
- **`tdata_missing`** — папки tdata по ожидаемому пути нет или она неполна
  (нет `Accounts.txt`/`Password2FA.txt`). **СТОП.** Сообщить путь из ответа,
  вернуться к Шагу 1.
- **`connect_failed`** — не удалось расшифровать tdata или подключиться через
  прокси агента. **СТОП.** Показать текст ошибки пользователю, спросить,
  повторить ли попытку.
- **`code_timeout`** — код авторизации не пришёл за отведённое время.
  **СТОП.** Сообщить пользователю, предложить повторить вызов.
- **`password_rejected`** — использованный 2FA-пароль (по умолчанию или
  переданный) не подошёл.

  **СТОП.** Напиши пользователю и жди ответа:

  ```
  Пароль 2FA не подошёл. Пришли актуальный пароль этого аккаунта.
  ```

  Получив пароль — повторить Шаг 2 с `password2fa: <пароль>`.
- **`error`** — прочая ошибка (текст — в поле `error`). **СТОП.** Показать
  пользователю, спросить, повторить ли попытку.

---

## Шаг 4 — Перезапустить gateway и сообщить итог

```bash
openclaw gateway restart
```

**СТОП.** Напиши пользователю финальное сообщение:

```
Агент <agentId> реавторизован через tdata.
- TG-аккаунт: <accountId>
- Новая sessionString записана в tg-account.json (остальные поля не менялись)
- Gateway перезапущен

tdata-сессия осталась активной — не открывай эту же tdata локально в Telegram
Desktop параллельно, иначе сессия может снова задублироваться.
```

---

## Инструменты

| Инструмент | Шаг | Файл |
|---|---|---|
| `tg_agent_reauth_from_tdata` | 2 | index.ts → src/core/tg-agent-reauth-from-tdata/run.ts |
