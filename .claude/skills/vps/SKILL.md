---
name: vps
description: Upload or download files to/from the VPS server, or run server commands. Use when the user wants to sync files with the server, update remote files, download db files, or restart services.
---

VPS connection uses `ssh -i ~/.ssh/vps_key`. Credentials and paths are in `local.properties`:

| Variable | Value |
|---|---|
| Host | `root@<VPS_HOST>` |
| Plugin dir | `~/openclaw-plugins/telegram-user-tool/` |
| Skills dir | `~/.openclaw/workspace/skills/` |
| Agent workspace | `~/.openclaw/workspace-<agentId>/` |
| Config | `~/.openclaw/openclaw.json` |

---

## Ограничения на выполнение команд

- **Таймаут и завершаемость.** Произвольные команды, выполняемые на ВПС через
  `ssh` (не относится к вызовам `openclaw <subcommand>`), запускать с явным
  таймаутом и так, чтобы они завершались сами — не оставлять процесс висеть в
  фоне после выполнения (не использовать `&`/`nohup` без явного запроса именно
  долгоживущего процесса).
- **Параллельные подключения.** Не открывать несколько одновременных
  SSH/SCP-подключений к серверу — выполнять команды последовательно. Лимит на
  число подключений уже задан на стороне ВПС.

---

**Download db files** (e.g. "обнови db/agent1 с сервера")

```
scp -i ~/.ssh/vps_key root@<VPS_HOST>:~/.openclaw/workspace-<agentId>/tg-channels.db   db/<agentId>/tg-channels.db
scp -i ~/.ssh/vps_key root@<VPS_HOST>:~/.openclaw/workspace-<agentId>/tg-join-queue.db db/<agentId>/tg-join-queue.db
scp -i ~/.ssh/vps_key root@<VPS_HOST>:~/.openclaw/workspace-<agentId>/tg-replies.db    db/<agentId>/tg-replies.db
```

If agentId is not specified — ask.

---

**Upload file to server** (e.g. "обнови SOUL.md на сервере")

Map local paths to remote paths:

| Local | Remote |
|---|---|
| `SOUL.md` | `~/.openclaw/workspace-<agentId>/SOUL.md` |
| `skills/<name>/SKILL.md` | `~/.openclaw/workspace/skills/<name>/SKILL.md` |
| `src/*` | `~/openclaw-plugins/telegram-user-tool/` |
| `index.ts` | `~/openclaw-plugins/telegram-user-tool/` |

```
scp -i ~/.ssh/vps_key <local-path> root@<VPS_HOST>:<remote-path>
```

If agentId is needed but not specified — ask.

---

**Run server command** (e.g. "перезапусти gateway")

```
ssh -i ~/.ssh/vps_key root@<VPS_HOST> "<command>"
```

Common commands:
- `openclaw gateway restart` — restart the gateway service
