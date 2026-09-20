## Why

Мобильные прокси asocks интермиттентно перестают пробрасывать туннель до Telegram
(порт открыт, MTProto-хендшейк не проходит) — это подтверждено данными: connect-timeout'ы
в funnel-tracker бьют конкретные прокси-IP независимо от нагрузки, а `probeProxy` по
когорте показал мёртвые и флейки-прокси при живых аккаунтах. Сейчас `ensureClient`
просто ретраит один и тот же (возможно мёртвый) прокси и падает. Нужно гарантировать
подключение: не входить в аккаунт через заведомо мёртвый прокси, а при его отказе —
подобрать рабочий до входа.

## What Changes

- **Probe-гейт перед каждым подключением.** В единой точке подключения `ensureClient`
  (её используют диспетчер, скиллы, скрипты, gateway, funnel, reauth — комментарий в
  service.ts подтверждает «точка одна на всех»), внутри уже существующего per-agent
  лока, перед боевым `connect` проверять текущий прокси через `probeProxy`
  (MTProto-хендшейк к Telegram DC, пустая сессия, **без tdata**), **2 попытки × 10с**.
- **Подбор рабочего прокси при провале probe.** Если обе попытки probe неуспешны —
  подобрать рабочий прокси: до **10 кандидатов** из инвентаря asocks, каждый
  проверяется тем же `probeProxy` (без tdata). Первый прошедший записывается в
  `tg-account.json` (swap `proxy`) и используется дальше — флот самолечится, следующий
  вход уже через живой прокси.
- **Терминальный отказ.** Если все 10 кандидатов не прошли (или нет `ASOCKS_API_KEY`/
  инвентарь пуст) — `ensureClient` бросает ошибку, прогон завершается с ошибкой (как
  обычный неуспех подключения сегодня).
- **Правила:** probe строго перед каждым входом (без last-good кэша); подбор триггерит
  **только** провал probe, не провал боевого `connect` (бюджеты раздельны — боевой
  `connect` сохраняет свой текущий бюджет 3×60с и поведение); verify кандидата всегда
  `probeProxy`, tdata не требуется.

## Capabilities

### New Capabilities
- `guaranteed-proxy-on-connect`: probe-гейт прокси и подбор рабочего прокси до входа в
  аккаунт, в единой точке `ensureClient`, для всех потребителей.

### Modified Capabilities
<!-- нет: capability mobile-proxy-provisioning переиспользуется как есть (инвентарь/пул),
     её требования не меняются -->

## Impact

- Код (правка): `src/core/telegram/service.ts` — `ensureClient`: probe-гейт (2×10с) +
  вызов probe-based подбора при провале, внутри лока; при исчерпании 10 — throw.
- Код (новое): probe-based подборщик рядом с `provisionProxyViaTdata`
  (`src/features/proxy/`) — `fetchAvailableMobileProxies`/`createProxyPicker` +
  `probeProxy` per кандидат + `saveProxyToAccountConfig`. В отличие от
  `provisionProxyViaTdata` verify через `probeProxy`, а не `connectBootstrap` (tdata не
  требуется).
- Переиспользуется: `probeProxy` (service.ts), `fetchAvailableMobileProxies`,
  `createProxyPicker`, `toProxyConfig`, `saveProxyToAccountConfig`, `parseProxyCountry`.
- Наблюдаемость: probe/подбор/swap логируются в тот же лог, что и `ensureClient`.
- Связка: `reauth-sweep-proxy-repair` (написан, не задеплоен) частично пересекается —
  его `connect_failed`-ветка подбора через tdata дублирует общий гейт; при реализации
  свести (для сломанных сессий tdata-verify остаётся оправдан, но точку подбора не
  плодить).
- Стоимость: +1 probe-хендшейк к Telegram на каждый вход (happy-path ~1–2с); при
  мёртвом прокси — до 10 probe-проверок кандидатов до входа (осознанная цена за
  гарантию).
