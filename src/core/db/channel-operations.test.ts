// core/db/channel-operations.test.ts — юнит-тесты сборки attrs события
// status_change и дедупа переходов (channel-write-access §6, причина бана в
// истории операций). Чистые функции, без обращения к БД.
// Запуск: `node --import tsx --test src/core/db/channel-operations.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStatusChangeAttrs, classifyStatusTransition } from "./channel-operations";

test("buildStatusChangeAttrs: с переданной причиной кладёт attrs.reason", () => {
    const attrs = buildStatusChangeAttrs({
        agentId: "agent1",
        oldStatus: null,
        newStatus: "banned",
        reason: "account_kicked",
    });
    assert.deepEqual(attrs, {
        oldAgentId: "agent1",
        newAgentId: "agent1",
        oldStatus: null,
        newStatus: "banned",
        reason: "account_kicked",
    });
});

test("buildStatusChangeAttrs: без причины — ключа reason нет", () => {
    const attrs = buildStatusChangeAttrs({
        agentId: "agent1",
        oldStatus: "only_comment",
        newStatus: "banned",
    });
    assert.deepEqual(attrs, {
        oldAgentId: "agent1",
        newAgentId: "agent1",
        oldStatus: "only_comment",
        newStatus: "banned",
    });
    assert.ok(!("reason" in attrs), "ключ reason не должен присутствовать без переданной причины");
});

test("classifyStatusTransition: banned→banned не пишется (дедуп сохранён)", () => {
    // Повтор того же состояния — не учитываемый переход, событие не пишется:
    // причина фиксируется только на переходе active/иной → banned.
    assert.equal(classifyStatusTransition("banned", "banned"), null);
    assert.equal(classifyStatusTransition(null, "banned"), "ban");
    assert.equal(classifyStatusTransition("only_comment", "banned"), "ban");
});
