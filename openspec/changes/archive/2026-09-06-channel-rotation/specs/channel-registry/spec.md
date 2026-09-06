## MODIFIED Requirements

### Requirement: One channel, one agent

The registry SHALL guarantee that each channel is assigned to exactly one agent, enforced
by uniqueness of `canonical_link`. An assignment, once written, SHALL NOT change except
through one of two explicit mechanisms: an operator-driven manual override, or the
automated `channel-rotation` flow triggered when a channel reaches `leaved_from_banned`
status on its current agent. Outside these two mechanisms, there is no rebalance.

#### Scenario: Channel cannot be assigned to two agents

- **WHEN** an already-registered channel is processed again for a different agent
  outside of a manual override or `channel-rotation`
- **THEN** the channel keeps its original `assigned_agent` and is not assigned twice

#### Scenario: New agent joins the platform

- **WHEN** a new agent is added
- **THEN** existing assignments are unchanged and only newly discovered channels are distributed to it

#### Scenario: Rotation reassigns a banned-and-left channel

- **WHEN** `channel-rotation` picks a channel whose current agent left it after a ban
  (`leaved_from_banned`) and selects a new target agent
- **THEN** `assigned_agent` for that channel's `canonical_link` changes to the new agent,
  and this is the only automated path by which an assignment may change
