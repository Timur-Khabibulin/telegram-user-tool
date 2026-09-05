---
name: project_tg_agent_autoregistration_variant_a2_mtcute_convert
description: tg-agent-autoregistration explore — Вариант A2 (npm-пакет @mtcute/convert для расшифровки tdata), факты подтверждены прямым чтением исходников mtcute/mtcute на GitHub
type: project
---

Задача: tg-agent-autoregistration (explore-режим) — Вариант A2, использовать готовый
npm-пакет `@mtcute/convert` вместо ручной реализации расшифровки tdata (см.
[[project_tg_agent_autoregistration_tdata_risk]] про Вариант A — ручной парсинг).

Все факты ниже подтверждены прямым чтением исходников на
github.com/mtcute/mtcute (через GitHub Contents API, verbatim, не пересказ) и npm
registry на момент проверки (2026-08-11), пакет `@mtcute/convert@0.31.0`.

**Ключевая находка — путь сборки строки готов "из коробки", писать вручную не нужно:**
`convertFromTdata(tdataOptions, accountIdx=0): Promise<StringSessionData>`
(`packages/convert/src/tdesktop/convert.ts`) → `convertToGramjsSession(data): string`
(`packages/convert/src/gramjs/convert.ts`, вызывает `serializeGramjsSession` из
`gramjs/serialize.ts`). Обе функции — именованные экспорты верхнего уровня пакета
(`index.ts` реэкспортирует `tdesktop/index.js` и `gramjs/index.js`).

`serializeGramjsSession` собирает байты **побайтово идентично**
`node_modules/telegram/sessions/StringSession.js.save()` в этом проекте (сверено
построчно): `"1" + base64(dcId:1байт, ipLen:uint16BE, ip:utf8, port:uint16BE,
authKey:256байт)`. Это не предположение о совместимости — прямое построчное
сравнение двух реализаций.

**Точные типы (packages/core/src/highlevel/utils/string-session.ts,
packages/core/src/utils/dcs.ts):**
```
StringSessionData { version: number; primaryDcs: DcOptions; self?: CurrentUserInfo|null; authKey: Uint8Array }
DcOptions { main: BasicDcOption; media: BasicDcOption }
BasicDcOption { ipAddress: string; port: number; id: number; ipv6?: boolean; mediaOnly?: boolean; testMode?: boolean }
```
`authKey` — 256 байт (проверено и со стороны tdata-парсера: `read.exactly(bytes,256)`,
и со стороны сериализатора: throw если `authKey.length !== 256`).

**`primaryDcs.main.ipAddress` НЕ читается из tdata** — это статическая таблица
`DC_MAPPING_PROD[mainDcId]` (`packages/convert/src/dcs.ts`, только IPv4, 5 продакшн
DC захардкожены). tdata хранит только `dcId`, реальный IP из аккаунта не извлекается
и не нужен — GramJS сам резолвит DC по id/адресу при подключении.

**TdataOptions** (`packages/convert/src/tdesktop/tdata.ts`): `{path, fs?, crypto?,
ignoreVersion?, le?=true, dataKey?='data', passcode?}`. Всё кроме `path` опционально.
`accountIdx=0` → `dataName='data'` (без суффикса `#N`) — корректно для tdata с одним
аккаунтом (`Accounts.txt` с одной строкой), подтверждено кодом `getDataName`.
`convertFromTdata` принимает либо готовый `Tdata`-инстанс, либо plain
`TdataOptions` — в этом случае сам вызывает `Tdata.open(options)`. Официальный пример
на mtcute.dev/guide/advanced/session-convert подтверждает именно такой вызов.

**Скрытая рантайм-зависимость от `@mtcute/node`, несмотря на `optional: true` в
peerDependenciesMeta:** если не передать свой `crypto` в `TdataOptions`,
`Tdata.open`/`Tdata.create` вызывают `getDefaultCryptoProvider()`
(`packages/convert/src/utils/crypto.ts`), который **динамически импортирует**
`@mtcute/node/utils.js` за `NodeCryptoProvider`. То есть по умолчанию пакет всё равно
требует `@mtcute/node` установленным в рантайме — "optional" в package.json это не
отменяет. Крипто-провайдер по умолчанию — `node:crypto`-based (не WASM), это
подтверждено и JSDoc-комментарием в `TdataOptions.crypto`, и кодом
`getDefaultCryptoProvider`. `fs` по умолчанию — динамический `import('node:fs/promises')`.
Значит зависимостей на отдельный WASM-рантайм для нашего пути нет, но нужно поставить
`@mtcute/node` рядом с `@mtcute/convert` (или явно передать свой `crypto`/`fs`).

**Версионный риск подтверждён самим мейнтейнером в трёх местах исходников/доков**
(не только внешними reverse-engineering статьями, как в Варианте A):
1. JSDoc `TdataOptions.ignoreVersion`: "the probability of errors is higher".
2. Официальный пример на mtcute.dev содержит `ignoreVersion: true // note: this might break`.
3. Комментарий в `Tdata.readMtpAuthorization`: "this is pretty much a hack... very much
   tied to the actual tdesktop version, and would be a nightmare to maintain".

**Стабильность пакета:** `@mtcute/convert` 0.31.0, опубликован 2026-07-15, 58 версий в
реестре (активно развивается, но 0.x — semver не гарантирует обратную совместимость).
Лицензия MIT. Поиск issues по слову "tdata" в `mtcute/mtcute` — только 2 результата,
оба закрыты (#78 добавление поддержки tdata, #80 несвязанный рефакторинг). Открытых
багрепортов конкретно про `convertFromTdata` не найдено, но выборка узкая (один keyword
в одном репозитории, не исчерпывающая проверка).

**Why:** координатор просил ноль домыслов — каждый факт выше имеет прямую ссылку на
файл в исходниках или официальную страницу доки, проверенную в этом разговоре.

**How to apply:** при реализации `src/core/tdata/decrypt.ts` — не переписывать формат
самостоятельно (риск как в Варианте A), а звать `convertFromTdata` +
`convertToGramjsSession` из `@mtcute/convert`, добавить `@mtcute/node` в зависимости
(даже хотя peer помечен optional). Не проверено чтением исходников и требует живого
спайка на `3453453453/tdata/`: реальный успех расшифровки на конкретной версии
TDesktop, поведение при `accountIdx`>0 в других закупленных tdata, точное поведение
`self.isBot` (в `convertFromTdata` жёстко `false` независимо от реального типа
аккаунта — не баг для наших user-аккаунтов, но не проверялось на ботах), совместимость
типов `@mtcute/core` (ESM/CJS, TS strict) с текущим `tsconfig.json`/`package.json`
проекта.
