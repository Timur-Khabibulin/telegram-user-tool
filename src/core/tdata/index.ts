// core/tdata/index.ts — публичный барьер модуля (роль "Скрипт tdata" на диаграмме).

export { TdataConnectError, TdataSetupError } from "./errors";
export { readTdataAccountInfo, readAccountPhone, connectBootstrap, readIncomingCode, type TdataAccountInfo } from "./client";
export { prepareAccount, prepareEmptyPoolAccount, setupReplacementAccount, createPersonaChannel, type PrepareAccountResult } from "./account-setup";
