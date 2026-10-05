## Context

Полный design-doc (HOW) — [architecture.md](../../../docs/design/tg-agent-pool-provisioning/architecture.md);
требования (ЧТО) — [requirements-v1.md](../../../docs/design/tg-agent-pool-provisioning/requirements-v1.md).
Здесь фиксируются только ключевые решения и trade-offs уровня change; детали
факторинга, псевдокод и карты вызовов — в `architecture.md`, не дублируются.

Пул обезличенных аккаунтов `workspace-emptyAccount*` уже существует и потребляется
`banned-account-replacement` (`listPoolAccountIds`, `claimPoolAccount`). У него нет
штатного производителя — монолитная авторегистрация делает сразу полноценных
`workspace-agent<N>`. Этот change достраивает производителя (фаза 1) и второго
потребителя (фаза 2), унифицируя persona-часть с заменой забаненных.

## Goals / Non-Goals

**Goals:**
- Два независимых, вызываемых из OpenClaw скилла/тула: фаза 1 (продюсер пула) и
  фаза 2 (потребитель пула), поверх общего ядра — по образцу существующих
  detached one-shot операций (ADR 0008), без LLM-цикла.
- Переиспользовать существующий код, а не писать второй: persona-часть фазы 2 =
  тот же `applyPersonaToAccount`, что и у `banned-account-replacement`.
- Строго обезличенный пул: `tg-account.json` без `persona`/`username`.
- Депрекейт монолита и `persona-channel-setup` без резкого сноса (снятие при
  архивации change).

**Non-Goals:**
- Переделка модели воронки: приватный канал остаётся ОДИН общий
  (`FUNNEL_PRIVATE_CHANNEL_ID`), фаза 2 лишь генерит инвайт-ссылку — отдельный
  приватный канал на агента не создаётся.
- Персистентный high-water-mark меток пула: `emptyAccount<K>` = max присутствующих
  + 1, переиспользование меток во времени допустимо.
- Изменение рабочего контура: `listAgentIds` уже исключает `workspace-emptyAccount*`.

## Decisions

- **D1. Разрез `prepareAccount` на гигиену и персону.** Фаза 1 — новый экспорт
  `prepareEmptyPoolAccount` (удаление унаследованных каналов → смена 2FA → сброс
  сессий), без фото/профиля/username/канала. Фаза 2 и замена забаненных — общий
  `applyPersonaToAccount` (профиль/фото/username/публичный канал/инвайт-ссылка)
  сессией агента. Альтернатива (две отдельные реализации persona-части) отклонена:
  R20 требует паритета с заменой, код уже написан в `setupReplacementAccount`.
- **D2. account-defaults вне персоны.** `apiId`/`apiHash`/2FA переезжают в
  `~/.openclaw/account-defaults/default_agent_data.json`; читает только фаза 1.
  Значения и так были идентичны у всех персон — это пул-константы, а не свойство
  персоны.
- **D3. Отдельный `loadPoolAccountConfig` (E-b).** Рабочий `loadAccountConfig`
  остаётся строгим (требует `persona`); пул читается узким загрузчиком без
  `persona`/`username`. Выбрано координатором вместо `persona?`+`requirePersona`
  ради явного разделения контуров; trade-off — дублирование парсинга proxy/device.
- **D4. Атомарная выдача N + атомарный claim пула (M4).** Параллельные прогоны
  фазы 2 допустимы: claim пул-аккаунта и claim номера `workspace-agent<N>.incoming`
  — два независимых атомарных `rename`, коллизии детектятся по `ENOENT`/
  `ENOTEMPTY`. Альтернатива (сериализация прогонов) отклонена как избыточная.
- **D5. Общий примитив пула.** `listPoolAccountsOldestFirst` + `claimPoolAccountTo`
  выносятся в `core/pool-accounts.ts` и используются и фазой 2, и заменой
  забаненных — единый порядок «старейший первым».
- **D6. Депрекейт H-b.** Старые тулы/скиллы/спеки помечаются `[DEPRECATED]`,
  код/регистрации живут до архивации этого change (монолит — единственный
  обкатанный на реальных tdata путь). Удаление — при `openspec archive`.

## Risks / Trade-offs

- **Idle-сессия пул-аккаунта.** Долго лежащий в пуле аккаунт с неиспользуемой
  сессией может быть погашен Telegram → фаза 2 валидирует аккаунт при заборе
  (`account_invalid` + карантин, берётся следующий).
- **Переиспользование метки `emptyAccount<K>` после полного слива пула.** Метка
  транзиентна (при потреблении каталог переименовывается), коллизии на ФС нет;
  риск принят координатором.
- **Дублирование чтения конфига (D3).** Приемлемо по решению координатора ради
  строгости рабочего загрузчика.
- **Гонки claim при параллельных прогонах.** → атомарные `rename` с детектом
  `ENOENT`/`ENOTEMPTY`; осиротевшие `.incoming`/temp восстанавливаются на следующем
  прогоне.
- **BREAKING: вынос creds из персон необратим** (подтверждено координатором) →
  выполняется как явный шаг миграции с бэкапом заготовки.

## Migration Plan

1. Создать `account-defaults/` (репозиторий-исходник + `~/.openclaw/`), перенести
   `apiId`/`apiHash`/2FA из персон; убрать `default_agent_data.json` из папок персон.
2. Выкатить общее ядро (`pool-accounts.ts`, `apply-persona.ts`,
   `loadPoolAccountConfig`, `loadAccountDefaults`) и правку `banned-account-replacement`.
3. Выкатить фазу 1 и фазу 2 (features + ops-скрипты + SKILL.md + 2 тула в `index.ts`).
4. Пометить монолит и `persona-channel-setup` `[DEPRECATED]`; старый путь остаётся
   рабочим fallback до архивации.
5. Rollback: заготовка `account-defaults` обратима восстановлением
   `default_agent_data.json` в персонах из бэкапа; новые фичи изолированы, старый
   путь не тронут до архивации.

## Open Questions

- **M2** — якорь возраста пула: ctime каталога vs `createdAt` в конфиге (минор,
  решается на реализации).
- **M3** — точный дом общего примитива claim (`core/pool-accounts.ts` vs вынос из
  `swap.ts`) — уточняется при рефакторинге.
