// llm/codex-pool.ts — пул codex-слотов (llm-multi-account-failover).
//
// Слот = отдельный codex-аккаунт (OAuth-токен) в каталоге
// ~/.openclaw/codex-auth/<slot>/auth.json. Приоритет и состав — из env CODEX_ACCOUNTS
// (слева направо), иначе автодискавери подкаталогов; легаси ~/.openclaw/codex-auth/auth.json
// (без подкаталогов) = единственный слот "default" (обратная совместимость).

import * as path from "path";
import * as fs from "fs";
import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { openaiCredentials } from "@openai-oauth/local";
import { loadAuthTokens } from "@openai-oauth/local/auth-file";
import type { FetchFunction } from "@openai-oauth/core";
import type { LanguageModel } from "ai";
import { codexAuthRoot, CODEX_ACCOUNTS, CODEX_COOLDOWN_FALLBACK_SECONDS } from "../core/config";

export interface CodexSlot {
    /** Стабильный id слота (имя каталога или "default"). Ключ cooldown-стора и приоритета. */
    name: string;
    /** Путь к auth.json слота. */
    authFile: string;
}

const CODEX_MODEL = "gpt-6-luna";
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * Обнаружение слотов в порядке приоритета:
 * 1) непустой CODEX_ACCOUNTS — ровно эти слоты, в заданном порядке;
 * 2) иначе — подкаталоги в codex-auth (по одному на слот) с auth.json, по имени;
 * 3) иначе — легаси codex-auth/auth.json как слот "default".
 */
export function discoverCodexSlots(): CodexSlot[] {
    const root = codexAuthRoot();
    if (CODEX_ACCOUNTS.length > 0) {
        return CODEX_ACCOUNTS.map((name) => ({ name, authFile: path.join(root, name, "auth.json") }));
    }
    const slots: CodexSlot[] = [];
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        entries = [];
    }
    for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const authFile = path.join(root, e.name, "auth.json");
        if (fs.existsSync(authFile)) slots.push({ name: e.name, authFile });
    }
    if (slots.length === 0) {
        const legacy = path.join(root, "auth.json");
        if (fs.existsSync(legacy)) slots.push({ name: "default", authFile: legacy });
    }
    return slots;
}

/** Модель провайдера для слота: createOpenAIOAuth(credentials(authFilePath))(gpt-6-luna). */
export function codexModel(slot: CodexSlot): LanguageModel {
    const provider = createOpenAIOAuth(openaiCredentials({ authFilePath: slot.authFile }));
    return provider(CODEX_MODEL) as LanguageModel;
}

/**
 * Момент сброса лимита слота из GET /backend-api/wham/usage (R14 — без траты квоты
 * генерации). cooldown_until = наиболее поздний reset_at исчерпанных окон (used_percent≥100);
 * если исчерпанных не распознать — ближайший reset_at (консервативно, не пере-бенчим);
 * при любой ошибке запроса — now + фолбэк-окно (CODEX_COOLDOWN_FALLBACK_SECONDS).
 */
export async function fetchResetAt(slot: CodexSlot): Promise<{ cooldownUntil: number; reachedType: string | null }> {
    const now = Math.floor(Date.now() / 1000);
    const fallback = now + CODEX_COOLDOWN_FALLBACK_SECONDS;
    try {
        const auth = await loadAuthTokens({
            authFilePath: slot.authFile,
            fetch: globalThis.fetch as FetchFunction,
            ensureFresh: true,
        });
        const res = await globalThis.fetch(WHAM_USAGE_URL, {
            headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "chatgpt-account-id": auth.accountId ?? "",
                originator: "codex_cli_rs",
                "User-Agent": "codex_cli_rs/0.160.0",
            },
        });
        if (!res.ok) return { cooldownUntil: fallback, reachedType: null };
        const u = (await res.json()) as {
            rate_limit?: {
                primary_window?: { used_percent?: number; reset_at?: number };
                secondary_window?: { used_percent?: number; reset_at?: number };
            };
            rate_limit_reached_type?: string | null;
        };
        const rl = u.rate_limit ?? {};
        const windows = [rl.primary_window, rl.secondary_window].filter(
            (w): w is { used_percent?: number; reset_at: number } => !!w && typeof w.reset_at === "number",
        );
        const reachedType = u.rate_limit_reached_type ?? null;
        if (windows.length === 0) return { cooldownUntil: fallback, reachedType };
        const exhausted = windows.filter((w) => typeof w.used_percent === "number" && w.used_percent >= 100);
        const cooldownUntil =
            exhausted.length > 0
                ? Math.max(...exhausted.map((w) => w.reset_at))
                : Math.min(...windows.map((w) => w.reset_at));
        return { cooldownUntil, reachedType };
    } catch {
        return { cooldownUntil: fallback, reachedType: null };
    }
}

/**
 * Принудительный рефреш токена слота (класс auth_401). Библиотека рефрешит access-token по
 * refresh-token; при живом refresh-token вернёт свежий accessToken. true — удалось, false —
 * рефреш не прошёл (протух сам refresh-token → релогин вне этой фичи).
 */
export async function forceRefresh(slot: CodexSlot): Promise<boolean> {
    try {
        const auth = await loadAuthTokens({
            authFilePath: slot.authFile,
            fetch: globalThis.fetch as FetchFunction,
            ensureFresh: true,
        });
        return !!auth?.accessToken;
    } catch {
        return false;
    }
}
