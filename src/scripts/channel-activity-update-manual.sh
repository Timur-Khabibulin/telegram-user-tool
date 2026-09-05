#!/usr/bin/env bash
# Обёртка для tg-channel-activity-update-manual@.service — разбирает instance
# (agentId1-agentId2-...[.limitN]) в --agents/--limit для channel-activity-update.ts.
#
# Вынесена в отдельный файл, а не инлайн в ExecStart=, потому что systemd сам
# пытается развернуть $-конструкции в строке ExecStart= (даже внутри
# `bash -c '...'`) ДО того, как её увидит bash — bash-параметр-expansion
# (${I##*.limit}, ${I%.limit*}) ловился как обращение к несуществующей
# переменной окружения и падал с "Invalid environment variable name".
# Юнит вызывает этот файл с instance как позиционным аргументом (%i — там,
# где $ не нужен), весь bash-синтаксис живёт здесь, вне зоны parsing systemd.
set -euo pipefail

INSTANCE="$1"
LIMIT=""
AGENTS="$INSTANCE"
case "$INSTANCE" in
    *.limit*)
        LIMIT="${INSTANCE##*.limit}"
        AGENTS="${INSTANCE%.limit*}"
        ;;
esac
AGENTS="${AGENTS//-/,}"

cd /root/.openclaw/extensions/telegram-user-tool

ARGS=(--agents "$AGENTS")
if [ -n "$LIMIT" ]; then
    ARGS+=(--limit "$LIMIT")
fi

exec node_modules/.bin/tsx src/scripts/channel-activity-update.ts "${ARGS[@]}"
