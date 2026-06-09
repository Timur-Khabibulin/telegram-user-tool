// core/logger.ts — инжектируемый интерфейс логирования ядра.
//
// Ядро не знает, куда пишутся логи. Плагин OpenClaw передаёт сюда `api.logger`,
// диспетчер — свой логгер поверх stdout (journald). DIP: ядро зависит от
// абстракции, а не от конкретной реализации логирования платформы.

export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
