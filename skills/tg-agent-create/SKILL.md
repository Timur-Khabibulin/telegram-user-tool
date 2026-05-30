---
name: tg-agent-create
description: "Full setup skill: creates a new Telegram agent from scratch. Registers the TG account in OpenClaw, creates the agent, obtains a session string via auth tools, writes tg-account.json, and prompts for SOUL.md. Use when the user wants to add a new Telegram agent to the OpenClaw platform."
---

# Telegram agent create

## Чек-лист подготовки

Перед запуском убедись, что пользователь выполнил всё вручную:

- [ ] Создан socks5 прокси
- [ ] Настроен эмулятор с прокси, TG-аккаунт зарегистрирован
- [ ] Получены API-ключи на https://my.telegram.org/auth

---

## Шаг 1 — Запросить все данные

Сообщи пользователю, что нужны следующие данные, и жди одного ответа:

```
Для создания агента нужны следующие данные — скинь их одним блоком:

- agentName         — имя агента на английском (используется как идентификатор)
- telegram_user_id  — ID TG-аккаунта агента (узнать в @userinfobot)
- apiId             — API ID с my.telegram.org
- apiHash           — API Hash с my.telegram.org
- deviceModel       — модель устройства (например: Samsung Galaxy S23)
- proxy.host        — хост прокси
- proxy.port        — порт прокси
- proxy.username    — логин прокси
- proxy.password    — пароль прокси
- sessionString     — (опционально) готовая сессия. Если есть — aвторизация пропускается. Если нет — нужен также:
- phoneNumber       — номер телефона аккаунта агента (формат +79001234567)
```

Запомни все полученные значения — они используются на следующих шагах.

---

## Шаг 2 — Зарегистрировать аккаунт в OpenClaw

Посмотреть текущий список разрешённых ID:

```bash
openclaw config get channels.telegram.accounts.agentsBot.allowFrom
```

Взять полученный массив, добавить в него `<telegram_user_id>` и перезаписать:

```bash
openclaw config set channels.telegram.accounts.agentsBot.allowFrom '[<все элементы из предыдущего шага>, "<telegram_user_id>"]'
```


---

## Шаг 3 — Создать агента и файловую структуру

Создать агента
```bash
openclaw agents add <agentName> \
  --workspace ~/.openclaw/workspace-<agentName> \
  --agent-dir ~/.openclaw/agents/<agentName>/agent \
  --model openai-codex/gpt-5.4 \
  --json
```

Посмотреть текущие биндинги и определить следующий индекс:

```bash
openclaw config get bindings --json | python3 -c "import sys,json; print(len(json.load(sys.stdin)))"
```

Добавить биндинг по следующему индексу (например, если сейчас 2 элемента — индекс `2`):

```bash
openclaw config set bindings[<следующий_индекс>] '{"agentId":"<agentName>","match":{"channel":"telegram","accountId":"agentsBot","peer":{"kind":"direct","id":"<telegram_user_id>"}}}'
```

Создать директорию агента:

```bash
mkdir -p ~/.openclaw/agents/<agentName>/agent
```

Скопировать конфиги из main-агента:

```bash
cp ~/.openclaw/agents/main/agent/auth-profiles.json ~/.openclaw/agents/<agentName>/agent/
cp ~/.openclaw/agents/main/agent/models.json ~/.openclaw/agents/<agentName>/agent/
```

Создать `AGENTS.md` со следующим содержимым:

```bash
cat > ~/.openclaw/workspace-<agentName>/AGENTS.md << 'EOF'
## Session Startup
Сначала прочитай:
1. SOUL.md — это кто я, мой стиль общения и строгие правила
2. MEMORY.md + memory/сегодня.md

Всегда строго следуй абослютно всем правилам из SOUL.md.
EOF
```

Создать пустые workspace-файлы:

```bash
touch ~/.openclaw/workspace-<agentName>/HEARTBEAT.md
touch ~/.openclaw/workspace-<agentName>/SOUL.md
touch ~/.openclaw/workspace-<agentName>/USER.md
touch ~/.openclaw/workspace-<agentName>/BOOTSTRAP.md
touch ~/.openclaw/workspace-<agentName>/IDENTITY.md
touch ~/.openclaw/workspace-<agentName>/TOOLS.md
touch ~/.openclaw/workspace-<agentName>/MEMORY.md
```

Перейти к шагу 3.1

### 3.1 Промежуточный статус

**СТОП.** Напиши пользователю короткое сообщение и продолжай дальше:

```
Аккаунт зарегистрирован, агент и файловая структура созданы. Перехожу к авторизации Telegram-сессии.
```

