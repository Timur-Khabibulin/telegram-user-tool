#!/usr/bin/env bash
# Verify agent installation. Usage: verify-agent.sh <agentName> <telegram_user_id>
# All variables are local to this script — nothing leaks into caller environment.

set -u

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <agentName> <telegram_user_id>" >&2
  exit 2
fi

name="$1"
user_id="$2"
ws="$HOME/.openclaw/workspace-$name"
ad="$HOME/.openclaw/agents/$name/agent"

results=()
mark() { results+=("$1"); }

if openclaw agents list --json | jq -e --arg id "$name" 'any(.[]; .id == $id)' >/dev/null 2>&1; then
  mark "  [✓] A1 — агент зарегистрирован"
else
  mark "  [✗] A1 — агент НЕ зарегистрирован"
fi

if openclaw config get channels.telegram.accounts.agentsBot.allowFrom --json \
   | jq -e --arg id "$user_id" 'any(.[]; tostring == $id)' >/dev/null 2>&1; then
  mark "  [✓] A2 — telegram_user_id в allowFrom"
else
  mark "  [✗] A2 — telegram_user_id НЕ в allowFrom"
fi

if openclaw config get bindings --json \
   | jq -e --arg n "$name" --arg id "$user_id" \
       'any(.[]; .agentId == $n and (.match.peer.id|tostring) == $id)' >/dev/null 2>&1; then
  mark "  [✓] A3 — биндинг настроен"
else
  mark "  [✗] A3 — биндинг отсутствует"
fi

if jq -e '(.sessionString // "") != "" and (.apiId // null) != null and (.apiHash // "") != ""' \
   "$ws/tg-account.json" >/dev/null 2>&1; then
  mark "  [✓] B1 — tg-account.json валиден"
else
  mark "  [✗] B1 — tg-account.json НЕ валиден"
fi

if [ -s "$ws/SOUL.md" ]; then
  mark "  [✓] B2 — SOUL.md непустой"
else
  mark "  [✗] B2 — SOUL.md пуст"
fi

if [ -s "$ad/auth-profiles.json" ] && [ -s "$ad/models.json" ]; then
  mark "  [✓] B5 — agent-конфиги скопированы"
else
  mark "  [✗] B5 — agent-конфиги отсутствуют"
fi

echo "Проверка агента $name:"
printf '%s\n' "${results[@]}"
ok=$(printf '%s\n' "${results[@]}" | grep -c '\[✓\]')
echo
echo "Итого: $ok/${#results[@]} OK."