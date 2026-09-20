# Tasks — tg-autoreg-gdrive-2fa-input

## 1. Download-слой
- [x] 1.1 Диспетчер `downloadTdataArchive(link, destTdataDir)` в `run.ts`: детект вида ссылки (Mega folder / GDrive file), нераспознанный вид → ошибка аккаунта.
- [x] 1.2 GDrive-загрузчик: извлечь `FILE_ID`, скачать файл, обработать confirm-token для больших файлов, распознать HTML вместо ZIP (приватная ссылка) → понятная ошибка.
- [x] 1.3 Выбрать и подключить pure-JS ZIP-распаковщик (adm-zip); распаковать во временную папку, найти `tdata` рекурсивно (`findTdataDirOnDisk`).
- [x] 1.4 Существующий Mega-путь оставить как одну из веток диспетчера.

## 2. Метаданные аккаунта
- [x] 2.1 Убрать чтение `tdata/Accounts.txt` и `tdata/Password2FA.txt` в autoreg (для reauth-from-tdata `readTdataAccountInfo` сохранён — вне скоупа).
- [x] 2.2 `phoneNumber` — из `client.getMe().phone` (`readAccountPhone`) на bootstrap-сессии; прокинут в sign-in второй сессии.
- [x] 2.3 `currentPassword` для `change2FA` — из параметра `twoFaPassword`.

## 3. Параметры тула и скилла
- [x] 3.1 `index.ts`: `megaLinks` → `links`; новый обязательный `twoFaPassword`; описание обновлено.
- [x] 3.2 `SKILL.md`: обновлён Шаг 1 (`links` + `twoFaPassword`) и Шаг 2 (вызов тула).
- [x] 3.3 Pre-flight: диапазон id по числу `links`; валидация непустого `twoFaPassword` (стоп-прогон).

## 4. Зависимости
- [x] 4.1 Добавлен `adm-zip` (+ `@types/adm-zip`) в `package.json`, lock зафиксирован.

## 5. Ретрай-путь
- [x] 5.1 `tg_agent_autoregistration_retry_code`: не читает сайдкары, не пере-качивает архив; телефон приведён к `readAccountPhone` (getMe).

## 6. Проверка
- [x] 6.1 GDrive-загрузка + распаковка ZIP + поиск `tdata` проверены на реальной ссылке (скачано, распаковано, найдена `<accountN>/tdata`). Полный E2E создания агента (Telegram, прокси, шаблон персоны) — операторский прогон на VPS (реальные побочные эффекты).

## Прочее (typecheck)
- [x] Изменённые файлы проходят typecheck без ошибок (штатный `tsc`-путь сломан предсуществующим tsconfig `module:commonjs`+`bundler` — проверено через временный конфиг; рантайм идёт через `tsx`).
