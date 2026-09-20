// features/channel-rotation/plan.test.ts — юнит-тесты чистой раскладки ротации
// по истории посещений (channel-rotation-visit-history). Покрывают AC-1…AC-6.
// Выбор среди равных случайный (Math.random) — проверяем инвариант «результат ∈
// множество минимальных не-источников», а не конкретного агента (design v2, §2.4).
// Запуск: `node --import tsx --test src/features/channel-rotation/plan.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planRotation, type RotationCandidate } from "./plan";

const ITER = 400;

const candidate = (chatId: string, sourceAgentId: string): RotationCandidate => ({
    sourceAgentId,
    chatId,
    channelUsername: `ch_${chatId}`,
    statusUpdatedAt: null,
});

// Вложенная карта visit-count из литерала { chatId: { agentId: count } }.
const visits = (obj: Record<string, Record<string, number>>): Map<string, Map<string, number>> =>
    new Map(Object.entries(obj).map(([chatId, inner]) => [chatId, new Map(Object.entries(inner))]));

test("AC-2/AC-5: канал уходит агенту с visit-count 0 (минимум), а не с бо́льшим", () => {
    // pool = {B, C}; B уже держал канал (vc=1), C — нет (vc=0). Всегда C.
    const cand = candidate("c1", "A");
    for (let i = 0; i < ITER; i++) {
        const plan = planRotation([cand], ["A", "B", "C"], visits({ c1: { B: 1 } }));
        assert.equal(plan.unassigned.length, 0);
        assert.equal(plan.assignments[0].targetAgentId, "C");
    }
});

test("AC-1: при равном visit-count нагрузка агента не участвует (её нет в сигнатуре)", () => {
    // B и C оба vc=0 — равноправны независимо от любой нагрузки (нагрузка не входит
    // в контракт). Оба должны наблюдаться как цели за серию прогонов.
    const cand = candidate("c1", "A");
    const seen = new Set<string>();
    for (let i = 0; i < ITER; i++) {
        const plan = planRotation([cand], ["A", "B", "C"], visits({}));
        const target = plan.assignments[0].targetAgentId;
        assert.ok(target === "B" || target === "C", `target ${target} вне множества минимумов {B,C}`);
        seen.add(target);
    }
    assert.deepEqual([...seen].sort(), ["B", "C"], "оба равных агента должны встречаться (случайный выбор)");
});

test("AC-3: случайный среди равных по минимуму — результат всегда ∈ множество минимумов", () => {
    // pool = {B, C, D}; B держал канал (vc=1), C и D — нет (vc=0). winners={C,D}.
    const cand = candidate("c1", "A");
    const seen = new Set<string>();
    for (let i = 0; i < ITER; i++) {
        const plan = planRotation([cand], ["A", "B", "C", "D"], visits({ c1: { B: 1 } }));
        const target = plan.assignments[0].targetAgentId;
        assert.ok(target === "C" || target === "D", `target ${target} вне winners {C,D}`);
        seen.add(target);
    }
    assert.deepEqual([...seen].sort(), ["C", "D"], "оба минимальных не-источника должны встречаться");
});

test("AC-4: агент-источник не выбирается ни при каком visit-count", () => {
    // Источник A имеет vc=0, единственная альтернатива B — vc=100. Всё равно B
    // (источник исключён из pool до сравнения минимума).
    const cand = candidate("c1", "A");
    for (let i = 0; i < ITER; i++) {
        const plan = planRotation([cand], ["A", "B"], visits({ c1: { B: 100 } }));
        assert.equal(plan.assignments[0].targetAgentId, "B");
        assert.notEqual(plan.assignments[0].targetAgentId, "A");
    }
});

test("AC-5: повтор только после круга — при всех vc≥1 берётся минимальный, не произвольный ранее пробовавший", () => {
    // pool={B,C}: B держал 1 раз, C — 2 раза. Круг пройден, минимум=1 → всегда B.
    const cand = candidate("c1", "A");
    for (let i = 0; i < ITER; i++) {
        const plan = planRotation([cand], ["A", "B", "C"], visits({ c1: { B: 1, C: 2 } }));
        assert.equal(plan.assignments[0].targetAgentId, "B");
    }
});

test("AC-6: единственный активный агент — источник → unassigned", () => {
    const cand = candidate("c1", "A");
    const plan = planRotation([cand], ["A"], visits({ c1: { A: 3 } }));
    assert.equal(plan.assignments.length, 0);
    assert.deepEqual(plan.unassigned, [cand]);
});

test("выбор per-candidate независим: каждый канал использует собственную историю", () => {
    // Два кандидата разных персон/каналов в одном прогоне: c1 → минимум у C,
    // c2 → минимум у B. Истории не смешиваются.
    const c1 = candidate("c1", "A");
    const c2 = candidate("c2", "A");
    for (let i = 0; i < ITER; i++) {
        const plan = planRotation(
            [c1, c2],
            ["A", "B", "C"],
            visits({ c1: { B: 5, C: 0 }, c2: { B: 0, C: 5 } }),
        );
        const byChat = new Map(plan.assignments.map((a) => [a.candidate.chatId, a.targetAgentId]));
        assert.equal(byChat.get("c1"), "C");
        assert.equal(byChat.get("c2"), "B");
    }
});

test("отсутствие канала/агента в visitsByChannel трактуется как visit-count 0", () => {
    // Для c1 нет записи вовсе → все не-источники vc=0 → winner ∈ {B,C}.
    const cand = candidate("c1", "A");
    const plan = planRotation([cand], ["A", "B", "C"], visits({ c9: { B: 3 } }));
    assert.ok(["B", "C"].includes(plan.assignments[0].targetAgentId));
});
