// scripts/channel-metrics.ts — CLI-вход для core/channel-metrics/run.ts.
//
// Ручной операторский инструмент (не dispatcher/systemd): читает CSV со списком
// ссылок (колонка `link`), для каждой через MTProto одной сессии агента считает
// число подписчиков, средний охват последних постов, открыты ли комментарии
// (привязана ли группа обсуждения) и является ли канал broadcast-каналом.
// С флагом --with-niche дополнительно одним LLM-вызовом на канал определяет
// нишу/тематику (переиспользует уже полученные title/about/посты — без
// --with-niche LLM вообще не создаётся и не вызывается). Результат дописывается
// в выходной CSV построчно — прогон резюмируем: повторный запуск с тем же
// --output пропускает ссылки, уже присутствующие в файле (успешные и
// завершившиеся ошибкой), обрабатывает только остаток.
//
// Второй вход в ту же логику — инструмент tg_channel_metrics (index.ts), для
// вызова из OpenClaw без файлов на диске у оператора.
//
// Запуск: tsx src/scripts/channel-metrics.ts --input links.csv --output metrics.csv --agent agent8 [--with-niche]
// Spec: openspec/changes/channel-metrics/.

import * as fs from "fs";

import type { Logger } from "../core/logger";
import { runChannelMetrics, readCsvRows } from "../core/channel-metrics/run";
import { createLlmClient } from "../llm/client";

const log: Logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
};

function parseArg(argv: string[], flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const val = argv[idx + 1];
    if (!val || val.startsWith("--")) return undefined;
    return val;
}

/** Колонка `link` входного CSV — заголовок обязателен, прочие колонки игнорируются. */
function readInputLinks(inputPath: string): string[] {
    const rows = readCsvRows(fs.readFileSync(inputPath, "utf8"));
    if (rows.length === 0) throw new Error(`входной файл пуст: ${inputPath}`);
    const header = rows[0];
    const linkIdx = header.indexOf("link");
    if (linkIdx === -1) throw new Error(`во входном CSV нет колонки "link": ${inputPath}`);
    return rows.slice(1)
        .map((r) => (r[linkIdx] ?? "").trim())
        .filter((v) => v.length > 0);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const inputPath = parseArg(argv, "--input");
    const outputPath = parseArg(argv, "--output");
    const agentId = parseArg(argv, "--agent");
    const withNiche = argv.includes("--with-niche");

    if (!inputPath || !outputPath || !agentId) {
        log.error("usage: tsx src/scripts/channel-metrics.ts --input <links.csv> --output <metrics.csv> --agent <agentId> [--with-niche]");
        process.exit(1);
    }

    const links = readInputLinks(inputPath);
    const llm = withNiche ? createLlmClient() : undefined;

    const result = await runChannelMetrics({ links, agentId, outputPath, withNiche, llm }, log);

    log.info(
        `[channel-metrics] done — обработано: ${result.done}, пропущено (уже были в output): ${result.skipped}` +
        `${result.stoppedByFlood ? ", остановлено по FLOOD_WAIT (перезапустите с тем же --output)" : ""}`,
    );
    // GramJS не всегда полностью освобождает хэндлы после disconnect() (наблюдалось на
    // проде — процесс висел часами после "done", съедая память). Явный выход вместо
    // надежды на естественное опустошение event loop.
    process.exit(0);
}

main().catch((err) => {
    log.error(`[channel-metrics] fatal: ${err?.message ?? err}`);
    process.exit(1);
});
