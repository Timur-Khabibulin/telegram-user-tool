// skills/util.ts — общие помощники оркестрации скиллов.
//
// Паузы и обработка FLOOD_WAIT перенесены из SKILL.md один-в-один (R-B2).
// Ядро (TelegramService) бросает ошибки Telegram как исключения; скиллы ловят
// их и реализуют поведение «подождать и повторить, иначе прервать весь
// прогон», описанное в каждом SKILL.md. Сам ретрай (сколько раз, какой порог)
// — общая политика `retryOnFloodWait` в core/telegram/errors.ts
// (telegram-error-handling) — не дублируется здесь; этот модуль только
// добавляет skill-специфичный исход «повтор исчерпан → прервать весь прогон»
// (`FloodAbortError`), которого у core/telegram нет и не должно быть (ядро не
// знает про понятие «прогон скилла»).

import { parseFloodWait, retryOnFloodWait } from "../core/telegram/errors";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Случайная пауза в миллисекундах в диапазоне [minSec, maxSec]. */
export function randomDelayMs(minSec: number, maxSec: number): number {
    return (minSec + Math.random() * (maxSec - minSec)) * 1000;
}

/** Случайная пауза [minSec, maxSec] секунд (human-pacing monitor-v5). */
export const sleepRandom = (minSec: number, maxSec: number): Promise<void> =>
    sleep(randomDelayMs(minSec, maxSec));

/** Случайное число в диапазоне [min, max]. */
export function randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

/**
 * Повторный FLOOD_WAIT после исчерпания ретраев: задача требует прервать весь
 * прогон (см. SKILL.md шаги 5.1 / 4.1 / 5.6.4 / 8). Скилл ловит этот тип и
 * завершает прогон.
 */
export class FloodAbortError extends Error {
    constructor() {
        super("Repeated FLOOD_WAIT — aborting run");
        this.name = "FloodAbortError";
    }
}

/**
 * Выполняет операцию Telegram через общую политику ретраев `retryOnFloodWait`
 * (до 2 повторов, порог перепроверяется на каждом шаге —
 * telegram-error-handling №9/№28); если флуд пережил все повторы или сразу
 * был на пороге/выше — бросает `FloodAbortError` (сигнал для скилла: прервать
 * весь прогон). Не-flood ошибки пробрасываются как есть.
 */
export async function withFloodRetry<T>(fn: () => Promise<T>, log: { warn(m: string): void }): Promise<T> {
    try {
        return await retryOnFloodWait(fn, log);
    } catch (err: any) {
        if (parseFloodWait(err) !== null) {
            throw new FloodAbortError();
        }
        throw err;
    }
}
