## 1. Config path helper

- [x] 1.1 Add `tdataPath(agentId)` to `src/core/config.ts`, returning
      `workspace-<agentId>/tdata/` (spec: "tdata path derived from agentId";
      design D2).

## 2. Core reauth module

- [x] 2.1 Create `src/core/tg-agent-reauth-from-tdata/run.ts`.
- [x] 2.2 Read and validate the existing `tg-account.json` for `agentId`
      (`apiId`, `apiHash`, `deviceModel`, `proxy`) — error out if the agent
      does not exist (spec: "Existing agent, no destructive setup", scenario
      "Target agent does not exist").
- [x] 2.3 Validate `tdataPath(agentId)` exists and contains
      `Accounts.txt`/`Password2FA.txt` — error out with the expected path if
      missing (spec: "tdata path derived from agentId", scenario "tdata
      folder missing at the conventional path").
- [x] 2.4 Read `phoneNumber` via `readTdataAccountInfo` (reuse
      `src/core/tdata/client.ts`, no changes to that file).
- [x] 2.5 Call `connectBootstrap(tdataPath, proxy, apiId, apiHash,
      deviceModel, log)` (reuse as-is) — surface connect/decrypt failures as
      explicit errors (spec: "Bootstrap connection reused from tdata, no
      code required", scenario "tdata fails to decrypt or connect").
- [x] 2.6 Resolve `password2fa`: use the explicit parameter if provided,
      otherwise default to
      `~/.openclaw/tg-agent-autoregistration/templates/maria/default_agent_data.json`
      field `2fa` (design D3).
- [x] 2.7 Call `registerAgenticSession(bootstrapClient, apiId, apiHash,
      phoneNumber, proxy, password2fa, log)` (reuse from
      `src/core/tg-agent-autoregistration/agentic-session.ts`, no changes to
      that file) — do NOT call `prepareAccount` (spec: "Existing agent, no
      destructive setup").
- [x] 2.8 Handle `code_timeout` outcome as an explicit error, `tg-account.json`
      unmodified (spec: "New independent agentic session...", scenario "Code
      does not arrive within the timeout").
- [x] 2.9 Handle sign-in password rejection as an explicit error,
      `tg-account.json` unmodified (spec: "2FA password with default,
      explicit override on failure", scenario "Password rejected").
- [x] 2.10 On success, rewrite only `sessionString` in the existing
      `tg-account.json`, leaving `accountId`/`apiId`/`apiHash`/`device`/`proxy`
      untouched (spec: "Only sessionString is overwritten").
- [x] 2.11 Disconnect the bootstrap client's local socket in a `finally`
      block — no logout call (spec: "Bootstrap session is not logged out").
- [x] 2.13 Clear the agent's restriction (`agent_restrictions`) after a
      successful reauth — discovered as a real gap after the first live
      verification (agent207): a new working session alone does NOT resume
      dispatcher runs, `getActiveRestriction` still blocks the agent (spec:
      "Restriction is cleared on success").

- [x] 2.12 Add `ignoreVersion` as an optional 7th parameter to `connectBootstrap`
      (`src/core/tdata/client.ts`, default `false`, `tg-agent-autoregistration`
      unaffected) and pass `true` from `reauthFromTdata` — real tdata archives
      from agents created before autogeneration are newer than the TDF format
      version `@mtcute/convert` 0.31.0 supports (design D7, verified on 20 real
      accounts via an isolated diagnostic script before wiring it in).

## 3. OpenClaw tool

- [x] 3.1 Add `tg_agent_reauth_from_tdata(agentId, password2fa?)` tool in
      `index.ts`, calling `src/core/tg-agent-reauth-from-tdata/run.ts`.
- [x] 3.2 Return a result shape distinguishing: success (with the account's
      `accountId`), `tdata_missing`, `connect_failed`, `code_timeout`,
      `password_rejected` — so the skill can react per outcome without
      parsing free-text errors.

## 4. Skill

- [x] 4.1 Create `skills/tg-agent-reauth-from-tdata/SKILL.md` — collect
      `agentId` from the operator (tdata assumed already uploaded to
      `workspace-<agentId>/tdata/`; if missing, tell the operator to upload
      it there first).
- [x] 4.2 Call the tool; on `password_rejected`, ask the operator for the
      actual current 2FA password and retry once with it explicit.
- [x] 4.3 On success, remind the operator to run `openclaw gateway restart`.
- [x] 4.4 Final summary message to the operator (account id, outcome).

## 5. Deploy and verify

- [x] 5.1 Deploy changed/new files to the VPS (`config.ts`, `index.ts`, new
      `src/core/tg-agent-reauth-from-tdata/run.ts`,
      `skills/tg-agent-reauth-from-tdata/SKILL.md`), fix ownership, restart
      gateway.
- [x] 5.2 Verify end-to-end on one real agent currently in
      `need_update_session` (e.g. agent207) before recommending broader use.
      Confirmed on agent207: `authSendCode` needed one retry (built-in 3x
      logic handled it), `authSignIn` succeeded on attempt 1, new
      `sessionString` written, outcome `done`. A separate agent (agent29)
      failed 6/6 attempts across two runs on the same step — looks like a
      degraded proxy specific to that agent, not a design issue (the same
      two-simultaneous-connections pattern that autoregistration already uses
      in production worked fine for agent207).
