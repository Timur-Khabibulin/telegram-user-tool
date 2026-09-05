---
name: project_tg_agent_autoregistration_tdata_risk
description: tg-agent-autoregistration explore — why Variant A (parsing purchased tdata) carries version-format risk, grounded in painor/GramJS gist + opentele
type: project
---

Задача: tg-agent-autoregistration (explore-режим) — рассматривается вариант A:
извлечь `{dcId, authKey}` из закупленных tdata-папок (пример: `3453453453/tdata/`)
и собрать GramJS `StringSession`, минуя ручной логин.

Подтверждено research'ем (painor/GramJS gist, opentele, tdata-rs, mtcute/tdesktop-session):

- Расшифровка идёт в три слоя: `key_datas` (соль + KDF SHA512-prehash → PBKDF2-SHA512,
  iterations=1 при пустом passcode) даёт `passKey` → `passKey` расшифровывает блоб внутри
  `key_datas` (MTProto-style AES-256-IGE с деривацией ключа через msgKey/SHA1, тот же
  примитив, что и в реальном MTProto-трафике) → даёт настоящий `localKey` → `localKey`
  расшифровывает `maps` внутри папки-хеша аккаунта (MD5("data") с переставленными
  полубайтами, напр. `D877F783D5D3EF8C`) и вынесенные блоки (файлы вида
  `421BF3FE2A122391` + safe-copy twin с суффиксом `s`, атомарная запись TDesktop).
- Итоговые байты: magic-байт, userId int32, mainDcId int32, затем повторяющиеся
  `(dcId int32, authKey 256 bytes)` — берётся запись с `dcId == mainDcId`.
- Сборка `StringSession` из уже готовых dcId+authKey — тривиальна, НЕ риск.

**Why (главный риск варианта A):** формат официально не документирован Telegram/TDesktop
(4+ независимых реверс-инжиниринг реализации — признак отсутствия спеки). Автор
painor-гиста сам ограничивает применимость: tdesktop 2.7+/3.0+, один аккаунт, без
passcode. Версия TDesktop, которой создавались конкретные закупленные tdata, неизвестна.
Ошибка версии формата не обязательно падает явно — может тихо дать мусорный authKey.
Отсутствие passcode (подтверждено на закупленных аккаунтах) снимает риск "неверный
passKey", но НЕ снимает версионный риск разбора `maps`/тегов блоков.

**How to apply:** перед реализацией варианта A — не читать формат теоретически, а
прогнать существующий парсер (painor gist или opentele) на 2-3 реальных образцах
закупленных tdata и проверить результат live-логином/whoami. Если координатор просит
код — не писать наугад расшифровку с нуля, ссылаться на готовые референсные реализации
(gist painor, opentele, tdata-rs) как отправную точку, а не восстанавливать формат по
памяти.

См. также [[project_funnel_v3_architecture]] для стиля других project-memory этого агента.
