## 1. Скилл account-warmup

- [x] 1.1 Создать `skills/account-warmup/SKILL.md` с алгоритмом прогрева
- [x] 1.2 Описать шаг загрузки конфигурации аккаунта (`tg_load_account`)
- [x] 1.3 Описать получение диалогов (`telegram_get_dialogs`) и shuffle с лимитом 15
- [x] 1.4 Описать цикл обработки каждого чата: `telegram_get_messages` → `telegram_mark_as_read`
- [x] 1.5 Описать обработку ошибок: FLOOD_WAIT (ждать + retry), прочие ошибки (skip + next)
- [x] 1.6 Описать паузы между чатами (2–5 секунд)

## 2. Скилл account-warmup-cron-setup

- [x] 2.1 Создать `skills/account-warmup-cron-setup/SKILL.md`
- [x] 2.2 Описать шаги регистрации cron-задачи с расписанием каждые 5 часов
- [x] 2.3 Описать проверку на существующую задачу и защиту от дубликатов