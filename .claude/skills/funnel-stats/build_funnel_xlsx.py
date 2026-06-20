#!/usr/bin/env python3
"""Сборка funnel-stats.xlsx с нуля: таблица дневной воронки + диаграммы.

Вход — результат SQL-запроса к daily_stats со stdin, по строке на день,
поля разделены '|' в порядке:
    date|group_replies|public_subs_abs|post_views_abs|post_views_delta|private_requests_delta
Пустое числовое поле трактуется как 0 (дельты первого дня = NULL в БД).

Диаграммы якорятся в колонке H (правее данных A–F) и складываются вертикально
с шагом, исключающим наложение на таблицу и друг на друга.

Использование:
    ssh ... 'sqlite3 ... "<query>"' | python build_funnel_xlsx.py <out.xlsx>
"""
import sys

import openpyxl
from openpyxl.chart import BarChart, Reference
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.styles import Font, Alignment

HEADERS = [
    "Дата",
    "Ответы в группах (Σ)",
    "Подписчики (Σ abs)",
    "Просмотры (Σ abs)",
    "Прирост просмотров (Σ)",
    "Прирост заявок в приват (Σ)",
]

# колонка метрики (1-based) -> заголовок диаграммы
CHARTS = [
    (2, "Ответы в группах по дням"),
    (4, "Просмотры (абсолют) по дням"),
    (3, "Подписчики (абсолют) по дням"),
    (5, "Прирост просмотров по дням"),
    (6, "Прирост заявок в приват по дням"),
]

# Габариты диаграммы (см) и вертикальный шаг якорей (строки) — без наложения.
CHART_W, CHART_H = 14, 7
CHART_ANCHOR_COL = "H"  # правее данных (A–F); G — визуальный зазор
CHART_ROW_STEP = 15
BAR_COLOR = "4472C4"  # единый цвет столбцов на всех диаграммах


def parse_stdin(text):
    """pipe-separated строки -> список кортежей (date, b, c, d, e, f)."""
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) != 6:
            raise ValueError(f"ожидалось 6 полей, получено {len(parts)}: {line!r}")
        date = parts[0]
        nums = [int(p) if p.strip() else 0 for p in parts[1:]]
        rows.append((date, *nums))
    if not rows:
        raise ValueError("нет данных на stdin")
    return rows


def build(data, out_path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Данные"

    ws.append(HEADERS)
    for r in data:
        ws.append(list(r))

    # Оформление шапки и колонок.
    for c in range(1, len(HEADERS) + 1):
        cell = ws.cell(row=1, column=c)
        cell.font = Font(bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    ws.row_dimensions[1].height = 42
    ws.column_dimensions["A"].width = 13
    for col in "BCDEF":
        ws.column_dimensions[col].width = 16
    ws.freeze_panes = "A2"

    last = len(data) + 1  # последняя строка данных (строка 1 — шапка)
    cats = Reference(ws, min_col=1, min_row=2, max_row=last)

    anchor_row = 1
    for col, title in CHARTS:
        ch = BarChart()
        ch.type = "col"
        ch.title = title
        ch.width, ch.height = CHART_W, CHART_H
        ch.legend = None
        ch.varyColors = False  # иначе каждый столбец красится в свой цвет
        ref = Reference(ws, min_col=col, min_row=1, max_row=last)  # с именем серии
        ch.add_data(ref, titles_from_data=True)
        ch.set_categories(cats)
        # Единый цвет заливки столбцов серии.
        ch.series[0].graphicalProperties = GraphicalProperties(solidFill=BAR_COLOR)
        ws.add_chart(ch, f"{CHART_ANCHOR_COL}{anchor_row}")
        anchor_row += CHART_ROW_STEP

    wb.save(out_path)
    return last - 1  # число строк данных


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: build_funnel_xlsx.py <out.xlsx>")
    data = parse_stdin(sys.stdin.read())
    n = build(data, sys.argv[1])
    print(f"saved {sys.argv[1]}: {n} строк ({data[0][0]}…{data[-1][0]}), {len(CHARTS)} диаграмм")


if __name__ == "__main__":
    main()