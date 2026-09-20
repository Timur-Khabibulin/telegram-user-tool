## ADDED Requirements

### Requirement: Detached execution not bound by the agent tool-call watchdog
The system SHALL execute a reauth run as a detached background job, decoupled
from the operator's chat turn, so that the run's duration is not bounded by the
agent runtime's per-tool-call timeout (which is shorter than the reauth's own
authorization-code wait). The operator SHALL provide `agentId` and the 2FA
password up front; the run SHALL NOT prompt the operator for further input mid-run.

#### Scenario: Operator triggers a reauth run
- **WHEN** an operator triggers a reauth run with `agentId` and 2FA password
- **THEN** the system launches the run as a detached background job and returns
  an acknowledgement immediately, and the run continues after the triggering
  chat turn has ended

#### Scenario: Run outlives the triggering turn
- **WHEN** the run waits for the authorization code longer than the agent
  runtime's per-tool-call timeout
- **THEN** the run still completes fully and delivers its outcome, rather than
  being truncated or killed at that timeout

### Requirement: Reauth outcome delivered to Saved Messages of the report recipient
The system SHALL deliver the reauth outcome to the report-recipient agent's
Saved Messages (`REPORT_AGENT_ID`) once the run reaches any terminal result —
the same destination as the daily run summary — rather than returning it
synchronously to the invoking tool call.

#### Scenario: Run reaches a terminal result
- **WHEN** the run reaches any terminal result (`done`, `agent_not_found`,
  `tdata_missing`, `connect_failed`, `code_timeout`, `password_rejected`, or
  `error`)
- **THEN** the system delivers a report naming the `agentId` and its terminal
  result to the Saved Messages of `REPORT_AGENT_ID`

#### Scenario: Rejection is terminal, no interactive retry
- **WHEN** the run fails (for example `password_rejected` or `connect_failed`)
- **THEN** the run records the failure in the report and ends, without prompting
  the operator to relay a password or confirm a retry inside the run; a retry is
  a fresh detached run

### Requirement: Process terminates after delivering the outcome
The system SHALL force process termination after the outcome has been delivered
(or its delivery attempted), on every result including an unexpected exception,
so that GramJS clients left reconnecting after a proxy timeout cannot keep the
event loop alive indefinitely.

#### Scenario: Outcome delivered, then exit
- **WHEN** the outcome has been sent to Saved Messages (or the send has failed
  and been logged)
- **THEN** the process exits, and does not hang on lingering MTProto client
  timers or sockets

#### Scenario: Unexpected exception still delivers and exits
- **WHEN** the run throws an unexpected exception before producing a normal
  outcome
- **THEN** the system delivers a report carrying the error text to Saved
  Messages, then exits, rather than discarding the failure silently or hanging
