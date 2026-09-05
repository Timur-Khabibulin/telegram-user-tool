## MODIFIED Requirements

### Requirement: Mobile proxy selection per account

The system SHALL request the next not-yet-used proxy candidate (not used by any other agent, see
`mobile-proxy-provisioning`) from the asocks inventory for each connection attempt and SHALL stop
retrying once a working candidate is found or the attempt limit is reached. Candidates SHALL NOT
be created or deleted on the asocks side — they are existing account inventory, not newly minted
resources.

#### Scenario: Candidate fails to connect

- **WHEN** a proxy candidate fails to establish an MTProto connection to the account's tdata
  session
- **THEN** the system discards the candidate (without deleting anything on asocks) and takes the
  next not-yet-used candidate from the same list, up to `maxProxyAttempts` times per account

#### Scenario: Attempts exhausted without a working proxy

- **WHEN** `maxProxyAttempts` candidates have all failed to connect for an account
- **THEN** the system records status `proxy_failed` for that account in its staging entry and
  moves to the next account
