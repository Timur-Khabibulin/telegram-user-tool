#!/usr/bin/env bash
# Create agent registration + binding + workspace file structure in one call
# (tg-agent-create-proxy-provisioning — replaces ~10 separate manual commands).
# Usage: create-agent-scaffold.sh <agentName> <telegram_user_id>
#
# SOUL.md is NOT created in the workspace — persona is a live-read shared template
# at ~/.openclaw/personas/<personName>/SOUL.md, referenced by tg-account.json's
# "persona" field (agent-persona-template), not copied per agent.

set -u

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <agentName> <telegram_user_id>" >&2
  exit 2
fi

name="$1"
user_id="$2"
ws="$HOME/.openclaw/workspace-$name"
ad="$HOME/.openclaw/agents/$name/agent"

if openclaw agents list --json | jq -e --arg id "$name" 'any(.[]; .id == $id)' >/dev/null 2>&1; then
  echo "Agent '$name' is already registered — aborting (idempotency guard)." >&2
  exit 1
fi

echo "Registering agent '$name'..."
openclaw agents add "$name" \
  --workspace "$ws" \
  --agent-dir "$ad" \
  --model openai-codex/gpt-5.4 \
  --json

echo "Adding binding for telegram_user_id=$user_id..."
next_index=$(openclaw config get bindings --json | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
openclaw config set "bindings[$next_index]" \
  "{\"agentId\":\"$name\",\"match\":{\"channel\":\"telegram\",\"accountId\":\"agentsBot\",\"peer\":{\"kind\":\"direct\",\"id\":\"$user_id\"}}}"

echo "Creating workspace file structure..."
mkdir -p "$ad"
cp "$HOME/.openclaw/agents/main/agent/auth-profiles.json" "$ad/"
cp "$HOME/.openclaw/agents/main/agent/models.json" "$ad/"

cat > "$ws/AGENTS.md" << 'EOF'
## Session Startup
Сначала прочитай:
1. Персону — поле "persona" в tg-account.json этого агента называет папку в
   ~/.openclaw/personas/<persona>/; прочитай оттуда SOUL.md — это кто я, мой
   стиль общения и строгие правила
2. MEMORY.md + memory/сегодня.md

Всегда строго следуй абсолютно всем правилам из SOUL.md.
EOF

touch "$ws/HEARTBEAT.md" "$ws/USER.md" "$ws/BOOTSTRAP.md" "$ws/IDENTITY.md" "$ws/TOOLS.md" "$ws/MEMORY.md"

echo "Agent '$name' scaffold created: $ws"
