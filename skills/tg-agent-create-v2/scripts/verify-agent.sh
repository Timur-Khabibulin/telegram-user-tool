#!/usr/bin/env bash
# Verify agent installation (tg-agent-create-v2 — no OpenClaw registration to check;
# see tg-agent-create/scripts/verify-agent.sh for the v1 checks A1/A2/A3/B5).
# Usage: verify-agent.sh <agentName>
# All variables are local to this script — nothing leaks into caller environment.

set -u

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <agentName>" >&2
  exit 2
fi

name="$1"
ws="$HOME/.openclaw/workspace-$name"

results=()
mark() { results+=("$1"); }

if [ -d "$ws" ]; then
  mark "  [✓] B0 — workspace существует"
else
  mark "  [✗] B0 — workspace НЕ существует"
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

echo "Проверка агента $name:"
printf '%s\n' "${results[@]}"
ok=$(printf '%s\n' "${results[@]}" | grep -c '\[✓\]')
echo
echo "Итого: $ok/${#results[@]} OK."
