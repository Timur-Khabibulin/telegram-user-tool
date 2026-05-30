## Why

Кратко - прогрев аккаунта. Telegram блокирует или ограничивает аккаунты c резкой активностью. Регулярное чтение чатов имитирует поведение живого пользователя и снижает риск заморозки аккаунта, который используется для автоматизации (мониторинг групп, рассылка DM).

## What Changes

- Новый скилл `account-warmup`: каждые 5 часов читает до 15 случайных групп/каналов с непрочитанными сообщениями и помечает их как прочитанные
- Новый скилл `account-warmup-cron-setup`: регистрирует cron-задачу прогрева на каждые 5 часов

## Capabilities

### New Capabilities

- `account-warmup`: алгоритм прогрева — получить диалоги с unread, выбрать 15 случайных, прочитать и пометить как прочитанные
- `account-warmup-cron-setup`: инструкция для агента по регистрации cron-задачи прогрева

### Modified Capabilities

## Impact

- Новые файлы: `skills/account-warmup/SKILL.md`, `skills/account-warmup-cron-setup/SKILL.md`
- Инструменты плагина (`telegram_get_dialogs`, `telegram_get_messages`, `telegram_mark_as_read`) уже существуют — изменений в `index.ts` не требуется