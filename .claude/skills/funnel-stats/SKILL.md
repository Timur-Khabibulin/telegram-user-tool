---
name: funnel-stats
description: Build a funnel-stats .xlsx (daily funnel metrics table + charts) from VPS data. Use when the user wants a funnel report/spreadsheet, funnel-stats.xlsx, or daily voronka stats as an Excel file.
---

Строит Excel-таблицу дневной воронки с диаграммами. Данные берутся с VPS,
таблица **каждый раз создаётся с нуля** и кладётся в папку `funnel-reports/`.

## Что в таблице

Лист `Данные`, суммы по всем агентам за день (`Σ`):

| Колонка | Поле `daily_stats` | Значение |
|---|---|---|
| A Дата | `date` | день UTC+5 |
| B Ответы в группах (Σ) | `SUM(group_replies)` | ответы агентов в группах |
| C Подписчики (Σ abs) | `SUM(public_subs_abs)` | подписчики личных каналов (абсолют) |
| D Просмотры (Σ abs) | `SUM(post_views_abs)` | просмотры закреп-поста (абсолют) |
| E Прирост просмотров (Σ) | `SUM(post_views_delta)` | прирост просмотров за день |
| F Прирост заявок в приват (Σ) | `SUM(private_requests_delta)` | прирост заявок в приватный канал (только admin-агент) |

5 диаграмм по столбцам B–F. Они якорятся в колонке `H` и ниже (с шагом 15 строк),
чтобы **не перекрывать данные таблицы** (A–F) и друг друга.

## Источник данных

`funnel.db` админ-агента (`agent1`) на VPS. Подключение — `ssh -i ~/.ssh/vps_key`,
хост `root@<VPS_HOST>` (см. skill `vps`). Метрики собирает таймер
`tg-funnel-tracker` (19:10 UTC) — за сегодняшний день строки может ещё не быть,
это нормально.

## Как выполнять

Один конвейер: запрос на VPS → генератор. `COALESCE(...,0)` приводит `NULL`-дельты
первого дня к `0` (как в исходной таблице). Отрицательная дельта заявок (например
−77) — норма, не обнулять.

```bash
mkdir -p funnel-reports
ssh -i ~/.ssh/vps_key root@<VPS_HOST> 'sqlite3 -separator "|" \
  ~/.openclaw/workspace-agent1/funnel.db \
  "SELECT date, SUM(group_replies), SUM(public_subs_abs), SUM(post_views_abs), \
          COALESCE(SUM(post_views_delta),0), COALESCE(SUM(private_requests_delta),0) \
   FROM daily_stats GROUP BY date ORDER BY date;"' \
| python .claude/skills/funnel-stats/build_funnel_xlsx.py \
    "funnel-reports/funnel-stats-$(date +%Y-%m-%d).xlsx"
```

Имя файла — с текущей датой, поэтому прошлые отчёты не затираются. Генератор
печатает строку-итог (число строк, диапазон дат, число диаграмм) — показать её
пользователю и назвать путь к файлу.

## Важно про инструмент

- **Создание с нуля** (этот скил) → `openpyxl`: диаграммы строятся и якорятся
  корректно.
- **Дополнение готового xlsx с диаграммами** → НЕ через `openpyxl` (он не двигает
  диапазоны существующих графиков). Этот скил всегда строит заново, поэтому проблемы
  нет.

Генератор: `build_funnel_xlsx.py` (рядом с этим файлом). Читает результат запроса
со stdin (6 полей через `|`), пишет xlsx в путь из первого аргумента.