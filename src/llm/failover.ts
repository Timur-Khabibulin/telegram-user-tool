// llm/failover.ts — явный цикл failover по пулу codex-слотов + DeepSeek
// (llm-multi-account-failover, заменяет ai-fallback).
//
// Поведение по классу ошибки (spec llm-layer §6.1, R15):
//   usage_limit (codex) → cooldown слота до reset_at (/wham/usage) → СЛЕДУЮЩИЙ провайдер + повтор;
//   auth_401   (codex) → форс-рефреш токена → 1 повтор на ТОМ ЖЕ провайдере; не помогло → наружу;
//   прочее (schema/transient/auth_403/runtime/other) → наружу без повтора и фолбэка.
// Наружу всегда летит LlmCallError (изоляция по рабочему элементу, R19).

import type { LanguageModel } from "ai";
import { classifyLlmError, LlmCallError, type LlmErrorClass } from "./error-class";
import { discoverCodexSlots, codexModel, fetchResetAt, forceRefresh, type CodexSlot } from "./codex-pool";
import { listAvailableAccounts, setCooldown } from "../core/db/codex-cooldown";

interface ProviderEntry {
    kind: "codex" | "deepseek";
    label: string;
    model: LanguageModel;
    accountId?: string; // имя слота (для codex)
    slot?: CodexSlot;
}

function short(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function asLlmCallError(err: unknown): LlmCallError {
    return err instanceof LlmCallError ? err : new LlmCallError(classifyLlmError(err), short(err), { cause: err });
}

/**
 * Цепочка провайдеров на момент вызова: доступные codex-слоты (не на cooldown) в порядке
 * приоритета, затем DeepSeek последним (R3, R8). Cooldown-фильтр читается из стора по дате
 * (R7) — без обращения к модели.
 */
export function buildProviderChain(deepseekModel: LanguageModel | null): ProviderEntry[] {
    const slots = discoverCodexSlots();
    const available = listAvailableAccounts(slots.map((s) => s.name));
    const bySlot = new Map(slots.map((s) => [s.name, s]));
    const chain: ProviderEntry[] = [];
    for (const name of available) {
        const slot = bySlot.get(name);
        if (!slot) continue;
        chain.push({ kind: "codex", label: `codex:${name}`, accountId: name, slot, model: codexModel(slot) });
    }
    if (deepseekModel) chain.push({ kind: "deepseek", label: "deepseek", model: deepseekModel });
    return chain;
}

/**
 * Исполняет `run` по цепочке провайдеров с поклассовым поведением. Переход к следующему
 * провайдеру — только при usage_limit; повтор на том же — только при auth_401. Любой иной
 * класс завершает вызов (без фолбэка). Всегда бросает LlmCallError при неуспехе.
 */
export async function withFailover<T>(
    deepseekModel: LanguageModel | null,
    run: (model: LanguageModel) => Promise<T>,
): Promise<T> {
    const chain = buildProviderChain(deepseekModel);
    if (chain.length === 0) {
        throw new LlmCallError("other", "[llm] нет доступных провайдеров (все codex на cooldown, DeepSeek отсутствует)");
    }

    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
        const p = chain[i];
        try {
            const result = await run(p.model);
            if (i > 0) console.info(`[llm] ответ обслужил ${p.label}`); // первый провайдер — без шума
            return result;
        } catch (err) {
            lastErr = err;
            const cls: LlmErrorClass = classifyLlmError(err);
            console.warn(`[llm] ${p.label}: класс=${cls} — ${short(err)}`);

            if (cls === "usage_limit" && p.kind === "codex" && p.accountId && p.slot) {
                const { cooldownUntil, reachedType } = await fetchResetAt(p.slot);
                setCooldown(p.accountId, cooldownUntil, reachedType);
                console.warn(
                    `[llm] ${p.label} на cooldown до ${new Date(cooldownUntil * 1000).toISOString()} ` +
                        `(${reachedType ?? "?"}) → следующий провайдер`,
                );
                continue; // переход к следующему провайдеру + повтор (R6, AC-4)
            }

            if (cls === "auth_401" && p.kind === "codex" && p.slot) {
                if (await forceRefresh(p.slot)) {
                    try {
                        const r = await run(p.model); // 1 повтор на ТОМ ЖЕ провайдере (R16)
                        console.info(`[llm] ответ обслужил ${p.label} (после рефреша 401)`);
                        return r;
                    } catch (e2) {
                        console.error(`[llm] ${p.label}: 401 и после рефреша`);
                        throw asLlmCallError(e2);
                    }
                }
                console.error(`[llm] ${p.label}: рефреш токена не удался (релогин вне фичи)`);
                throw asLlmCallError(err);
            }

            // schema_error | transient | auth_403 | runtime_error | other → без повтора/фолбэка
            throw asLlmCallError(err);
        }
    }

    // Все codex-слоты вернули usage_limit и ушли на cooldown, DeepSeek недоступен/исчерпан.
    throw new LlmCallError(classifyLlmError(lastErr), "[llm] вся цепочка провайдеров исчерпана", { cause: lastErr });
}
