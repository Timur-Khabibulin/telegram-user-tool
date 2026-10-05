## REMOVED Requirements

<!--
Монолитный tg-agent-autoregistration (mode A/B) выводится из употребления: его
поведение расщеплено на две новые способности — tg-agent-pool-provision (фаза 1,
подготовка обезличенного аккаунта) и tg-agent-persona-deploy (фаза 2, развёртывание
персоны из пула). До архивации этого change тулы/скилл помечены [DEPRECATED];
архивация снимает требования ниже. Общий Reason/Migration для всех.
-->

### Requirement: Pre-flight validation before any account processing
**Reason**: Монолит заменён двумя фазами; pre-flight фазы 1 нормирован в `tg-agent-pool-provision`.
**Migration**: Используйте `tg-agent-pool-provision` (подготовка) + `tg-agent-persona-deploy` (персона).

### Requirement: One tdata archive maps to exactly one account
**Reason**: Скачивание tdata переехало в фазу 1.
**Migration**: `tg-agent-pool-provision` — «Один tdata-архив на один аккаунт, скачивание в стейджинг».

### Requirement: Mobile proxy selection per account
**Reason**: Подбор прокси переехал в фазу 1.
**Migration**: `tg-agent-pool-provision` — «Подбор мобильного прокси на аккаунт».

### Requirement: Bootstrap session decrypted from tdata
**Reason**: Bootstrap из tdata переехал в фазу 1.
**Migration**: `tg-agent-pool-provision` — «Bootstrap-сессия из tdata».

### Requirement: Account setup on the bootstrap session
**Reason**: Гигиена и применение персоны разделены между фазой 1 и фазой 2.
**Migration**: Гигиена — `tg-agent-pool-provision`; персона — `tg-agent-persona-deploy`.

### Requirement: Unique, human-readable account identity per persona
**Reason**: Username персоны применяется в фазе 2 (и при замене забаненных).
**Migration**: `tg-agent-persona-deploy` — «Применение персоны сессией агента».

### Requirement: Second MTProto session registered for platform use
**Reason**: Вторая сессия регистрируется в фазе 1.
**Migration**: `tg-agent-pool-provision` — «Вторая (агентская) сессия для пул-аккаунта».

### Requirement: Non-done accounts stay in staging until manually resolved
**Reason**: Удержание неуспешных в стейджинге нормировано в фазе 1.
**Migration**: `tg-agent-pool-provision` — «Терминальные статусы и удержание неуспешных в стейджинге».

### Requirement: Second-session retry for accounts stuck on needs_manual_code
**Reason**: Ретрай второй сессии переехал в фазу 1.
**Migration**: `tg-agent-pool-provision` — «Ретрай второй сессии для needs_manual_code».

### Requirement: Completed accounts are promoted atomically
**Reason**: Атомарный промоушен нормирован пофазно (пул — фаза 1, агент — фаза 2).
**Migration**: `tg-agent-pool-provision` (в пул) и `tg-agent-persona-deploy` (в агента).

### Requirement: Batch summary report
**Reason**: Отчёт нормирован в обеих новых фазах.
**Migration**: Требования «отчёт» в `tg-agent-pool-provision` и `tg-agent-persona-deploy`.

### Requirement: Detached execution not bound by the agent tool-call watchdog
**Reason**: Detached-исполнение (ADR 0008) нормировано в обеих новых фазах.
**Migration**: Требования «Detached-исполнение» в новых способностях.

### Requirement: Account phone and current 2FA obtained without tdata sidecar files
**Reason**: Телефон через `getMe()` и current-2FA от оператора нормированы в фазе 1.
**Migration**: `tg-agent-pool-provision` — «Bootstrap-сессия из tdata» и «Гигиена аккаунта».