Если в Шаге 1 был передан `sessionString` — текст замени на:

```
Аккаунт зарегистрирован, агент и файловая структура созданы. Перехожу к записи tg-account.json.
```

Перейти к шагу 3.2
---

## 3.2 Развилка после Шага 3.1

Если в данных из Шага 1 присутствует `sessionString` — **пропустить Шаг 4** и перейти сразу к Шагу 5, используя эту строку как sessionString.

Если `sessionString` не был передан — выполнить Шаг 4.

---

## Шаг 4 — Получить sessionString

### 4.1 Отправить код

**СТОП.** Напиши пользователю короткое сообщение и продолжай дальше:

```
Отправляю код на номер <phoneNumber>. Инструмент сделает до 3 попыток по 30 секунд каждая.
```

Вызвать:

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

Ждать ответа. Если пользователь соглашается — повторить вызов шаг 4.1. Если отказывается — завершить выполнение.

Если успех — сохранить `phoneCodeHash` из ответа и перейти к шагу 4.2.

### 4.2 Запросить код у пользователя

**СТОП.** Напиши пользователю следующее сообщение и жди ответа. Не переходи к шагу 4.3 до получения кода:

```
Код отправлен в Telegram на номер <phoneNumber>.
Пришли код из Telegram.
Если на аккаунте включён 2FA — пришли также пароль.
```

### 4.3 Войти в аккаунт

Перед вызовом напиши пользователю:

```
Выполняю вход. Инструмент сделает до 3 попыток по 60 секунд каждая.
```

Вызвать:

```
tg_auth_sign_in(
  phoneNumber:   <phoneNumber>,
  phoneCodeHash: <phoneCodeHash из шага 4.1>,
  phoneCode:     <код от пользователя>,
  password:      <2FA пароль, если был прислан>
)
```

Если ответ содержит поле `error`:

**СТОП.** Напиши пользователю:

```
Не удалось войти в аккаунт. Ошибка: <error из ответа>

Повторить попытку? Если код уже истёк — нужно будет запросить новый (вернуться к шагу 4.1).
```

Ждать ответа пользователя:
- Если соглашается повторить с тем же кодом — повторить вызов `tg_auth_sign_in`
- Если код истёк или пользователь хочет новый — вернуться к шагу 4.1
- Если отказывается — завершить выполнение

Если успех — сохранить `sessionString` из ответа и перейти к шагу 5.

---

## Шаг 5 — Создать tg-account.json

Записать файл `~/.openclaw/workspace-<agentName>/tg-account.json` со всеми заполненными значениями:

```json
{
  "accountId": "<telegram_user_id>",
  "apiId": <apiId>,
  "apiHash": "<apiHash>",
  "sessionString": "<sessionString из шага 1 (если был передан) или из шага 4.3>",

  "device": {
    "deviceModel": "<deviceModel>",
    "systemVersion": "Android 14",
    "appVersion": "10.3.2",
    "langCode": "ru",
    "systemLangCode": "ru"
  },

  "proxy": {
    "type": "socks5",
    "host": "<proxy.host>",
    "port": <proxy.port>,
    "username": "<proxy.username>",
    "password": "<proxy.password>"
  }
}
```
Перейти к шагу 6
---

## Шаг 6 — Запросить системный промпт

**СТОП.** Напиши пользователю следующее сообщение и жди ответа. Не переходи к шагу 7 до получения текста:

```
Агент создан. Осталось настроить личность.
Пришли содержимое SOUL.md для агента <agentName> — это его системный промпт.
```

Записать полученный текст в файл `~/.openclaw/workspace-<agentName>/SOUL.md`.

Перейти к шагу 7
---

## Шаг 7 — Проверка установки

Все проверки выполняются одним скриптом. Агент подставляет реальные значения **только в двух местах** — после `bash` идут `<agentName>` и `<telegram_user_id>` из Шага 1

```bash
bash ~/.openclaw/workspace/skills/tg-agent-create/scripts/verify-agent.sh '<agentName>' '<telegram_user_id>'
```

**СТОП.** Обязательно скопируй вывод скрипта в сообщение пользователю как есть. Не прерывай скилл даже при FAIL — переходи к Шагу 8.

---

## 8. Итог

**СТОП.** Обязательно напиши пользователю финальное сообщение:

```
Агент <agentName> готов.
- TG-аккаунт: <telegram_user_id>
- Workspace: ~/.openclaw/workspace-<agentName>

Перед работой с агентом не забудь перезапустить gateway командой `openclaw gateway restart`
```

