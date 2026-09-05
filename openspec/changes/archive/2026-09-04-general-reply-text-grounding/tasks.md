## 1. monitor.ts (v1)

- [x] 1.1 В блоке `analysis.ответитьНа` (`monitor.ts:316-330`) после
      `const sel = analysis.ответитьНа;` добавить lookup реального сообщения:
      `const selMsg = generalById.get(sel.id);` (`generalById` уже в скоупе,
      строка 251).
- [x] 1.2 Если `selMsg` не найден — пропустить общий ответ для канала в этом
      прогоне (не бросать исключение), с `log.warn`.
- [x] 1.3 `generateReply(sel.текст)` → `generateReply(selMsg.text)`.
- [x] 1.4 `saveReply(..., msgText: sel.текст, ...)` → `saveReply(...,
      msgText: selMsg.text, ...)`.

## 2. monitor-v2.ts

- [x] 2.1-2.4 — те же четыре правки, что в разделе 1, по месту
      `monitor-v2.ts:503-517` (`generalById` в скоупе, строка 437;
      код идентичен monitor.ts).

## 3. monitor-v5.ts

- [x] 3.1 В блоке `dmAnalysis.ответитьНа` (`monitor-v5.ts:578-609`) после
      `const sel = dmAnalysis.ответитьНа;` добавить
      `const selMsg = generalById.get(sel.id);` (`generalById` в скоупе,
      строка 491).
- [x] 3.2 Если `selMsg` не найден — пропустить общий ответ для канала в этом
      прогоне, с `log.warn`.
- [x] 3.3 `generateReply(sel.текст)` → `generateReply(selMsg.text)`.
- [x] 3.4 `saveReply(..., msgText: sel.текст, ...)` → `saveReply(...,
      msgText: selMsg.text, ...)`.
- [x] 3.5 `formatGeneralReplyNotification(agentId, channel.title, sel.текст,
      replyText)` → тот же вызов с `selMsg.text` вместо `sel.текст`.

## 4. Верификация

- [x] 4.1 `tsc --noEmit` (или существующий npm-скрипт типов) — три файла
      компилируются без ошибок. Проверено точечно (`tsc --noEmit` на трёх
      файлах с явными флагами компилятора — общий `npm run build` блокирован
      предсуществующей несвязанной ошибкой `tsconfig.json` option 'bundler').
      25 ошибок в проекте есть и без правки, и с ней — идентичный список,
      ни одна не в добавленных строках (`selMsg`/`generalById`).

## 5. Деплой

- [x] 5.1 `scp` трёх файлов (`monitor.ts`, `monitor-v2.ts`, `monitor-v5.ts`)
      на VPS + `chown root:root ~/.openclaw/extensions/telegram-user-tool`.
      Выполнено 2026-08-31 18:36 UTC, содержимое на сервере сверено
      (`grep selMsg`).
- [x] 5.2 Рестарт gateway не потребовался — не выполнялся, `tsx`
      перечитывает файл на каждый тик диспетчера (`tg-agent@.timer`,
      *:0/10) без отдельного шага.
