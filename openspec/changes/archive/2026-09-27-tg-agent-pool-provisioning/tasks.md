## 1. Общая заготовка учётных данных (account-defaults)

- [x] 1.1 Создать репозиторий-исходник `persona/account-defaults/default_agent_data.json` с общими `apiId`/`apiHash`/2FA
- [x] 1.2 Добавить `loadAccountDefaults()` в `core/config.ts` (чтение `~/.openclaw/account-defaults/default_agent_data.json`)
- [x] 1.3 Убрать `defaultAgentData` из `PersonaTemplate` и загрузчика персоны (`tg-agent-autoregistration/persona-template.ts`), убрать `default_agent_data.json` из папок персон в репозитории
- [x] 1.4 Обновить обращения к `apiId`/`apiHash`/2FA на `loadAccountDefaults()` там, где раньше брались из персоны (включая обнаруженный 4-й потребитель — `tg-agent-reauth-from-tdata/run.ts`)

## 2. Общее ядро пула

- [x] 2.1 Создать `core/pool-accounts.ts`: `listPoolAccountsOldestFirst`, `claimPoolAccountTo`, `quarantinePoolAccount`, `generateUsername`
- [x] 2.2 Добавить `loadPoolAccountConfig`/`PoolAccountConfig` в `core/config.ts` (creds/proxy/device без `persona`/`username`); ветку `TelegramService.loadAccount(id, { pool: true })`
- [x] 2.3 Вынести persona-часть в общий `applyPersonaToAccount` (`features/persona-apply/apply-persona.ts`: профиль/фото/username/публичный канал/инвайт-ссылка сессией агента)
- [x] 2.4 Разрезать `core/tdata/account-setup.ts`: новый экспорт `prepareEmptyPoolAccount` (удаление унаследованных каналов → смена 2FA → сброс сессий), без фото/персоны

## 3. Правка banned-account-replacement

- [x] 3.1 Перевести выбор пула на `listPoolAccountsOldestFirst` и общий `claimPoolAccountTo`
- [x] 3.2 В `run.ts`: username персоны генерируется и персистится при активации (пул безымянный); `swap.ts` не копирует `username` из пула; общий `applyPersonaToAccount`

## 4. Фаза 1 — продюсер пула

- [x] 4.1 Создать `features/tg-agent-pool-provision/run.ts`: pre-flight (account-defaults + свободность метки), скачивание в стейджинг, цикл по аккаунтам, прокси+bootstrap+`prepareEmptyPoolAccount`+вторая сессия
- [x] 4.2 Создать `features/tg-agent-pool-provision/staging.ts`: `staging/emptyAccount<K>` → атомарный `workspace-emptyAccount<K>`, нумерация K = max присутствующих + 1
- [x] 4.3 Перенести `retryManualCode` в фазу 1
- [x] 4.4 Терминальные статусы (`done`/`proxy_failed`/`setup_failed`/`needs_manual_code`) и отчёт в Saved Messages `REPORT_AGENT_ID`
- [x] 4.5 Ops-скрипт `src/scripts/ops/tg-agent-pool-provision.ts` (detached-вход, внутренний жёсткий таймаут — ADR 0008)

## 5. Фаза 2 — потребитель пула

- [x] 5.1 Создать `features/tg-agent-persona-deploy/run.ts`: цикл добора до M, claim+валидация пула, `applyPersonaToAccount`, промоушен в `workspace-agent<N>`
- [x] 5.2 Атомарная выдача N (claim `workspace-agent<N>.incoming` от `computeNextAgentNumber()` вверх, инкремент при занятости) — безопасно при параллельных прогонах
- [x] 5.3 Частичный успех при нехватке пула; статусы `done`/`setup_failed`/`account_invalid`; итоговая строка отчёта (запрошено/создано/нехватка) в Saved Messages
- [x] 5.4 Осиротевшие `.incoming` инертны и не коллизят: `computeNextAgentNumber`/атомарный claim пропускают занятые номера; авто-удаления нет — оставляются оператору наравне с `setup_failed` (единый инвариант «неуспешное до ручного разбора»)
- [x] 5.5 Ops-скрипт `src/scripts/ops/tg-agent-persona-deploy.ts` (detached-вход, внутренний жёсткий таймаут — ADR 0008)

## 6. OpenClaw-поверхность и депрекейт

- [x] 6.1 Зарегистрировать 2 тула в `index.ts` (фаза 1 / фаза 2), тонкие обёртки над `run.ts`
- [x] 6.2 Создать `skills/tg-agent-pool-provision/SKILL.md` и `skills/tg-agent-persona-deploy/SKILL.md`
- [x] 6.3 Пометить `[DEPRECATED]` тулы `tg_agent_autoregistration_run`/`..._retry_code`/`tg_agent_channel_setup`, их скиллы и записи в `index.ts` (код/регистрации остаются до архивации)

## 7. Документация

- [x] 7.1 Обновить `docs/operation.md`/`docs/configuration.md`: пути `workspace-emptyAccount*`, `account-defaults/`, systemd-вход двух фаз
- [x] 7.2 `docs/task-scheduling.md` правок не требует (обе фазы — operator-triggered detached, не задачи диспетчера); ключевые пути/потоки отражены в `operation.md`/`configuration.md` (7.1)
