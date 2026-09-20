# Tasks — tg-autoreg-optional-channel-and-setup-skill

## 1. Флаг создания канала в реге
- [x] 1.1 `prepareAccount` (`account-setup.ts`): параметр `createPublicChannel`, шаг `createPersonaChannel` условный.
- [x] 1.2 `run.ts`: флаг в `RunParams` → `processAccount` → `prepareAccount`; CLI-обёртка `--create-public-channel` (default true).
- [x] 1.3 `index.ts`: `createPublicChannel` (Optional Boolean, default true) у `tg_agent_autoregistration_run`.
- [x] 1.4 `SKILL.md` (autoregistration): флаг и два режима (A/B).
- [x] 1.5 `loadPersonaTemplate(personName, requireChannel)`: канальные файлы (`post.txt`/`channel_photo`/`channel_post_photo`) и `channelName` обязательны только при requireChannel; `SOUL.md` больше не обязателен. Пре-флайт реги передаёт `createPublicChannel`; retry → false; channel-setup и service (fixChannelTitleAndRepost/setupPersonaChannel) → true. Консьюмеры канальных полей (`createPersonaChannel`, `fixChannelTitleAndRepost`) получили guard (поля стали `string|null`). Фикс бага: mode A падал на отсутствии `post.txt`.

## 2. Новый скилл создания канала
- [x] 2.1 `features/tg-agent-channel-setup/run.ts`: `tg_agent_channel_setup(agentIds)` — по каждому загрузить `tg-account.json`, подключиться через сессию агента (`TelegramService.withActiveClient`).
- [x] 2.2 Guard: пропуск агентов с уже установленным personal-каналом (`getOwnPersonalChannel` → `skipped`).
- [x] 2.3 Создание через `createPersonaChannel` (persona/username из `tg-account.json`).
- [x] 2.4 Batch-изоляция + сводка (`done`/`skipped`/`failed`), teardown `disconnectAgent`.
- [x] 2.5 `index.ts`: регистрация тула `tg_agent_channel_setup`.
- [x] 2.6 `skills/tg-agent-channel-setup/SKILL.md` (skills авто-грузятся из workspace/skills — в openclaw.json не прописываем).

## 3. Проверка
- [x] 3.0 Typecheck изменённых файлов — без новых ошибок (штатный `tsc` сломан предсуществующим tsconfig; проверено через временный конфиг; рантайм — `tsx`).
