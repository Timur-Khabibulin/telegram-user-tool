// core/tdata/index.ts — публичный барьер модуля (роль "Скрипт tdata" на диаграмме).

export { TdataConnectError, TdataSetupError } from "./errors";
export { readTdataAccountInfo, connectBootstrap, readIncomingCode, type TdataAccountInfo } from "./client";
export { prepareAccount, type PrepareAccountResult } from "./account-setup";
