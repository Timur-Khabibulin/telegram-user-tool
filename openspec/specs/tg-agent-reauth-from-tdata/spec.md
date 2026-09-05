# tg-agent-reauth-from-tdata Specification

## Purpose
TBD - created by archiving change tg-agent-reauth-from-tdata. Update Purpose after archive.
## Requirements
### Requirement: Existing agent, no destructive setup
The system SHALL reauthorize an existing agent identified by `agentId` (a
`workspace-<agentId>/tg-account.json` already exists) using its own tdata
session, and SHALL NOT perform any of the destructive account-setup steps
used for new-agent onboarding (no 2FA password change, no deletion of
profile photos, no deletion of public channels, no persona template
applied).

#### Scenario: Target agent does not exist
- **WHEN** the operator calls the tool with an `agentId` for which
  `workspace-<agentId>/tg-account.json` does not exist
- **THEN** the system reports an error and performs no Telegram operations

#### Scenario: Target agent exists and tdata is present
- **WHEN** `workspace-<agentId>/tg-account.json` exists and
  `workspace-<agentId>/tdata/` contains a valid tdata session
- **THEN** the system proceeds to bootstrap connection and session
  registration without touching the agent's profile, photos, or public
  channels

### Requirement: tdata path derived from agentId
The system SHALL derive the tdata path as `workspace-<agentId>/tdata/` and
SHALL NOT accept a separate tdata path as input.

#### Scenario: tdata folder missing at the conventional path
- **WHEN** `workspace-<agentId>/tdata/` does not exist or is missing
  `Accounts.txt`/`Password2FA.txt`
- **THEN** the system reports an error identifying the expected path and
  performs no Telegram operations

### Requirement: Bootstrap connection reused from tdata, no code required
The system SHALL establish a bootstrap MTProto connection by decrypting the
agent's tdata session (same mechanism as `tg-agent-autoregistration`'s
`connectBootstrap`) and SHALL NOT request or wait for an authorization code
to establish this connection, since the tdata session is already
authorized.

#### Scenario: tdata decrypts and connects successfully
- **WHEN** tdata is present and valid, and the agent's configured proxy is
  reachable
- **THEN** the system obtains a connected, authorized bootstrap client
  without any code prompt

#### Scenario: tdata fails to decrypt or connect
- **WHEN** tdata decryption fails, or the bootstrap connection cannot be
  established through the agent's configured proxy
- **THEN** the system reports the underlying error and does not attempt
  session registration

### Requirement: New independent agentic session, code captured automatically
The system SHALL register a new, independent MTProto session for the agent
via the standard phone+code login flow, and SHALL capture the incoming
authorization code automatically by reading it from the bootstrap
connection's message history with the Telegram service account (777000) —
the operator SHALL NOT be asked to relay a code.

#### Scenario: Code arrives and sign-in succeeds
- **WHEN** the new-session login is initiated and the authorization code is
  delivered to the account's own chat with the Telegram service account
- **THEN** the system reads the code from the bootstrap connection,
  completes sign-in, and obtains a new `sessionString`

#### Scenario: Code does not arrive within the timeout
- **WHEN** no authorization code is captured within the fixed timeout
- **THEN** the system reports a timeout error and does not modify the
  agent's `tg-account.json`

### Requirement: 2FA password with default, explicit override on failure
The system SHALL accept an optional `password2fa` parameter for the
new-session sign-in and SHALL default to the current persona template's 2FA
password when not provided. SHALL NOT read the password from the tdata
session's `Password2FA.txt`, as it may be stale.

#### Scenario: Default password accepted
- **WHEN** `password2fa` is not provided and the account's 2FA password
  still matches the persona template default
- **THEN** sign-in succeeds using the default

#### Scenario: Password rejected
- **WHEN** the account requires a 2FA password and the password used
  (default or explicitly provided) is incorrect
- **THEN** the system reports the sign-in error explicitly (not a silent
  failure) and does not modify the agent's `tg-account.json`; the operator
  may retry with an explicit `password2fa`

### Requirement: Only sessionString is overwritten
The system SHALL write the new `sessionString` into the existing
`workspace-<agentId>/tg-account.json` and SHALL leave every other field
(`accountId`, `apiId`, `apiHash`, `device`, `proxy`) unchanged.

#### Scenario: Successful reauth updates only sessionString
- **WHEN** a new session is obtained successfully
- **THEN** `tg-account.json` is rewritten with the same `accountId`,
  `apiId`, `apiHash`, `device`, and `proxy` values as before, and only
  `sessionString` differs

### Requirement: Restriction is cleared on success
The system SHALL clear the agent's active restriction (`need_update_session`,
`banned`, or `suspend`) after a new session is obtained successfully, since a
working session alone does not make the dispatcher resume running the agent —
the dispatcher checks the restriction table before connecting, independently
of session validity.

#### Scenario: Restriction cleared after successful reauth
- **WHEN** a new session is obtained and written to `tg-account.json`
- **THEN** the agent's row in `agent_restrictions` is removed, so the next
  dispatcher tick for this agent proceeds instead of exiting early

### Requirement: Bootstrap session is not logged out
The system SHALL disconnect the local socket of the bootstrap client after
use and SHALL NOT invoke a logout that would invalidate the tdata session
on Telegram's side.

#### Scenario: Bootstrap disconnect after successful registration
- **WHEN** the new agentic session has been obtained (successfully or not)
- **THEN** the bootstrap client's local connection is closed, and the
  original tdata session remains valid on Telegram's side

