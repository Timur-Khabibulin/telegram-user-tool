# не забыть про настройку конфига, если доабвляется новый скил
- добавить в аналитику модель аудита/логов

# Командный деплой: миграция с ручного на CI/CD

Документ описывает переход от ручного деплоя (scp + SSH от root) к
автоматизированному через GitHub Actions с ограниченным доступом для разработчиков.

## Текущий деплой (один разработчик)

1. Локально: `scp` / skill `vps` → копирует `src/`, `index.ts`, `openclaw.json` на VPS
   в `~/openclaw-plugins/telegram-user-tool/`
2. SSH: `chown -R root:root ~/openclaw-plugins/telegram-user-tool`
3. SSH: `openclaw gateway restart`
4. Логи: только через SSH + `journalctl`

Проблемы при расширении команды:
- у всех должен быть root-ключ от сервера
- нет аудита «кто задеплоил»
- нет защиты данных агентов от случайных действий

---

## Целевая схема

```
Разработчик
    │ push / PR
    ▼
GitHub (main branch)
    │ merge
    ▼
GitHub Actions
    │ scp + ssh (deploy-ключ в Secrets)
    ▼
VPS: пользователь deploy (ограниченный sudo)
    │ rsync → chown → gateway restart
    ▼
OpenClaw + systemd запускают новый код
    │
    └── journald → Vector → Better Stack (веб-дашборд логов)
                              ▲
                     Разработчики смотрят здесь без SSH
```

**Что хранит только owner:** root SSH-ключ, `tg-account.json` агентов, `auth.json` LLM.  
**Что хранится в GitHub Secrets:** `VPS_HOST`, `DEPLOY_SSH_KEY`.  
**Что получает команда:** право деплоить через PR, просмотр логов в браузере.

---

## Шаги миграции

### 1. Deploy-пользователь на VPS

```bash
# на VPS от root
adduser --disabled-password deploy
mkdir -p /home/deploy/tg-tool-staging
```

Ограниченный sudo — только нужные команды:

```
# /etc/sudoers.d/deploy
deploy ALL=(ALL) NOPASSWD: \
  /usr/bin/rsync -a /home/deploy/tg-tool-staging/ /root/openclaw-plugins/telegram-user-tool/, \
  /bin/chown -R root:root /root/openclaw-plugins/telegram-user-tool, \
  /usr/local/bin/openclaw gateway restart, \
  /usr/bin/journalctl -u tg-agent@* *
```

### 2. SSH-ключ для деплоя

```bash
# локально
ssh-keygen -t ed25519 -f ~/.ssh/vps_deploy_key -C "github-actions-deploy"
# публичный ключ → на VPS в authorized_keys пользователя deploy
cat ~/.ssh/vps_deploy_key.pub | ssh -i ~/.ssh/vps_key root@<host> \
  "cat >> /home/deploy/.ssh/authorized_keys"
```

Приватный ключ добавить в GitHub: `Settings → Secrets → DEPLOY_SSH_KEY`.  
Туда же: `VPS_HOST` (IP или hostname сервера).

### 3. GitHub Actions workflow

Создать `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Copy files to VPS
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.VPS_HOST }}
          username: deploy
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          source: "src/,index.ts,openclaw.json,package.json,tsconfig.json,deploy/"
          target: "/home/deploy/tg-tool-staging/"

      - name: Post-deploy
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.VPS_HOST }}
          username: deploy
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            sudo rsync -a /home/deploy/tg-tool-staging/ /root/openclaw-plugins/telegram-user-tool/
            sudo chown -R root:root /root/openclaw-plugins/telegram-user-tool
            sudo openclaw gateway restart
```

### 4. Логи без SSH: Vector + Better Stack

Зарегистрироваться на [betterstack.com](https://betterstack.com) → создать источник → получить токен.

Установить Vector на VPS:

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://sh.vector.dev | bash
```

Конфиг `/etc/vector/vector.toml`:

```toml
[sources.journald]
type = "journald"
units = ["tg-agent@*.service", "tg-daily-summary.service", "tg-funnel-tracker.service"]

[sinks.logtail]
type = "http"
inputs = ["journald"]
uri = "https://in.logs.betterstack.com"
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "${LOGTAIL_TOKEN}"
```

```bash
# переменная окружения с токеном
echo "LOGTAIL_TOKEN=<token>" >> /etc/vector/vector.env
systemctl enable --now vector
```

Разработчики заходят на дашборд Better Stack — видят все логи агентов без SSH.

---

## Что разработчик может и не может

| Действие | Разработчик | Owner |
|---|---|---|
| Задеплоить через PR | ✓ | ✓ |
| Просмотр логов (web UI) | ✓ | ✓ |
| SSH на сервер | — | ✓ |
| Данные агентов (`workspace-*`) | — | ✓ |
| Секреты (`tg-account.json`, `auth.json`) | — | ✓ |
| Изменить systemd-юниты | — | ✓ |

---

## Порядок применения

1. Создать `deploy`-пользователя, настроить `sudoers`
2. Сгенерировать deploy-ключ, добавить в GitHub Secrets
3. Добавить `.github/workflows/deploy.yml` и запушить в `main`
4. Проверить, что Actions отработал и OpenClaw перезапустился
5. Поднять Vector + Better Stack, проверить что логи появляются
6. Убрать root-ключ из общего доступа