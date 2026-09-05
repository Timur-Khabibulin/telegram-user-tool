## 1. Spike — validate tdata decryption before building on it

> Не запускался как отдельный черновой скрипт — подтверждён напрямую боевыми
> прогонами `tg_agent_autoregistration_run`/`tg_agent_autoregistration_retry_code`
> на реальных закупленных tdata (не на локальном `3453453453/tdata`). Минимум
> один аккаунт (`agent220`) прошёл весь пайплайн до `done`.

- [x] 1.1 `@mtcute/convert` расшифровывает реальные tdata, собранная сессия
      проходит `getMe()` — подтверждено на нескольких аккаунтах в проде.
- [x] 1.2 ESM/CJS-совместимость `@mtcute/convert`/`@mtcute/core` с `tsx`/
      `tsconfig.json` проекта — рабочая, ни одной ошибки импорта за все прогоны.
- [x] 1.3 Итог записан в `docs/design/tg-agent-autoregistration/architecture.md`
      §2.1 — вариант A2 подтверждён, фолбэк на вариант C не понадобился.

## 2. Dependencies and scaffolding

- [x] 2.1 Add `@mtcute/convert` to `package.json`.
- [x] 2.2 Create `src/core/tdata/` module skeleton.
- [x] 2.3 Create `src/core/tg-agent-autoregistration/` module skeleton.

## 3. tdata → bootstrap session

- [x] 3.1 Implement `connect(tdataPath, proxy, apiId, apiHash)` in
      `src/core/tdata/` using `@mtcute/convert` (spec: "Bootstrap session
      decrypted from tdata"; design D2).
- [x] 3.2 Implement `readPhoneNumber`/`readCurrentPassword` from
      `tdata/Accounts.txt` / `tdata/Password2FA.txt` (spec: "Account setup on
      the bootstrap session"; R-2/R-3).
- [x] 3.3 Distinguish connect-level failures from account-setup failures in
      the module's error surface, so the caller can classify `proxy_failed`
      vs `setup_failed` (spec: "Mobile proxy selection per account", "Account
      setup on the bootstrap session").

## 4. Account setup calls (GramJS)

- [x] 4.1 Implement cleanup: `photos.getUserPhotos`+`photos.deletePhotos`,
      `channels.getAdminedPublicChannels`+`channels.deleteChannel`
      (unconditional — spec: "Account setup on the bootstrap session",
      scenario "Prior state is removed unconditionally"; design D5).
- [x] 4.2 Implement 2FA change via `client.updateTwoFaSettings` (current
      password from `tdata/Password2FA.txt`, new password from
      `default_agent_data.json`).
- [x] 4.3 Implement `auth.resetAuthorizations`.
- [x] 4.4 Implement profile update: `account.updateProfile`,
      `account.updateUsername` (with generated username — spec: "Unique,
      human-readable account identity per persona"), `account.updateBirthday`.
- [x] 4.5 Implement profile photo upload loop over all `photo_profile_N`
      files (`uploadFile` + `photos.uploadProfilePhoto`).
- [x] 4.6 Implement channel creation (`channels.createChannel` +
      `channels.updateUsername`), post (`messages.sendMessage`), and personal
      channel association (`account.updatePersonalChannel`) — in that order
      (design D2/§2.3 dependency).
- [x] 4.7 Map Telegram API errors from steps 4.1–4.6 to `setup_failed` with
      the original error code preserved.

## 5. Username generation

- [x] 5.1 Implement human-readable random suffix generator, combined with the
      persona's `nick` prefix (spec: "Unique, human-readable account identity
      per persona"; R-4).

## 6. Proxy selection

- [x] 6.1 Integrate `provision-proxy-for-new-agent.ts` as a subprocess call
      (`--create-candidate`/`--delete-candidate`) from the retry loop — no
      changes to that script itself (design D6).
- [x] 6.2 Implement retry loop: new candidate per attempt, up to
      `maxProxyAttempts`, stop immediately on `setup_failed` without
      retrying proxies (spec: "Mobile proxy selection per account"; R-1/R-12).

## 7. Second (agentic) session

- [x] 7.1 Implement `authSendCode` using the persona's shared apiId/apiHash.
- [x] 7.2 Implement `readIncomingCode` on the bootstrap session with a fixed
      2-minute timeout (R-D5).
- [x] 7.3 Implement `authSignIn` → `agentSessionString` on success; leave the
      bootstrap session connected/active, do not log it out (design D3).
- [x] 7.4 On timeout, record `needs_manual_code` and continue to the next
      account.

## 8. Staging and atomic promotion

- [x] 8.1 Implement pre-flight checks: persona template validation (R-10),
      agent ID range vs `listAgentIds()` and existing staging (R-8/R-11) —
      before any download.
- [x] 8.2 Implement archive download into
      `~/.openclaw/tg-agent-autoregistration/staging/agent<N>/tdata/`
      (one archive per `megaLinks` entry) — `megajs` (`File.fromURL` на
      публичную share-ссылку на папку, без аккаунта), структура подтверждена
      живым прогоном на реальной ссылке.
- [x] 8.3 Implement `status.json` writes via tmp-file + `renameSync` (atomic)
      for every status transition.
- [x] 8.4 On `done`, assemble `tdata/` + `tg-account.json` (full schema:
      apiId, apiHash, sessionString, proxy, device) + `SOUL.md` fully inside
      the staging entry, then `renameSync(staging, workspace-agent<N>)` as
      the final step.
- [x] 8.5 Leave `proxy_failed`/`setup_failed`/`needs_manual_code` staging
      entries untouched for manual review (R-9) — no automatic cleanup.
- [x] 8.6 Implement `retryManualCode` (R-9a) — retries only the second
      session (`authSendCode`/`readIncomingCode`/`authSignIn`) for an account
      stuck on `needs_manual_code`, reusing the tdata already in staging,
      without repeating account setup. Added post-launch, during live
      debugging of a real `needs_manual_code` case — not in the original
      task list.

## 9. Orchestration, entry points, reporting

- [x] 9.1 Implement `src/core/tg-agent-autoregistration/run.ts`: sequential
      per-account loop wiring together sections 3–8.
- [x] 9.2 Implement `src/scripts/tg-agent-autoregistration.ts` CLI wrapper.
- [x] 9.3 Register one OpenClaw tool in root `index.ts` delegating directly
      to `run.ts` (no LLM step loop — design D1).
- [x] 9.4 Write `skills/tg-agent-autoregistration/SKILL.md` (single-call
      invocation, by the pattern of the proxy-provisioning step in
      `skills/tg-agent-create/SKILL.md`).
- [x] 9.5 Implement batch summary report (per-account status list) returned
      to the operator.
- [x] 9.6 Register `tg_agent_autoregistration_retry_code` tool + CLI
      (`src/scripts/tg-agent-autoregistration-retry-code.ts`) for R-9a.

## 10. Documentation

- [x] 10.1 Add `tg-agent-autoregistration` to `docs/README.md`/`docs/architecture.md`
      where other skills/components are indexed.
- [x] 10.2 Document the new VPS paths
      (`~/.openclaw/tg-agent-autoregistration/{templates,staging}/`) and the
      `@mtcute/convert` dependency in `docs/configuration.md`.
