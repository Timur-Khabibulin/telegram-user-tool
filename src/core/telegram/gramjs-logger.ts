// core/telegram/gramjs-logger.ts — мост GramJS-логгера в наш Logger.
//
// GramJS пишет через собственный класс Logger; перенаправляем его строки в
// инжектируемый Logger ядра, чтобы вывод GramJS шёл в тот же канал, что и
// остальные логи (журнал плагина или stdout диспетчера).

import { Logger as GramJsLogger, LogLevel } from "telegram/extensions/Logger";
import type { Logger } from "../logger";

export class GramJsBridgeLogger extends GramJsLogger {
    constructor(private readonly sink: Logger) {
        super(LogLevel.NONE);
    }

    log(level: LogLevel, message: string, _color: string) {
        switch (level) {
            case LogLevel.ERROR: this.sink.error(`[gramjs] ${message}`); break;
            case LogLevel.WARN:  this.sink.warn(`[gramjs] ${message}`);  break;
            case LogLevel.INFO:  this.sink.info(`[gramjs] ${message}`);  break;
            case LogLevel.DEBUG: this.sink.info(`[gramjs] ${message}`);  break;
        }
    }
}
