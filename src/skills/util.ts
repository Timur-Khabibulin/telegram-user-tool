// skills/util.ts — общие помощники оркестрации скиллов.
//
// Паузы и обработка FLOOD_WAIT перенесены из SKILL.md один-в-один (R-B2).
// Ядро (TelegramService) бросает ошибки Telegram как исключения; скиллы ловят
// их и реализуют поведение «подождать X и повторить один раз», описанное в
// каждом SKILL.md.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Извлекает X из "FLOOD_WAIT_X"; null, если это не FLOOD_WAIT. */
export function parseFloodWait(msg: string): number | null {
    const m = msg.match(/FLOOD_WAIT[_ ](\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

/** Случайная пауза в миллисекундах в диапазоне [minSec, maxSec]. */
export function randomDelayMs(minSec: number, maxSec: number): number {
    return (minSec + Math.random() * (maxSec - minSec)) * 1000;
}

/**
 * Повторный FLOOD_WAIT: задача требует прервать весь прогон (см. SKILL.md
 * шаги 5.1 / 4.1 / 5.6.4 / 8). Скилл ловит этот тип и завершает прогон.
 */
export class FloodAbortError extends Error {
    constructor() {
        super("Repeated FLOOD_WAIT — aborting run");
        this.name = "FloodAbortError";
    }
}

/**
 * Выполняет операцию Telegram с политикой «при FLOOD_WAIT подождать X и
 * повторить один раз»: при повторном FLOOD_WAIT бросает FloodAbortError, прочие
 * ошибки пробрасывает как есть (вызывающий решает — пропустить или прервать).
 */
export async function withFloodRetry<T>(fn: () => Promise<T>, log: { warn(m: string): void }): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        const waitSec = parseFloodWait(err?.message ?? String(err));
        if (waitSec === null) throw err;
        log.warn(`[skill] FLOOD_WAIT ${waitSec}s — waiting and retrying once`);
        await sleep(waitSec * 1000);
        try {
            return await fn();
        } catch (retryErr: any) {
            if (parseFloodWait(retryErr?.message ?? String(retryErr)) !== null) {
                throw new FloodAbortError();
            }
            throw retryErr;
        }
    }
}
