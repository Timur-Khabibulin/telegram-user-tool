## MODIFIED Requirements

### Requirement: Batch summary report
The system SHALL deliver the outcome of every account processed in a run to the
report-recipient agent's Saved Messages (`REPORT_AGENT_ID`) once the run
completes — the same destination as the daily run summary — rather than
returning it synchronously to the invoking tool call.

#### Scenario: Run completes
- **WHEN** all accounts in the batch have been processed (in any terminal
  status)
- **THEN** the system delivers a report to the Saved Messages of
  `REPORT_AGENT_ID`, listing, per account, one of `done` / `proxy_failed` /
  `setup_failed` / `needs_manual_code`

#### Scenario: Report delivery fails
- **WHEN** the run has completed and recorded each account's terminal status,
  but delivering the report to Saved Messages fails (for example a transient
  Telegram/network error)
- **THEN** the per-account statuses recorded in staging and printed to the run
  log are preserved, and the delivery error is logged rather than discarding
  the completed run's result

## ADDED Requirements

### Requirement: Detached execution not bound by the agent tool-call watchdog
The system SHALL execute a batch registration run as a detached background job,
decoupled from the operator's chat turn, so that the run's duration is not
bounded by the agent runtime's per-tool-call timeout.

#### Scenario: Operator triggers a batch run
- **WHEN** an operator triggers a batch registration run
- **THEN** the system launches the run as a detached background job and returns
  an acknowledgement immediately, and the run continues after the triggering
  chat turn has ended

#### Scenario: Run outlives the triggering turn
- **WHEN** a run takes longer than the agent runtime's per-tool-call timeout
- **THEN** the run still completes fully and delivers its report, rather than
  being truncated or killed at that timeout
