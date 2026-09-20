// core/google-sheets.ts — минимальный клиент Google Sheets для конвейера метрик
// (channel-metrics-pipeline). Без npm-зависимости `googleapis`: авторизация —
// JWT сервис-аккаунта, подписанный `node:crypto` (RS256) и обменянный на
// access-token, дальше вызовы Sheets REST v4 через `fetch` (тот же приём, что
// distribution-bot-api). Причина отказа от googleapis: тяжёлый пакет ради
// нескольких REST-вызовов, а на этом проекте нативные пересборки (better-sqlite3
// под Node 26) уже болезненны — лишняя зависимость не оправдана.
//
// Доступ: сервис-аккаунт с JSON-ключом (GOOGLE_SHEETS_KEY_PATH), таблица
// (CHANNELS_SHEET_ID) расшарена на его email как Редактор, лист CHANNELS_SHEET_NAME.
// Scope `spreadsheets` — покрывает и чтение (дедуп), и запись.

import * as fs from "fs";
import * as crypto from "crypto";

import { GOOGLE_SHEETS_KEY_PATH, CHANNELS_SHEET_ID, CHANNELS_SHEET_NAME } from "./config";
import { normalizeChannelLink } from "./db/discovery";
import type { Logger } from "./logger";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Значение ячейки: строка (link/title/niche), число (метрики — как числа) или
 * boolean (comments_open/is_broadcast/прошёл_фильтр — как TRUE/FALSE). С RAW тип
 * JSON-значения сохраняется в ячейке как есть (число→число, boolean→логическое).
 */
export type SheetValue = string | number | boolean;

interface ServiceAccountKey {
    client_email: string;
    private_key: string;
}

function requireConfig(): { keyPath: string; sheetId: string; sheetName: string } {
    if (!GOOGLE_SHEETS_KEY_PATH || !CHANNELS_SHEET_ID) {
        throw new Error(
            "GOOGLE_SHEETS_KEY_PATH/CHANNELS_SHEET_ID не заданы в окружении (~/.openclaw/secrets.env)",
        );
    }
    return { keyPath: GOOGLE_SHEETS_KEY_PATH, sheetId: CHANNELS_SHEET_ID, sheetName: CHANNELS_SHEET_NAME };
}

// ─── Авторизация: JWT сервис-аккаунта → access-token ──────────────────

function base64url(buf: Buffer): string {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Кэш токена в процессе воркера: токен живёт час, повторно не выпрашиваем. */
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(keyPath: string, log: Logger): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;

    const key: ServiceAccountKey = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claim = base64url(
        Buffer.from(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now })),
    );
    const signingInput = `${header}.${claim}`;
    const signature = base64url(crypto.createSign("RSA-SHA256").update(signingInput).sign(key.private_key));
    const assertion = `${signingInput}.${signature}`;

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const json = (await res.json().catch(() => null)) as
        | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
        | null;
    if (!res.ok || !json?.access_token) {
        throw new Error(
            `Google token exchange failed: status=${res.status} ${json?.error_description ?? json?.error ?? "unknown"}`,
        );
    }
    log.info(`[google-sheets] access-token получен (expires_in=${json.expires_in ?? 3600}s)`);
    cachedToken = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
    return cachedToken.token;
}

// ─── REST-вызов ────────────────────────────────────────────────────────

async function sheetsApi<T>(
    method: string,
    pathAndQuery: string,
    body: unknown,
    keyPath: string,
    log: Logger,
): Promise<T> {
    const token = await getAccessToken(keyPath, log);
    const res = await fetch(`${SHEETS_BASE}/${pathAndQuery}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body != null ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) {
        // Путь может нести имя листа/диапазон, но не токен — его логировать безопасно.
        throw new Error(
            `Sheets ${method} ${pathAndQuery.split("?")[0]} failed: status=${res.status} ${json?.error?.message ?? "unknown"}`,
        );
    }
    return json as T;
}

// ─── Хелперы диапазонов A1 ─────────────────────────────────────────────

/** Индекс колонки (0 → A, 25 → Z, 26 → AA) в букву A1-нотации. */
function colLetter(idx0: number): string {
    let n = idx0;
    let s = "";
    do {
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
}

/** Имя листа с дефисами/пробелами в A1 требует одинарных кавычек; внутренние `'` удваиваются. */
function quotedRange(sheetName: string, a1: string): string {
    return encodeURIComponent(`'${sheetName.replace(/'/g, "''")}'!${a1}`);
}

// ─── API ──────────────────────────────────────────────────────────────

/**
 * Числовой sheetId вкладки и её ширина в колонках (для batchUpdate и проверки
 * границ грида). `values.update` не расширяет грид — прежде чем писать заголовок в
 * новую колонку за пределами текущей ширины, грид надо расширить (см. ensureColumns).
 */
async function getSheetMeta(log: Logger): Promise<{ sheetId: number; columnCount: number }> {
    const { keyPath, sheetId, sheetName } = requireConfig();
    const r = await sheetsApi<{ sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { columnCount?: number } } }[] }>(
        "GET",
        `${sheetId}?fields=sheets(properties(sheetId,title,gridProperties(columnCount)))`,
        undefined,
        keyPath,
        log,
    );
    const sheet = (r.sheets ?? []).find((s) => s.properties?.title === sheetName);
    if (!sheet?.properties) throw new Error(`вкладка «${sheetName}» не найдена в таблице`);
    return { sheetId: sheet.properties.sheetId ?? 0, columnCount: sheet.properties.gridProperties?.columnCount ?? 0 };
}

