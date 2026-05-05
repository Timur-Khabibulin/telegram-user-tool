## ADDED Requirements

### Requirement: Cron-setup skill registers account-warmup on a 5-hour schedule

Скилл `account-warmup-cron-setup` SHALL содержать инструкцию для агента по регистрации cron-задачи, запускающей `account-warmup` каждые 5 часов.

#### Scenario: Успешная регистрация cron-задачи

- **WHEN** агент выполняет скилл `account-warmup-cron-setup`
- **THEN** создаётся cron-задача с расписанием «каждые 5 часов» и промптом, запускающим скилл `account-warmup`

#### Scenario: Задача уже существует

- **WHEN** cron-задача с таким именем уже зарегистрирована
- **THEN** агент сообщает об этом и не создаёт дубликат