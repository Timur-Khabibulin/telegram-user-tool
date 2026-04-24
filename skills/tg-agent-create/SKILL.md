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
- phoneNumber       — номер телефона аккаунта агента (формат +79001234567)
- apiId             — API ID с my.telegram.org
- apiHash           — API Hash с my.telegram.org
- deviceModel       — модель устройства (например: Samsung Galaxy S23)
- proxy.host        — хост прокси
- proxy.port        — порт прокси
- proxy.username    — логин прокси
- proxy.password    — пароль прокси
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

---

## Шаг 4 — Получить sessionString

### 4.1 Отправить код

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

Сохранить `phoneCodeHash` из ответа.

### 4.2 Запросить код у пользователя

**СТОП.** Напиши пользователю следующее сообщение и жди ответа. Не переходи к шагу 4.3 до получения кода:

```
Код отправлен в Telegram на номер <phoneNumber>.
Пришли код из Telegram.
Если на аккаунте включён 2FA — пришли также пароль.
```

### 4.3 Войти в аккаунт

```
tg_auth_sign_in(
  phoneNumber:   <phoneNumber>,
  phoneCodeHash: <phoneCodeHash из шага 4.1>,
  phoneCode:     <код от пользователя>,
  password:      <2FA пароль, если был прислан>
)
```

Сохранить `sessionString` из ответа.

Если ошибка — сообщить пользователю и завершить выполнение.

---

## Шаг 5 — Создать tg-account.json

Записать файл `~/.openclaw/workspace-<agentName>/tg-account.json` со всеми заполненными значениями:

```json
{
  "accountId": "<telegram_user_id>",
  "apiId": <apiId>,
  "apiHash": "<apiHash>",
  "sessionString": "<sessionString из шага 4.3>",

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

---

## Шаг 6 — Запросить системный промпт

**СТОП.** Напиши пользователю следующее сообщение и жди ответа. Не переходи к шагу 7 до получения текста:

```
Агент создан. Осталось настроить личность.
Пришли содержимое SOUL.md для агента <agentName> — это его системный промпт.
```

Записать полученный текст в файл `~/.openclaw/workspace-<agentName>/SOUL.md`.

---

## Шаг 7 — Перезапустить gateway

```bash
openclaw gateway restart
```

---

## Итог

Сообщить пользователю:

```
Агент <agentName> готов.
- TG-аккаунт: <telegram_user_id>
- Workspace: ~/.openclaw/workspace-<agentName>
- Управление через бота: <botToken первые 10 символов>...

Для дальнейшей настройки используй скилы: 
- join-queue-setup для вступления в чаты каналов 
- tg-cron-setup для запуска периодического мониторинга чатов
```

