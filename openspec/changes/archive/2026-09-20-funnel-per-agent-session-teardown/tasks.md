## 1. Реализация (выполнено и задеплоено)

- [x] 1.1 Добавить `TelegramService.disconnectAgent(agentId)` — рвёт клиента только текущего аккаунта, пауза `POST_DISCONNECT_DELAY` перед снятием замка, guard `this.agentId === agentId`, no-op без живого клиента
- [x] 1.2 Добавить опцию `CollectOptions.disconnectAfterEachAgent` в `funnel-collect.ts` и вызывать `tg.disconnectAgent(agentId)` в конце тела цикла по агентам
- [x] 1.3 Передать `disconnectAfterEachAgent: true` из `funnel-tracker.ts`
- [x] 1.4 Поднять `TimeoutStartSec` до 2700 с в `deploy/systemd/tg-funnel-tracker.service`
- [x] 1.5 Задеплоить файлы в каталог плагина, `chown root:root`, `systemctl daemon-reload`

## 3. Архивация

- [x] 3.1 Заархивировать change (`/opsx:archive`) — дельта `funnel-metrics` вливается в `openspec/specs/funnel-metrics/spec.md`
