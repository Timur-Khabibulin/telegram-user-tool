## ADDED Requirements

### Requirement: Registry records when a channel was added

The registry SHALL record, for each channel, the moment it was first added, stored as an
`added_at` column on `discovered_channels` (Unix epoch seconds, matching the timestamp
convention used by `join_queue.updatedAt`). The value SHALL be set at insertion and SHALL
NOT change on idempotent re-registration of an already-known channel (the assignment and the
add time are both immutable, per «One channel, one agent»). Databases created before this
column existed SHALL be migrated additively, preserving existing rows.

#### Scenario: New channel records its add time

- **WHEN** a new channel is registered via `registerChannel`
- **THEN** its row stores `added_at` set to the current time

#### Scenario: Re-registration does not change add time

- **WHEN** an already-known channel is processed again
- **THEN** its `added_at` is left unchanged (no row is rewritten)

#### Scenario: Existing registry is migrated additively

- **WHEN** the registry database predates the `added_at` column
- **THEN** the column is added without dropping or re-assigning existing rows
