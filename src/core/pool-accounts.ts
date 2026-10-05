// core/pool-accounts.ts — общие примитивы пула обезличенных аккаунтов
// (tg-agent-pool-provisioning). Используются обоими потребителями пула —
// развёртыванием персоны (фаза 2) и авто-заменой забаненных — чтобы порядок
// выборки «старейший первым» и атомарный забор были единым кодом.

import * as fs from "fs";
import type { Logger } from "./logger";
import { workspaceDir, listPoolAccountIds } from "./config";
import { TelegramService } from "./telegram/service";
import { classifyAccountError } from "./telegram/errors";
import { SessionBusyError } from "./telegram/session-lock";

/**
 * Пул-аккаунты в порядке «старейший первым». Якорь возраста — ctime каталога
 * `workspace-emptyAccount<K>` (метка K переиспользуется во времени и монотонности
 * не гарантирует, поэтому сортируем по времени создания каталога, не по номеру).
 */
export function listPoolAccountsOldestFirst(): string[] {
    return listPoolAccountIds()
        .map((poolId) => {
            let ctimeMs = Number.POSITIVE_INFINITY;
            try {
                ctimeMs = fs.statSync(workspaceDir(poolId)).ctimeMs;
            } catch {
                // каталог исчез между перечислением и stat — уедет в конец, отсеется при claim
            }
            return { poolId, ctimeMs };
        })
        .sort((a, b) => a.ctimeMs - b.ctimeMs)
        .map((e) => e.poolId);
}

/**
 * Атомарно забирает пул-аккаунт в целевой каталог `destDir` переименованием.
 * `rename` в пределах одной ФС атомарен — при гонке двух потребителей выигрывает
 * ровно один, проигравший получает `ENOENT` и берёт следующий свободный.
 * Возвращает false, если каталог уже забран/исчез (ENOENT).
 */
export function claimPoolAccountTo(poolId: string, destDir: string): boolean {
    try {
        fs.renameSync(workspaceDir(poolId), destDir);
        return true;
    } catch (err: any) {
        if (err?.code === "ENOENT") return false;
        throw err;
    }
}

/** Уводит невалидный пул-аккаунт в карантин `workspace-emptyAccount<K>.invalid`. */
export function quarantinePoolAccount(poolId: string): void {
    const src = workspaceDir(poolId);
    try {
        fs.renameSync(src, `${src}.invalid`);
    } catch (err: any) {
        if (err?.code === "ENOENT") return;
        throw err;
    }
}

const SUFFIX_WORDS = [
    "sky", "wave", "moon", "star", "leaf", "frost", "storm", "river", "glow", "dawn",
    "spark", "cloud", "flame", "haze", "drift", "echo", "swift", "ember", "mist", "tide",
    "grove", "reef", "peak", "vale", "bloom", "willow", "cove", "fern", "quartz", "amber",
    "rain", "snow", "pine", "cedar", "maple", "lake", "dune", "ridge", "meadow", "aspen",
    "ivy", "sage", "clover", "marsh", "delta", "shore", "comet", "aurora", "nova", "zephyr",
    "breeze", "flare", "lumen", "onyx", "jade", "coral", "pearl", "slate", "flint", "opal",
];

/**
 * username = nick + "_" + два РАЗНЫХ случайных человекочитаемых слова (R-4): без
 * числового хвоста и без фиксированной формы. Разделитель между словами выбирается
 * случайно ("_" либо слитно) — у разных агентов разная структура постфикса, а не
 * общий шаблон "слово+цифры". Пространство: 60×59 пар × 2 формы ≈ 7080 вариантов на
 * персону (больше прежних 2700); глобальную уникальность, как и раньше, подтверждает
 * сам Telegram при UpdateUsername.
 */