/** Имена всех вкладок таблицы — диагностика (сверить CHANNELS_SHEET_NAME с реальным). */
export async function listSheetTitles(log: Logger): Promise<string[]> {
    const { keyPath, sheetId } = requireConfig();
    const r = await sheetsApi<{ sheets?: { properties?: { title?: string } }[] }>(
        "GET",
        `${sheetId}?fields=sheets.properties.title`,
        undefined,
        keyPath,
        log,
    );
    return (r.sheets ?? []).map((s) => s.properties?.title ?? "").filter((t) => t.length > 0);
}

/** Заголовок листа (строка 1) — источник маппинга колонок по имени/позиции. */
export async function fetchHeader(log: Logger): Promise<string[]> {
    const { keyPath, sheetId, sheetName } = requireConfig();
    const range = quotedRange(sheetName, "1:1");
    const r = await sheetsApi<{ values?: string[][] }>("GET", `${sheetId}/values/${range}`, undefined, keyPath, log);
    return (r.values?.[0] ?? []).map((v) => String(v ?? ""));
}

/**
 * Множество уже присутствующих в листе ссылок (для дедупа входа). Ссылки берутся
 * из колонки `link` и канонизируются `normalizeChannelLink` — тем же способом, что
 * ключует входные ссылки воркер, иначе дедуп бы не совпал.
 */
export async function fetchExistingLinks(log: Logger): Promise<Set<string>> {
    const { keyPath, sheetId, sheetName } = requireConfig();
    const header = await fetchHeader(log);
    const linkIdx = header.findIndex((h) => h.trim().toLowerCase() === "link");
    if (linkIdx === -1) throw new Error(`в листе «${sheetName}» нет колонки «link»`);

    const col = colLetter(linkIdx);
    const range = quotedRange(sheetName, `${col}2:${col}`);
    const r = await sheetsApi<{ values?: string[][] }>(
        "GET",
        `${sheetId}/values/${range}?majorDimension=COLUMNS`,
        undefined,
        keyPath,
        log,
    );
    const raw = r.values?.[0] ?? [];
    const set = new Set<string>();
    for (const v of raw) {
        const s = String(v ?? "").trim();
        if (s.length > 0) set.add(normalizeChannelLink(s));
    }
    log.info(`[google-sheets] в листе уже ${set.size} ссылок (для дедупа)`);
    return set;
}

/**
 * Гарантирует наличие всех колонок `names` в заголовке: отсутствующие дописывает в
 * конец строки 1 (по одной, слева направо). Возвращает актуальный заголовок (для
 * маппинга записи). Существующие колонки не трогаются (в т.ч. `статус`,
 * `в_discovery_db`, старые `источник_*`).
 */
export async function ensureColumns(names: string[], log: Logger): Promise<string[]> {
    const { keyPath, sheetId, sheetName } = requireConfig();
    let header = await fetchHeader(log);
    const missing = names.filter((n) => !header.some((h) => h.trim() === n));
    if (missing.length === 0) return header;

    // Новые колонки лягут после текущего заголовка; если это выходит за ширину
    // грида — сперва расширяем грид (values.update грид не расширяет, даёт 400
    // "exceeds grid limits").
    const meta = await getSheetMeta(log);
    const needed = header.length + missing.length;
    if (meta.columnCount < needed) {
        await sheetsApi(
            "POST",
            `${sheetId}:batchUpdate`,
            { requests: [{ appendDimension: { sheetId: meta.sheetId, dimension: "COLUMNS", length: needed - meta.columnCount } }] },
            keyPath,
            log,
        );
        log.info(`[google-sheets] грид расширен на ${needed - meta.columnCount} колонок (было ${meta.columnCount}, нужно ${needed})`);
    }

    for (const name of missing) {
        const col = colLetter(header.length);
        const range = quotedRange(sheetName, `${col}1`);
        await sheetsApi("PUT", `${sheetId}/values/${range}?valueInputOption=RAW`, { values: [[name]] }, keyPath, log);
        log.info(`[google-sheets] добавлена колонка «${name}» (${col}1)`);
        header = [...header, name];
    }
    return header;
}

/**
 * Дозаписывает строки в конец листа одним пакетом. Каждая запись — по имени
 * колонки; значение раскладывается по позиции колонки в `header`, отсутствующие
 * ключи → пустая ячейка (несчитаемые метрики, `assigned_agent`, `reestr_sub_count`).
 * `valueInputOption=RAW`: числа из записи ложатся как числа (локаль листа сама
 * отрисует десятичную запятую), строки — как строки.
 */
export async function appendRecords(records: Record<string, SheetValue>[], header: string[], log: Logger): Promise<void> {
    if (records.length === 0) return;
    const { keyPath, sheetId, sheetName } = requireConfig();

    const rows: SheetValue[][] = records.map((rec) => header.map((h) => (rec[h] === undefined ? "" : rec[h])));
    const range = quotedRange(sheetName, "A1"); // append сам находит конец таблицы
    await sheetsApi(
        "POST",
        `${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { values: rows },
        keyPath,
        log,
    );
    log.info(`[google-sheets] дозаписано строк: ${rows.length}`);
}
