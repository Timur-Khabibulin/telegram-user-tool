## ADDED Requirements

### Requirement: Batch public-channel setup for already-registered agents
The system SHALL provide a batch operation that creates the persona's public
channel for a list of already-registered agents, connecting through each agent's
own stored session (not a bootstrap tdata session). Processing SHALL be
per-agent isolated: a failure or skip of one agent SHALL NOT stop the others,
and the operation SHALL return a per-agent status summary.

#### Scenario: Channel created for a registered agent without one
- **WHEN** the operation runs for an agent whose `tg-account.json` exists and
  the account has no personal public channel yet
- **THEN** the system connects via the agent's stored session and proxy, creates
  the persona's public channel, posts the persona's content, and associates it as
  the account's personal (pinned) channel, recording status `done`

#### Scenario: One agent failing does not stop the batch
- **WHEN** channel creation for one agent fails with a Telegram API error
- **THEN** the system records that agent's failure and continues with the
  remaining agents

### Requirement: Persona resolved from the agent's stored configuration
The system SHALL resolve the persona and account username for channel setup from
the agent's own `tg-account.json` (`persona`, `username`), not from an operation
parameter. The persona name identifies the template under
`~/.openclaw/personas/<persona>/`.

#### Scenario: Persona read from tg-account.json
- **WHEN** channel setup runs for an agent
- **THEN** the system reads the persona and username from that agent's
  `tg-account.json` and uses the matching persona template for channel title,
  photo, and post — without requiring the operator to specify the persona

### Requirement: Skip agents that already have a personal channel
The system SHALL skip channel creation for any agent that already has a
personal (pinned) public channel, so that re-running the batch does not create
duplicate channels or hit the Telegram admined-public-channel limit.

#### Scenario: Agent already has a personal channel
- **WHEN** the operation runs for an agent whose account already has a personal
  public channel set
- **THEN** the system records status `skipped` for that agent and does not create
  another channel