export function generateUsername(nickPrefix: string): string {
    const i = Math.floor(Math.random() * SUFFIX_WORDS.length);
    let j = Math.floor(Math.random() * (SUFFIX_WORDS.length - 1));
    if (j >= i) j++; // второе слово гарантированно отличается от первого
    const sep = Math.random() < 0.5 ? "_" : "";
    return `${nickPrefix}_${SUFFIX_WORDS[i]}${sep}${SUFFIX_WORDS[j]}`;
}

/** `count` различных случайных слов из словаря (без повторов). */
function pickDistinctWords(count: number): string[] {
    const pool = [...SUFFIX_WORDS];
    const out: string[] = [];
    for (let c = 0; c < count && pool.length > 0; c++) {
        const idx = Math.floor(Math.random() * pool.length);
        out.push(pool.splice(idx, 1)[0]);
    }
    return out;
}

/**
 * username публичного канала — самостоятельный, случайный человекочитаемый, НЕ
 * производный от username аккаунта и НЕ связанный с персоной (template-channel-phase1).
 * Три разных слова из словаря через "_", без цифрового хвоста: ~205k комбинаций
 * (60×59×58), коллизии редки; при занятости клеймящий код регенерирует и повторяет.
 */
export function generateChannelUsername(): string {
    return pickDistinctWords(3).join("_");
}

/**
 * Проверка пригодности одного пул-аккаунта подключением его сессией (`{ pool: true }`
 * — без персоны) и `getMe()`:
 * - `"ok"` — валиден;
 * - `"invalid"` — аккаунтная ошибка (бан/невалидная сессия), подлежит карантину;
 * - `"skip"` — прочая ошибка (прокси/сеть), карантин не нужен (останется в пуле).
 */
export async function validatePoolAccount(poolId: string, log: Logger): Promise<"ok" | "invalid" | "skip"> {
    const tg = new TelegramService(log);
    // proxy-failure-rotation: пул-валидация — потребитель с опт-ином счётчика провалов
    // прокси наравне с диспетчером/funnel-tracker. Без него деградировавший прокси пул-
    // аккаунта (probe проходит, боевой getMe — нет) навсегда даёт "skip", и аккаунт
    // остаётся в пуле нерабочим; с ним по достижении порога прокси ротируется инлайн.
    tg.enableProxyHealthTracking();
    try {
        tg.loadAccount(poolId, { pool: true });
        await tg.withActiveClient((client) => client.getMe());
        return "ok";
    } catch (err: any) {
        // Занятый session-лок — временное состояние (аккаунт держит другой процесс),
        // НЕ признак невалидности: пропускаем, аккаунт остаётся в пуле. Иначе один
        // зависший процесс, держащий локи, отправил бы весь пул в карантин (реальный
        // инцидент 27.09: зависший proxy-процесс → массовый ложный account_invalid).
        if (err instanceof SessionBusyError) return "skip";
        return classifyAccountError(err) ? "invalid" : "skip";
    } finally {
        await tg.disconnectAgent(poolId).catch(() => {});
    }
}

/**
 * Первый пригодный пул-аккаунт в порядке «старейший первым» (общий для потребителей
 * пула). Невалидный уводится в карантин; при сетевой ошибке аккаунт пропускается и
 * остаётся в пуле. Возвращает `poolId` или null, если пригодных нет.
 */
export async function findValidPoolAccount(log: Logger): Promise<string | null> {
    for (const poolId of listPoolAccountsOldestFirst()) {
        const verdict = await validatePoolAccount(poolId, log);
        if (verdict === "ok") {
            log.info(`[pool] пул-аккаунт ${poolId} валиден — берём`);
            return poolId;
        }
        if (verdict === "invalid") {
            log.warn(`[pool] пул-аккаунт ${poolId} непригоден — карантин`);
            quarantinePoolAccount(poolId);
        } else {
            log.warn(`[pool] пул-аккаунт ${poolId}: ошибка подключения — пропуск, остаётся в пуле`);
        }
    }
    return null;
}
