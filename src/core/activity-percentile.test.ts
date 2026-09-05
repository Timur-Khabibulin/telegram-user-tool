// core/activity-percentile.test.ts — юнит-тесты чистой функции расчёта
// перцентилей активности (channel-activity-percentiles). Окно — 7 суток.
// Запуск: `node --import tsx --test src/core/activity-percentile.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { activityWindow, computeActivityPercentiles, type ActivityMessage } from "./activity-percentile";

const DAY_SECONDS = 86400;

test("постоянная активность: одно и то же число отправителей каждые сутки", () => {
    const { startSec } = activityWindow();
    const messages: ActivityMessage[] = [];
    for (let day = 0; day < 7; day++) {
        for (let user = 0; user < 3; user++) {
            messages.push({ fromId: `u${user}`, date: startSec + day * DAY_SECONDS + 10 });
        }
    }
    const { p50, p90 } = computeActivityPercentiles(messages);
    assert.equal(p50, 3);
    assert.equal(p90, 3);
});

test("тихие дни (0) входят в ряд, не выпадают из выборки", () => {
    const { startSec } = activityWindow();
    // Только последние сутки окна (день 6) имеют одного уникального отправителя,
    // остальные 6 суток молчат.
    const messages: ActivityMessage[] = [{ fromId: "u0", date: startSec + 6 * DAY_SECONDS + 10 }];
    const { p50, p90 } = computeActivityPercentiles(messages);
    // Отсортированный ряд (7 суток): [0,0,0,0,0,0,1]. p50 (ранг 0.5*6=3) = 0.
    assert.equal(p50, 0);
    // p90 (ранг 0.9*6=5.4) — между индексами 5 (0) и 6 (1): 0 + 0.4*(1-0) = 0.4.
    assert.ok(Math.abs(p90 - 0.4) < 1e-9, `expected ~0.4, got ${p90}`);
});

test("канал без сообщений за всё окно — оба перцентиля 0, не null", () => {
    const { p50, p90 } = computeActivityPercentiles([]);
    assert.equal(p50, 0);
    assert.equal(p90, 0);
});

test("линейная интерполяция совпадает с эталонным расчётом (numpy/Excel PERCENTILE.INC)", () => {
    const { startSec } = activityWindow();
    const messages: ActivityMessage[] = [];
    // День i получает i уникальных отправителей (i = 0..6) → ряд после сортировки — [0..6].
    for (let day = 0; day < 7; day++) {
        for (let user = 0; user < day; user++) {
            messages.push({ fromId: `u${user}`, date: startSec + day * DAY_SECONDS + 10 });
        }
    }
    const { p50, p90 } = computeActivityPercentiles(messages);
    // rank = p * (n-1), n=7: p50 → 0.5*6=3 → sortedAsc[3]=3; p90 → 0.9*6=5.4 → 5+0.4*(6-5)=5.4.
    assert.equal(p50, 3);
    assert.equal(p90, 5.4);
});

test("сообщения вне окна (раньше начала/после конца) не учитываются", () => {
    const { startSec, endSec } = activityWindow();
    const messages: ActivityMessage[] = [
        { fromId: "before", date: startSec - 10 },
        { fromId: "after", date: endSec + 10 },
        { fromId: "inside", date: startSec + 10 },
    ];
    const { p50, p90 } = computeActivityPercentiles(messages);
    // Единственный учтённый — 1 сообщение в сутки 0: ряд (7 суток) — [0,0,0,0,0,0,1].
    assert.equal(p50, 0);
    assert.ok(Math.abs(p90 - 0.4) < 1e-9, `expected ~0.4, got ${p90}`);
});
