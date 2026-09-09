## MODIFIED Requirements

### Requirement: Round-robin assignment within a run

New channels collected in a **discovery** run SHALL be distributed across the target
agents round-robin within that run; accumulated load across runs is not taken into
account. This round-robin-without-load-history rule applies to the discovery flow
only. Other flows MAY define their own assignment strategy over the same registry:
`channel-rotation` reassigns banned-and-left channels to less-loaded agents
(health-spread), and `channel-distribution` distributes an operator-supplied list to
equalize final load across the target agents (load-equalize). These three assignment
strategies coexist with deliberately different goals, and none is an error relative
to the others.

#### Scenario: Even distribution across agents

- **WHEN** a discovery run collects new channels for several agents
- **THEN** the channels are handed out round-robin across those agents

#### Scenario: Other flows may use a load-aware strategy

- **WHEN** channels are assigned outside the discovery flow (via rotation or distribution)
- **THEN** a load-aware strategy MAY be used, and this does not violate the discovery round-robin rule

## ADDED Requirements

### Requirement: Channel metrics storage model

The registry SHALL store optional channel metrics as a single field of arbitrary,
changeable composition — a JSON object keyed by metric name — rather than as a fixed
set of columns. Metrics are reference data only and SHALL NOT influence the assignment
of channels to agents. Databases created before this field existed SHALL be migrated
additively; any legacy fixed metric columns, if present, are left in place and are not
read.

#### Scenario: Metrics stored as an arbitrary changeable set

- **WHEN** a channel is registered with metric columns whose names differ from those of any previous input
- **THEN** all provided metrics are stored under their column names in the single metrics field, without requiring a predefined set of metric names

#### Scenario: Metrics do not affect assignment

- **WHEN** channels carry metric values
- **THEN** the assignment of channels to agents is unaffected by those values
