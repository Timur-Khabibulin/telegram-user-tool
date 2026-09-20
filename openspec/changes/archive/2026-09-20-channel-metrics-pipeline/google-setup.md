# Настройка доступа к Google-таблице (сервис-аккаунт)

Одноразовая операторская настройка под задачу 1.1. Делается под аккаунтом
`timur10x.com@gmail.com` (владелец таблицы). JSON-ключ показывать никому не нужно —
он кладётся только на VPS.

Целевая таблица: `https://docs.google.com/spreadsheets/d/1DetN5Vs6OUoXNQQfj6qF9IUIFx9PVdEj6qiNKxF2SJY/edit`
- **ID таблицы:** `1DetN5Vs6OUoXNQQfj6qF9IUIFx9PVdEj6qiNKxF2SJY`
- **Лист:** `all-processed-channels`

## A. Проект в Google Cloud

1. Открыть https://console.cloud.google.com, войти как `timur10x.com@gmail.com`.
2. В верхней панели выпадающий список проектов → **New Project**.
3. Имя, например `tg-channels-pipeline` → **Create**. Дождаться создания и выбрать
   этот проект в выпадающем списке.

## B. Включить Google Sheets API

1. Меню → **APIs & Services → Library**
   (прямая ссылка: https://console.cloud.google.com/apis/library).
2. Найти **Google Sheets API** → открыть → **Enable**.

> Drive API включать НЕ нужно — пишем в существующий лист, новых файлов не создаём.
> Экран согласия (OAuth consent screen) для сервис-аккаунта тоже не требуется.

## C. Создать сервис-аккаунт

1. **APIs & Services → Credentials → Create Credentials → Service account**
   (или **IAM & Admin → Service Accounts → Create service account**).
2. Имя, например `sheets-writer` → **Create and continue**.
3. Шаг «Grant this service account access to project» — **пропустить** (роли на
   уровне проекта не нужны: доступ к данным даётся шарингом таблицы, не IAM) →
   **Continue → Done**.
4. Скопировать **email сервис-аккаунта** — вид
   `sheets-writer@tg-channels-pipeline.iam.gserviceaccount.com`. Он понадобится в
   шаге E.

## D. Сгенерировать JSON-ключ

1. Открыть созданный сервис-аккаунт → вкладка **Keys**.
2. **Add key → Create new key → JSON → Create**.
3. Браузер скачает JSON-файл. Это **секрет**: не коммитить в репозиторий, не
   пересылать. Дальше он поедет на VPS (шаг F).

## E. Расшарить таблицу сервис-аккаунту

1. Открыть таблицу в браузере.
2. **Настройки Доступа (Share)** → в поле добавить **email сервис-аккаунта** из
   шага C.4.
3. Роль — **Редактор (Editor)**. Галочку «уведомить» можно снять → **Отправить/Готово**.

> Шаринг делает владелец таблицы (ты). Сервис-аккаунт не может быть «владельцем»,
> Редактора достаточно для чтения (дедуп) и дозаписи строк.

## F. Положить ключ на VPS и прописать в конфиг

Секреты проекта живут в `~/.openclaw/` (там же `secrets.env` и
`codex-auth/auth.json`), а НЕ в каталоге репозитория плагина. Каталог уже
существует — mkdir не нужен.

1. Скопировать JSON-ключ на сервер и ограничить права:
   ```
   scp -i ~/.ssh/vps_key google_sheets_key.json root@<VPS_HOST>:~/.openclaw/google-sheets-key.json
   ssh -i ~/.ssh/vps_key root@<VPS_HOST> "chmod 600 ~/.openclaw/google-sheets-key.json"
   ```
2. Прописать в `~/.openclaw/secrets.env` (по образцу `DEEPSEEK_API_KEY` и др.):
   ```
   GOOGLE_SHEETS_KEY_PATH=/root/.openclaw/google-sheets-key.json
   CHANNELS_SHEET_ID=1DetN5Vs6OUoXNQQfj6qF9IUIFx9PVdEj6qiNKxF2SJY
   CHANNELS_SHEET_NAME=all-processed-channels
   ```
   (точные имена переменных зафиксируем при реализации — задача 1.2; путь и
   параметры листа — эти)

## Проверка

После шагов A–F доступ считается настроенным, если сервис-аккаунт может прочитать
и дописать лист. Сквозная проверка — прогон пайплайна на малом CSV (задача 7.1):
дедуп читает колонку `link`, финальная запись дозаписывает строки. Если чтение/
запись падает с `403 PERMISSION_DENIED` — не расшарена таблица (шаг E) или email
сервис-аккаунта указан с опечаткой; `404` — неверный ID таблицы/имя листа.
