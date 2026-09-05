## ADDED Requirements

### Requirement: Pre-flight validation before any account processing
The system SHALL validate the persona template and the target agent ID range
before downloading any tdata archive or mutating any state.

#### Scenario: Persona template missing or incomplete
- **WHEN** the operator starts a run with `personName` and
  `~/.openclaw/tg-agent-autoregistration/templates/<personName>/` does not
  exist or is missing a required file
- **THEN** the system reports an error to the operator and stops without
  downloading anything

#### Scenario: Agent ID range collides with existing agents or staging
- **WHEN** the computed range `startAgentNumber..startAgentNumber+N-1`
  (where `N` is the number of links in `megaLinks`) overlaps with an
  existing `workspace-<agentId>` directory or an unresolved staging entry
  from a previous run
- **THEN** the system reports an error to the operator and stops without
  downloading anything

#### Scenario: Template valid and range free
- **WHEN** the persona template is complete and the ID range is free
- **THEN** the system proceeds to download tdata archives

### Requirement: One tdata archive maps to exactly one account
The system SHALL treat each link in `megaLinks` as exactly one tdata archive
containing exactly one account, and SHALL download all archives into a
per-account staging directory before processing any account.

#### Scenario: Batch download into staging
- **WHEN** the pre-flight checks pass
- **THEN** the system downloads every archive from `megaLinks` into
  `~/.openclaw/tg-agent-autoregistration/staging/agent<N>/tdata/` — not into
  `~/.openclaw/workspace-agent<N>/` — one archive per account, before any
  account-level processing begins

### Requirement: Mobile proxy selection per account
The system SHALL request a fresh proxy candidate for each connection attempt
and SHALL stop retrying once a working candidate is found or the attempt
limit is reached.

#### Scenario: Candidate fails to connect
- **WHEN** a proxy candidate fails to establish an MTProto connection to the
  account's tdata session
- **THEN** the system discards the candidate and requests a new one from
  asocks, up to `maxProxyAttempts` times per account

#### Scenario: Attempts exhausted without a working proxy
- **WHEN** `maxProxyAttempts` candidates have all failed to connect for an
  account
- **THEN** the system records status `proxy_failed` for that account in its
  staging entry and moves to the next account

### Requirement: Bootstrap session decrypted from tdata
The system SHALL derive a working MTProto session from the account's tdata
folder without requiring a TDesktop local passcode, using the apiId/apiHash
shared by the selected persona.

#### Scenario: tdata decrypts successfully
- **WHEN** a proxy candidate connects successfully
- **THEN** the system obtains a bootstrap MTProto session (`dcId`+`authKey`)
  from the account's tdata folder and proceeds to account setup

### Requirement: Account setup on the bootstrap session
The system SHALL, on the bootstrap session, unconditionally remove any
existing profile photos and any public channels the account administers,
change the 2FA password, terminate all other active sessions, and apply the
persona's profile, photo(s), and channel — before any of this account's
sessions is used for anything else.

#### Scenario: Prior state is removed unconditionally
- **WHEN** account setup begins for an account that already has profile
  photos and/or public channels from prior use
- **THEN** the system deletes all existing profile photos and all public
  channels the account administers, regardless of whether the account is
  actually close to any Telegram-imposed public-channel limit

#### Scenario: 2FA password changed from the archive-provided current password
- **WHEN** account setup proceeds to the password step
- **THEN** the system changes the 2FA password using the current password
  found in the account's own `tdata/Password2FA.txt` and the new password
  from the persona's `default_agent_data.json`

#### Scenario: All persona profile photos are applied
- **WHEN** the persona template contains multiple `photo_profile_N` files
- **THEN** the system uploads every one of them to the account's profile, not
  only the first

#### Scenario: Public channel created and pinned to the profile
- **WHEN** profile and photos have been applied
- **THEN** the system creates a public channel using the persona's
  `channelName`, posts the persona's content to it, and associates it as the
  account's personal (pinned) channel

