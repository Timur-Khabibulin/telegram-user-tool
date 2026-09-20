## MODIFIED Requirements

### Requirement: Pre-flight validation before any account processing
The system SHALL validate the persona template, the operator-provided 2FA
password, and the target agent ID range before downloading any tdata archive or
mutating any state.

#### Scenario: Persona template missing or incomplete
- **WHEN** the operator starts a run with `personName` and
  `~/.openclaw/personas/<personName>/` does not
  exist or is missing a required file
- **THEN** the system reports an error to the operator and stops without
  downloading anything

#### Scenario: 2FA password not provided
- **WHEN** the operator starts a run without a non-empty `twoFaPassword`
- **THEN** the system reports an error to the operator and stops without
  downloading anything

#### Scenario: Agent ID range collides with existing agents or staging
- **WHEN** the computed range `startAgentNumber..startAgentNumber+N-1`
  (where `N` is the number of links in `links`) overlaps with an
  existing `workspace-<agentId>` directory or an unresolved staging entry
  from a previous run
- **THEN** the system reports an error to the operator and stops without
  downloading anything

#### Scenario: Template valid and range free
- **WHEN** the persona template is complete, `twoFaPassword` is provided, and
  the ID range is free
- **THEN** the system proceeds to download tdata archives

### Requirement: One tdata archive maps to exactly one account
The system SHALL treat each link in `links` as exactly one tdata archive
containing exactly one account, regardless of the link's source, and SHALL
download all archives into a per-account staging directory before processing
any account. A link MAY be a Mega folder share-link or a Google Drive file
link; the system SHALL detect the source from the URL and download accordingly.

#### Scenario: Batch download into staging
- **WHEN** the pre-flight checks pass
- **THEN** the system downloads every archive from `links` into
  `~/.openclaw/tg-agent-autoregistration/staging/agent<N>/tdata/` — not into
  `~/.openclaw/workspace-agent<N>/` — one archive per account, before any
  account-level processing begins

#### Scenario: Google Drive file link
- **WHEN** a link is a Google Drive file link (`drive.google.com/file/d/<id>/...`)
- **THEN** the system downloads the file (handling Google's large-file
  confirmation interstitial), unpacks it as a ZIP archive, and locates the
  `tdata` folder inside the extracted contents

#### Scenario: Google Drive link is not publicly downloadable
- **WHEN** a Google Drive link does not resolve to a downloadable ZIP (for
  example the file is not shared for anyone with the link, so an HTML page is
  returned instead of the archive)
- **THEN** the system records a failure for that account with a clear error and
  continues with the remaining accounts, without aborting the whole run

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

#### Scenario: 2FA password changed from the operator-provided current password
- **WHEN** account setup proceeds to the password step
- **THEN** the system changes the 2FA password using the operator-provided
  `twoFaPassword` as the current password and the new password from the
  persona's `default_agent_data.json`

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

## ADDED Requirements

### Requirement: Account phone and current 2FA obtained without tdata sidecar files
The system SHALL obtain the account phone number from the live account via
`getMe()` on the bootstrap session, and the current 2FA password from the
operator-provided `twoFaPassword`. The system SHALL NOT read the `tdata/Accounts.txt`
or `tdata/Password2FA.txt` sidecar files; the tdata folder is used only as the
source of the bootstrap session.

#### Scenario: Phone read from the account, not the archive
- **WHEN** the bootstrap session is established from tdata
- **THEN** the system reads the account phone number via `getMe()` and uses it
  for the second-session sign-in, without reading `tdata/Accounts.txt`

#### Scenario: tdata archive without sidecar files still processes
- **WHEN** a tdata archive contains no `Accounts.txt` and no `Password2FA.txt`
- **THEN** account processing proceeds normally, using the phone from `getMe()`
  and the current 2FA from `twoFaPassword`
