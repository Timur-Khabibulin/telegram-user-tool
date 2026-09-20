## MODIFIED Requirements

### Requirement: Pre-flight validation before any account processing
The system SHALL validate the persona template, the operator-provided 2FA
password, and the target agent ID range before downloading any tdata archive or
mutating any state. Persona-template validation SHALL require the channel-only
files (`post.txt`, `channel_photo.*`, `channel_post_photo.*`) and `channelName`
only when `createPublicChannel` is set; without it (mode A), those are optional.
`SOUL.md` is not required.

#### Scenario: 2FA password not provided
- **WHEN** the operator starts a run without a non-empty `twoFaPassword`
- **THEN** the system reports an error to the operator and stops without
  downloading anything

#### Scenario: Persona missing channel files with channel creation disabled
- **WHEN** `createPublicChannel` is not set and the persona has `default_agent_data.json`,
  `profile_data.json` (name/nick/birthdate) and at least one `photo_profile_N`, but
  lacks `post.txt` / `channel_post_photo` / `channelName` / `SOUL.md`
- **THEN** pre-flight validation passes and registration proceeds (channel-only
  files are not required in mode A)

#### Scenario: Persona missing channel files with channel creation enabled
- **WHEN** `createPublicChannel` is set and the persona lacks a channel-only file
  (`post.txt`, `channel_photo`, `channel_post_photo`) or `channelName`
- **THEN** pre-flight validation fails and the run stops without downloading anything

#### Scenario: Persona template missing or incomplete
- **WHEN** the operator starts a run with `personName` and
  `~/.openclaw/personas/<personName>/` does not
  exist or is missing a required file
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

### Requirement: Account setup on the bootstrap session
The system SHALL, on the bootstrap session, unconditionally remove any
existing profile photos and any public channels the account administers,
change the 2FA password, terminate all other active sessions, and apply the
persona's profile and photo(s) — before any of this account's sessions is used
for anything else. Creation of the persona's public channel SHALL be conditional
on the `createPublicChannel` run parameter.

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

#### Scenario: Public channel created and pinned when enabled
- **WHEN** `createPublicChannel` is set and profile and photos have been applied
- **THEN** the system creates a public channel using the persona's
  `channelName`, posts the persona's content to it, and associates it as the
  account's personal (pinned) channel

#### Scenario: No public channel when disabled
- **WHEN** `createPublicChannel` is not set
- **THEN** the system completes registration with the persona's profile, photos,
  username, and second session, but does not create any public channel for the
  account

#### Scenario: Telegram API rejects a setup step
- **WHEN** any setup call (2FA change, session reset, cleanup, profile,
  channel creation) is rejected by Telegram with an API error (for example
  `USERNAME_OCCUPIED`, `PASSWORD_HASH_INVALID`, `FLOOD_WAIT`,
  `CHANNELS_ADMIN_PUBLIC_TOO_MUCH`, `CHANNEL_TOO_LARGE`)
- **THEN** the system records status `setup_failed` with the error for that
  account and moves to the next account without retrying with a different
  proxy candidate
