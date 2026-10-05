## Why

Сегодня монолитный скилл авторегистрации слитно делает и подготовку купленного
аккаунта, и применение персоны — из-за чего пул подготовленных аккаунтов нельзя
копить заранее, а число агентов и персона фиксируются в момент тяжёлой
подготовки, а не когда бизнес решил развернуть персону. Пул обезличенных
аккаунтов (`workspace-emptyAccount*`) уже существует и потребляется заменой
забаненных, но у него нет штатного производителя.

Полные требования — [requirements-v1.md](../../../docs/design/tg-agent-pool-provisioning/requirements-v1.md)
(R1–R30); архитектурные решения — [architecture.md](../../../docs/design/tg-agent-pool-provisioning/architecture.md).

## What Changes

- **Фаза 1 — производитель пула** (новый скилл/тул): из списка ссылок на tdata
  делает обезличенные пул-аккаунты `workspace-emptyAccount<K>` (прокси →
  bootstrap → чистка унаследованных публичных каналов → смена 2FA на общий →
  сброс чужих сессий → регистрация агентской сессии). Персону не применяет.
- **Фаза 2 — потребитель пула** (новый скилл/тул): по входу «персона + M» берёт
  M старейших пригодных пул-аккаунтов и через их агентскую сессию применяет
  персону (username, профиль, все фото, публичный канал + пост + закреп,
  инвайт-ссылка в общий приватный канал воронки), переводя в `workspace-agent<N>`.
  Частичный успех при нехватке до M; параллельные прогоны допустимы (атомарная
  выдача N).
- **Общая заготовка учётных данных**: `default_agent_data.json` (общие
  apiId/apiHash + общий 2FA) выносится из персоны в `account-defaults`; читает её
  только фаза 1.
- **BREAKING — вынос creds из персоны**: шаблон персоны больше не содержит
  apiId/apiHash/2fa.
- **BREAKING — депрекейт**: монолитный `tg-agent-autoregistration` (mode A/B) и
  `persona-channel-setup` помечаются `[DEPRECATED]`; их функции покрывают две
  новые фазы. Снятие — при архивации этого change, не сразу.
- **Правка замены забаненных**: пул теперь строго обезличен (без username), поэтому
  замена наделяет пул-аккаунт username персоны заменяемого агента при заборе;
  оба потребителя используют общий загрузчик пула и порядок «старейший первым».

## Capabilities

### New Capabilities
- `tg-agent-pool-provision`: фаза 1 — производство обезличенных пул-аккаунтов из
  tdata; также нормирует чтение общей заготовки `account-defaults`.
- `tg-agent-persona-deploy`: фаза 2 — развёртывание N агентов под персону из пула,
  с частичным успехом и параллельной атомарной нумерацией.

### Modified Capabilities
- `tg-agent-autoregistration`: депрекейт монолита (оба режима) — поведение
  замещается двумя новыми фазами.
- `persona-channel-setup`: депрекейт — поглощается фазой 2.
- `banned-account-replacement`: пул строго обезличен → username персоны
  применяется при заборе; общий загрузчик пула и порядок «старейший первым».
- `persona-template`: apiId/apiHash/2fa (`default_agent_data.json`) убираются из
  шаблона персоны в общую заготовку `account-defaults`.

## Impact

- Код: новые `src/features/tg-agent-pool-provision/`,
  `src/features/tg-agent-persona-deploy/`, общий `src/core/pool-accounts.ts` и
  `core/tdata/apply-persona.ts`; правки `banned-account-replacement/{run,swap}.ts`,
  `core/config.ts` (`loadPoolAccountConfig`, `loadAccountDefaults`),
  `persona-template.ts`, `index.ts` (+2 тула, депрекейт старых); два новых
  `SKILL.md` + ops-скрипты (detached, ADR 0008).
- Данные/ФС: новые `workspace-emptyAccount<K>` staging/promote; `account-defaults`
  в `~/.openclaw/` и репозитории.
- Совместимость: `tg-account.json` пул-аккаунта без persona/username; рабочий
  контур (`listAgentIds`) уже исключает пул.
