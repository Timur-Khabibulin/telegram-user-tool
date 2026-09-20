# Tasks — guaranteed-proxy-on-connect

## 1. Probe-based подборщик (без tdata)

- [x] 1.1 `src/features/proxy/provision-via-probe.ts`: `provisionProxyViaProbe(agentId, country, maxCandidates, probe, log): Promise<ProxyConfig | null>`
      — `fetchAvailableMobileProxies(apiKey, country)` → `createProxyPicker` → до
      `maxCandidates`: взять кандидата → `toProxyConfig` → `probe(proxy)` → первый прошедший
      `saveProxyToAccountConfig(agentId, proxy)` и вернуть; иначе null. Verify передан
      коллбэком `probe` (а не `tg`), чтобы не создавать цикл импорта service↔proxy.
- [x] 1.2 Guard'ы как в `provisionProxyViaTdata`: нет `ASOCKS_API_KEY` → null+лог; пул
      исчерпан → null+лог. tdata НЕ требуется и не проверяется.
- [x] 1.3 apiId/apiHash для probe захватываются в коллбэке на стороне `ensureClient`
      (из `account`); страна — из текущего прокси через `parseProxyCountry(proxy.username, proxy.countryCode)`.

## 2. Probe-гейт в ensureClient

- [x] 2.1 `probeProxy` расширен опц. `maxAttempts`/`connectTimeoutMs` (дефолты 3/20с);
      probe-гейт зовёт его с **maxAttempts=2, connectTimeoutMs=10_000**.
- [x] 2.2 Гейт после `acquireSession`+валидации конфига, до боевого цикла: probe OK →
      боевой `connect` без изменений (бюджет 3×60с не тронут).
- [x] 2.3 probe FAIL (обе попытки) → `provisionProxyViaProbe(agentId, country, 10, probeOne, log)`;
      успех → `proxy = replacement` для боевого `connect`; null → отпустить лок и `throw ConnectTimeoutError`.
- [x] 2.4 Подбор триггерится ТОЛЬКО из probe-fail, не из провала боевого `connect`
      (боевой цикл при неуспехе падает как сегодня).
- [x] 2.5 Гейт только при `!override && lockAgentId && proxy` — прямые подключения без
      прокси и override-вызовы (провижининг) не регрессируют.

## 3. Свести дубль с reauth

- [x] 3.1 Проверено: reauth-путь идёт через `connectBootstrap` (tdata), НЕ через
      `ensureClient` — probe-гейт туда не попадает. Пути комплементарны (гейт = живые
      сессии/probe-verify; reauth = сломанные сессии/tdata-verify), дубля в коде нет,
      сводить нечего. Изменений не требуется.

## 4. Проверка

- [x] 4.1 Typecheck: `provision-via-probe.ts` — 0 ошибок; `service.ts` — только
      предсуществующие bigint/EntityLike (сдвиг номеров из-за гейта); по проекту 45 =
      baseline, новых ошибок нет.
