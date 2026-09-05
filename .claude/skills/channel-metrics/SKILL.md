---
name: channel-metrics
description: Compute Telegram channel metrics (subscriber count, average post reach, whether comments/discussion are open, whether it's a broadcast channel) for an arbitrary CSV list of channel links via one agent's MTProto session. Use when the user wants to enrich a channels CSV with subs/avg_views/comments_open/is_broadcast, or mentions channel-metrics.ts.
---

Заливает CSV со списком ссылок на VPS и прогоняет
`src/scripts/ops/channel-metrics.ts` — для каждой ссылки через MTProto одной сессии
агента считает подписчиков, средний охват поста, открыты ли комментарии
(привязана ли группа обсуждения) и является ли канал broadcast-каналом.
Результат пишется в CSV на сервере построчно и резюмируемо. См.
`openspec/changes/channel-metrics/` (design/specs) и skill `vps` (тот же
`ssh -i ~/.ssh/vps_key root@<VPS_HOST>`).

## Когда использовать

У пользователя есть список ссылок на Telegram-каналы (свой CSV, или результат
фильтрации `channels.db` по теме и т.п.) и нужно узнать по каждому подписчиков,
средний охват, открыты ли комментарии и тип канала — включая каналы, которые ни
один агент платформы не отслеживает.

## Формат входного CSV

Нужна только колонка `link` (заголовок обязателен) — остальные колонки
игнорируются скриптом, можно скармливать таблицу как есть, без предварительной
чистки:

```
link,title,agentId
https://t.me/foo,Канал Foo,agent8
https://t.me/bar,Канал Bar,agent8
```

## Как выполнять

1. Залить входной CSV на VPS:
   ```
   ssh -i ~/.ssh/vps_key root@<VPS_HOST> "mkdir -p ~/.openclaw/extensions/telegram-user-tool/imports"
   scp -i ~/.ssh/vps_key <локальный путь к CSV> root@<VPS_HOST>:~/.openclaw/extensions/telegram-user-tool/imports/<имя>-input.csv
   ```

2. Запустить скрипт. Список на десятки ссылок — можно синхронно; на сотни (пейсинг
   ~1–3.5с на канал, плюс возможные `FLOOD_WAIT`) — прогон может занять от
   нескольких минут до часа+, запускать в фоне (`nohup ... & disown`), чтобы не
   держать интерактивную SSH-сессию:
   ```
   ssh -i ~/.ssh/vps_key root@<VPS_HOST> "cd ~/.openclaw/extensions/telegram-user-tool && \
     nohup ./node_modules/.bin/tsx src/scripts/ops/channel-metrics.ts \
       --input imports/<имя>-input.csv \
       --output imports/<имя>-output.csv \
       --agent <agentId> > imports/<имя>.log 2>&1 & disown"
   ```

3. Проверить прогресс (лог пишется построчно, одна строка на канал):
   ```
   ssh -i ~/.ssh/vps_key root@<VPS_HOST> "tail -20 ~/.openclaw/extensions/telegram-user-tool/imports/<имя>.log"
   ```

4. Скачать результат, когда прогон завершён (в логе строка `[channel-metrics] done`):
   ```
   scp -i ~/.ssh/vps_key root@<VPS_HOST>:~/.openclaw/extensions/telegram-user-tool/imports/<имя>-output.csv <локальный путь>
   ```

5. Убрать временные файлы на сервере после того, как результат скачан и больше не
   нужно резюмировать прогон:
   ```
   ssh -i ~/.ssh/vps_key root@<VPS_HOST> "rm imports/<имя>-input.csv imports/<имя>-output.csv imports/<имя>.log"
   ```

## Резюмируемость и остановка по FLOOD_WAIT

Скрипт останавливает **весь** прогон (не только текущий канал) после 2
`FLOOD_WAIT` подряд — при списке на сотни ссылок это ожидаемый, не аварийный
исход. В логе будет строка `остановлено по FLOOD_WAIT`.

**Важно**: не удалять `--output` файл на сервере после такой остановки. Чтобы
продолжить — просто повторить команду запуска из шага 2 **с теми же** `--input`
и `--output`: скрипт сам пропустит ссылки, уже присутствующие в выходном файле
(успешные и с `error`), и обработает только необработанный хвост. Автоматического
retry ошибочных строк нет — если нужно пересчитать конкретную ссылку, удалить её
строку из output-файла вручную перед перезапуском.

## Что делает скрипт (кратко)

На каждую ссылку: приватные (`t.me/+...`, `t.me/joinchat/...`) — сразу строка с
пустыми метриками и `error`, без обращения к Telegram. Публичные — резолв через
`resolveChannelByUsername`; не найден → `error`. Найден → один `GetFullChannel`
даёт число подписчиков и признак привязанной группы обсуждения (`comments_open`),
плюс до 11 последних постов → средний охват (пропуская самый свежий пост —
методология `channel-coverage-update.ts`). Выход:
`link,subs_count,avg_views,comments_open,is_broadcast,error`.

`title`/`agentId` и другие колонки исходной таблицы в выход не переносятся — если
нужна обогащённая таблица (с названием канала и т.п.), после скачивания
`--output` сделать join по `link` с исходным CSV самостоятельно (например, тем же
способом, что и сбор входного списка).

## После выполнения

Показать пользователю сводку из последней строки лога (`done — обработано: N,
пропущено: M...`), путь к скачанному CSV и сколько строк завершились с `error`
(и почему, если это не единичные случаи — например, много приватных ссылок в
исходном списке).