#### Scenario: Telegram API rejects a setup step
- **WHEN** any setup call (2FA change, session reset, cleanup, profile,
  channel creation) is rejected by Telegram with an API error (for example
  `USERNAME_OCCUPIED`, `PASSWORD_HASH_INVALID`, `FLOOD_WAIT`,
  `CHANNELS_ADMIN_PUBLIC_TOO_MUCH`, `CHANNEL_TOO_LARGE`)
- **THEN** the system records status `setup_failed` with the error for that
  account and moves to the next account without retrying with a different
  proxy candidate

### Requirement: Unique, human-readable account identity per persona
The system SHALL derive a unique username per account from the persona's
shared `nick` prefix plus a randomized human-readable suffix, so that
multiple accounts sharing one persona template do not collide on username.

#### Scenario: Username generated per account
- **WHEN** account setup applies the profile
- **THEN** the resulting username is the persona's `nick` followed by a
  randomly generated, human-readable suffix that is not a hash-like string

### Requirement: Second MTProto session registered for platform use
The system SHALL register a second, independent MTProto session for the
account using the persona's shared apiId/apiHash, separate from the
bootstrap session, and SHALL use the still-connected bootstrap session to
receive the login code for this second session.

#### Scenario: Login code received in time
- **WHEN** the system requests a login code for the second session and the
  bootstrap session receives it within 2 minutes
- **THEN** the system completes sign-in for the second session, writes
  `tg-account.json` (including the resulting session string, the proxy used,
  and device info) and `SOUL.md` for the account, and records status `done`

#### Scenario: Login code not received in time
- **WHEN** the login code is not received via the bootstrap session within 2
  minutes (timeout, or the code arrives as SMS instead of an in-app message)
- **THEN** the system records status `needs_manual_code` for that account and
  moves to the next account

#### Scenario: Bootstrap session remains active after handoff
- **WHEN** the second session has been successfully registered
- **THEN** the bootstrap session is left active rather than being logged out
  — the account ends the run with two concurrently active sessions

### Requirement: Non-done accounts stay in staging until manually resolved
The system SHALL NOT automatically clean up or re-offer for reprocessing any
account whose status is `proxy_failed`, `setup_failed`, or
`needs_manual_code`.

#### Scenario: Failed or manual-review account blocks its agent ID
- **WHEN** an account finishes a run with a status other than `done`
- **THEN** its staging entry (including `tdata/`) remains in place, and any
  later run whose ID range overlaps that entry is stopped by pre-flight
  validation until an operator manually resolves it

### Requirement: Second-session retry for accounts stuck on needs_manual_code
The system SHALL provide a way to retry only the second (agentic) session
registration for an account whose staging status is `needs_manual_code`,
without repeating account setup (2FA change, session reset, cleanup,
profile, channel), since that setup has already been applied to the real
Telegram account and re-applying the password change would fail.

#### Scenario: Retry succeeds
- **WHEN** an operator retries an account whose staging status is
  `needs_manual_code`
- **THEN** the system selects a proxy, reconnects the bootstrap session from
  the same tdata already in staging, and repeats only `authSendCode` /
  `readIncomingCode` / `authSignIn` — account setup is not repeated

#### Scenario: Retry rejected for a non-matching status
- **WHEN** an operator retries an account whose staging status is not
  `needs_manual_code` (including no staging entry at all)
- **THEN** the system refuses without attempting a connection

### Requirement: Completed accounts are promoted atomically
The system SHALL only make a newly-registered agent visible to the rest of
the platform (i.e. discoverable via the existing agent-workspace convention)
once every artifact for that agent is fully assembled.

#### Scenario: Atomic promotion on success
- **WHEN** an account reaches `done`
- **THEN** the system assembles `tdata/`, `tg-account.json`, and `SOUL.md`
  fully within the staging entry first, then moves the entire entry into
  `workspace-agent<N>/` as a single atomic operation

### Requirement: Batch summary report
The system SHALL report the outcome of every account processed in a run to
the operator once the run completes.

#### Scenario: Run completes
- **WHEN** all accounts in the batch have been processed (in any terminal
  status)
- **THEN** the operator receives a report listing, per account, one of
  `done` / `proxy_failed` / `setup_failed` / `needs_manual_code`
