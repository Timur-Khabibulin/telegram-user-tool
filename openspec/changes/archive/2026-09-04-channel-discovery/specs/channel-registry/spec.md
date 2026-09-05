## ADDED Requirements

### Requirement: Canonical link normalization

The registry and queue delivery SHALL use a single canonical link form
`https://t.me/<username>` (lowercase, without `@` and without a trailing `/`). The same
normalization SHALL be applied everywhere a link enters the registry or the join queue, so
the dedup key and the delivered link are byte-identical.

#### Scenario: Link variants normalize to one form

- **WHEN** the same channel appears as `t.me/Foo/` and `t.me/foo`
- **THEN** both reduce to the same `canonical_link` value

### Requirement: Deduplication against registry

The discovery run SHALL skip channels already present in the registry, matching by
`canonical_link`, so a known channel is neither re-collected nor re-assigned.

#### Scenario: Known channel skipped

- **WHEN** a candidate's canonical link already exists in the registry
- **THEN** the candidate is skipped and its assignment is left unchanged

### Requirement: One channel, one agent

The registry SHALL guarantee that each channel is assigned to exactly one agent, enforced
by uniqueness of `canonical_link`. An assignment, once written, SHALL NOT change in any
scenario — there is no rebalance.

#### Scenario: Channel cannot be assigned to two agents

- **WHEN** an already-registered channel is processed again for a different agent
- **THEN** the channel keeps its original `assigned_agent` and is not assigned twice

#### Scenario: New agent joins the platform

- **WHEN** a new agent is added
- **THEN** existing assignments are unchanged and only newly discovered channels are distributed to it

### Requirement: Round-robin assignment within a run

New channels collected in a run SHALL be distributed across the target agents round-robin
within that run; accumulated load across runs is not taken into account.

#### Scenario: Even distribution across agents

- **WHEN** a run collects new channels for several agents
- **THEN** the channels are handed out round-robin across those agents

### Requirement: Delivery to join queue

For each newly assigned channel the registry SHALL deliver its `canonical_link` to the
assigned agent's `join_queue` via `addJoinQueue`, using the same canonical form as the
dedup key. The discovery run SHALL NOT join channels itself.

#### Scenario: Assigned channel is queued

- **WHEN** a channel is assigned to agent A
- **THEN** its canonical link is added to agent A's `join_queue` and no join is triggered by discovery

### Requirement: Re-run safety

Re-running a discovery run after a failure SHALL NOT assign any channel to more than one
agent and SHALL NOT create duplicate entries in any agent's `join_queue`.

#### Scenario: Repeated run after interruption

- **WHEN** a run is repeated after being interrupted
- **THEN** no channel becomes assigned to two agents and no duplicate join-queue entries are created

### Requirement: Manual backfill before production

The registry SHALL support a one-time manual backfill by the operator that seeds already
known channels by their canonical links, so discovery does not assign an already-joined
channel to a different agent. Backfill is an irreversible change to the shared registry and
is run deliberately by the operator.

#### Scenario: Backfilled channel is deduped

- **WHEN** the operator backfills known channel X as owned by agent A, and discovery later finds X
- **THEN** X is recognized as known and is not assigned to another agent
