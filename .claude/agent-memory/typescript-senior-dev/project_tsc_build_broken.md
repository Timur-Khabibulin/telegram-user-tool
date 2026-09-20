---
name: project-tsc-build-broken
description: Как проверять типизацию — плоский `tsc`/`npm run build` в этом репозитории не проходит из-за конфигурации, репозиторий гейтится не на tsc
metadata:
  type: project
---

Плоский `npx tsc --noEmit` (и `npm run build`, script = `tsc`) в этом репозитории
НЕ запускается как есть.

**Почему:** `tsconfig.json` держит `module: "commonjs"` + `moduleResolution:
"bundler"` — несовместимая пара (TS 5.9 бросает `TS5095: Option 'bundler' can only
be used when 'module' is set to 'preserve'/'es2015'+`). Плюс не установлен
`@types/better-sqlite3`, поэтому под любой другой резолюцией во всех `src/core/db/*`
всплывает `TS7016` на `import Database from "better-sqlite3"`. Ещё есть пул
пред-существующих `bigint`→`EntityLike`/`BigInteger` ошибок в `service.ts`/`tdata`.
Вывод: репозиторий исполняется через jiti/tsx (типы стираются без проверки), `tsc`
как гейт не используется.

**How to apply:** чтобы проверить ТОЛЬКО свои изменения на type-ошибки, запускай
`npx tsc --noEmit --module preserve --moduleResolution bundler` и грепом отфильтруй
шум: `grep -vE "better-sqlite3|declaration file|Try \`npm|implicitly has an 'any'
type\.$"`, затем грепни свои файлы/диапазоны строк. Пустой результат по своим
файлам = чисто. Юнит-тесты чистых модулей гоняются нормально:
`node --import tsx --test <file>`. Не пытайся «починить» tsconfig в рамках несвязанной
задачи — это пред-существующее состояние, менять только с явного запроса.
