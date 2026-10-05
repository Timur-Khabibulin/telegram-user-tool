## 1. Генератор username канала

- [x] 1.1 Добавить генератор самостоятельного username канала: случайное человекочитаемое сочетание слов из словаря, без цифрового хвоста, не производное от username аккаунта и не связанное с персоной (ядро, рядом с `generateUsername`)
- [x] 1.2 Обеспечить достаточный запас пространства имён (3 слова ≈ 205k комбинаций), чтобы коллизии были редки

## 2. Создание/правка канала в account-setup.ts

- [x] 2.1 Выделить функцию `createTemplateChannel`: `channels.CreateChannel` + клейм случайного человекочитаемого username с ретраем на `USERNAME_OCCUPIED`/`USERNAME_INVALID`/`USERNAME_PURCHASE_AVAILABLE` + placeholder название/пост + привязка к профилю (`account.UpdatePersonalChannel`)
- [x] 2.2 Добавить функцию приведения существующего канала к персональным данным: `EditTitle` → `channelName`, `EditPhoto`, замена поста (зачистить историю + отправить персональный с инвайт-ссылкой); username канала и привязку к профилю не трогать (канал уже личный). Описание канала не задаётся — в шаблоне персоны нет такого поля (`about` всегда пуст)
- [x] 2.3 Реализовать шаг «найти → править, иначе создать» (`applyOrCreatePersonaChannel`): найти собственный канал через `users.GetFullUser(self).personalChannelId` → если непуст, править его (2.2); если пуст — создать прежним способом (`createPersonaChannel`)
- [x] 2.4 Реализовать зачистку истории (`clearTemplateChannelHistory`): удалить placeholder-пост и служебные об изменениях названия/фото через `channels.DeleteMessages` поштучно с игнором `MESSAGE_DELETE_FORBIDDEN`; не удалять `messageActionChannelCreate`

## 3. Фаза 1 (pool-provision)

- [x] 3.1 В `prepareEmptyPoolAccount` после гигиены вызвать `createTemplateChannel` на bootstrap-сессии
- [x] 3.2 Отказ создания канала (`USER_RESTRICTED` и пр.) оборачивается в `TdataSetupError` → `setup_failed`, аккаунт не входит в пул (существующая обработка в `processPoolAccount`)
- [x] 3.3 Инвариант готовности пул-аккаунта обновлён в спеке: ровно один обезличенный публичный канал, привязанный к профилю

## 4. Фаза 2 (persona-deploy / apply-persona)

- [x] 4.1 В `setupReplacementAccount` убран `deleteAdminedPublicChannels` (удалил бы шаблонный канал) и вызов создания заменён на `applyOrCreatePersonaChannel`; username/профиль/фото аккаунта без изменений
- [x] 4.2 Инвайт-ссылка вставляется в персональный пост через `buildPostTextWithInviteLink` (как в прежнем `createPersonaChannel`), `apply-persona.ts` передаёт ссылку без изменений
- [x] 4.3 Идемпотентность: повторный прогон правит уже персонализированный канал, зачистка истории удаляет прежний пост и публикует новый — итог один и тот же

## 5. Смежный потребитель (banned-account-replacement)

- [x] 5.1 `banned-account-replacement/run.ts:210` зовёт общий `applyPersonaToAccount` → `setupReplacementAccount` → `applyOrCreatePersonaChannel`: новый пул-аккаунт правится, аккаунт без шаблонного канала идёт по fallback «создать». Изменений в самом `banned-account-replacement` не требуется

## 6. Документация

- [x] 6.1 `docs/telegram-errors.md` — добавлен раздел «4. Создание публичного канала персоны», строка №36 `USER_RESTRICTED`: создание на bootstrap-сессии в фазе 1, правка в фазе 2

## 7. Проверка (требует прогона на VPS)

- [x] 7.1 Прогнать `tg-agent-pool-provision` на нескольких аккаунтах — убедиться, что шаблонные каналы создаются без `USER_RESTRICTED`
- [x] 7.2 Прогнать `tg-agent-persona-deploy` на этих аккаунтах — убедиться, что данные канала приводятся к персональным, пост с инвайт-ссылкой на месте, в истории канала нет служебных сообщений об изменении названия/фото (остаётся только «канал создан»)
