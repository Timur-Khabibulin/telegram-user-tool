## Why

`tg-agent-autoregistration` сейчас качает tdata-архивы только из Mega
(`megaLinks`, папка-share через `megajs`) и берёт метаданные аккаунта из
файлов-сайдкаров внутри tdata: телефон из `tdata/Accounts.txt`, текущий
2FA-пароль из `tdata/Password2FA.txt`. Поставки аккаунтов приходят в Google
Drive (одна ссылка на файл-ZIP на аккаунт), а 2FA-пароль у пачки общий и его
удобнее задавать разово оператором, а не полагаться на файл в архиве.

## What Changes

- **Источник архива — источник-агностичный.** Параметр скилла `megaLinks`
  заменяется на `links`: каждая ссылка — один аккаунт, как и раньше. Download-слой
  сам определяет вид ссылки: Mega folder-share (как сейчас, `megajs`) или Google
  Drive file-ссылка (`drive.google.com/file/d/<id>/...`). GDrive-файл — это
  ZIP-архив: скачивается, распаковывается, внутри ищется папка `tdata`.
- **2FA-пароль — из входа, а не из папки.** Новый обязательный параметр
  `twoFaPassword` (один на весь прогон). `tdata/Password2FA.txt` больше не
  читается.
- **Телефон — из самого аккаунта.** `phoneNumber` берётся через `getMe()` на
  bootstrap-сессии, а не из `tdata/Accounts.txt`. Оба txt-сайдкара
  (`Accounts.txt`, `Password2FA.txt`) больше не читаются — папка `tdata` нужна
  только как источник самой сессии.
- **Новая зависимость** — pure-JS распаковка ZIP (деплой без сборки/нативных
  модулей, см. design D3).

## Impact

- Спека: `tg-agent-autoregistration` (изменены требования по источнику архива,
  2FA и телефону).
- Скилл: `skills/tg-agent-autoregistration/SKILL.md` (параметры Шага 1).
- Код: `src/features/tg-agent-autoregistration/run.ts` (download-диспетчер,
  GDrive-загрузчик, распаковка), `src/core/tdata/` (убрать чтение сайдкаров,
  телефон из `getMe()`, 2FA параметром), `index.ts` (параметры тула + валидация),
  `package.json` (zip-зависимость).
- Обратная совместимость: параметр `megaLinks` переименован в `links` — ломающее
  изменение операторского интерфейса (осознанно, см. design D6).
