# Monitor reliability contract

The private Windows deployment imports the reusable `src/monitor` library after
`npm run build`. Private settings, browser profiles, operational SQLite, evidence,
credentials and reports live under ignored `data/` and must never enter Git.

## Alert and reporting policy

- Confirmed content changes can be immediate; HTTP/authentication/required-content
  failures are diagnostics, never content changes.
- HTTP 408/5xx and configured 403 failures still receive bounded retries. A 5xx
  outage is reported in the daily digest only after the Berlin calendar day has
  ended and **every recorded navigation attempt** for that target/day was 5xx.
  A recovered check or non-5xx attempt defeats that condition. A daily target with
  one failed scheduled check has one observation, not proof of continuous outage.
- Other diagnostics are retained until the next daily reporting period even if
  they recover before email time. Identical diagnostic evidence is coalesced.
- The SQLite outbox freezes the report and image bytes before baseline state is
  replaced. Pending mail is retried independently of current page conditions.
  SMTP acceptance is journaled, not proof of inbox delivery. Delivery is
  at-least-once: a crash after SMTP acceptance and before acknowledgement can
  resend a message; deterministic Message-ID assists recipient deduplication.
- Operational and history backlogs remain local until acknowledgement. Permanent
  progress samples/events use one idempotent PostgreSQL transaction. Invalid or
  unconfirmed observations are not written as progress history.

## Operational evidence

`MonitorJournal` uses SQLite WAL with FULL synchronization. Check records and
delivery attempts are append-only (database triggers reject updates/deletes).
Records include run/target aliases, actual start/end, validation, retry HTTP
statuses, authentication status, rule hash, evidence ID, storage outcome and
archived result. Delivery records link to durable outbox events. The outbox and
history spool are mutable projections, not substitutes for the check ledger.

The local digest includes validated success rate, last attempt/success and age,
duration, rejected candidates, recovered retries, unsent events and history
backlog. Rejected candidates do not advance baselines. Atomic state replacement
flushes a uniquely named temporary file and never deletes the valid destination
first. Live process locks do not expire because a run is slow.

## Rule coverage and intentional blind spots

| Rule                      | Covers                                                           | Intentionally ignores                                                  |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Required text             | Literal normalized text condition                                | Unrelated text and image changes                                       |
| Statistic equals/triggers | Parsed numeric statistic beside its label                        | Cosmetic layout and images                                             |
| Visible text snapshot     | Normalized visible text in the configured selector               | Image-only changes, layout, content outside selector                   |
| Element content snapshot  | Visible text, relevant attributes and form state inside selector | Hidden/out-of-scope content and cosmetic CSS                           |
| Visual snapshot           | Perceptual sampled rendering after readiness and confirmation    | Below-threshold pixel noise and explicitly declared comparison regions |

Changing rules produces a new SHA-256 rules version; validated snapshots establish
a new baseline when that version changes. Original screenshots remain untouched:
ignored regions apply only to comparison signatures, never image overlays.
The `streak_activated` history event currently means zero-to-positive day streak,
not an independently verified daily flame/icon transition.

## Offline replay

Export archived local evidence using the private monitor's `--replay` option.
Then experiment with a text filter, without live website access, authentication,
mail, history insertion or baseline writes:

```powershell
node dist/src/monitor/replay.js evidence.json filter.json
```

Example **synthetic** filter:

```json
{ "ignoredLines": ["Decorative arrow"], "requiredText": "Account overview" }
```

Output identifies evidence, original status, proposed filter version, validity and
would-change decisions. This is a text-filter replay, not a re-render of old
screenshots or a claim that all selector rules can be reconstructed from text.
Use the private `--doctor` and `--dashboard` options for local preflight/metrics.
Their reports contain private aliases and must also stay local.

## Synthetic regression matrix

| Incident                                                | Automated evidence                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| HTTP outage and recovery; 403 as error                  | monitorJournal and scraperReliability tests                                         |
| HTTP 200 challenge shell                                | pageValidity tests                                                                  |
| Login expiry, timeout and baseline preservation         | scraperSecurity and scraperReliability tests                                        |
| Credential helper timeout/recovery                      | retryOperation tests; private runtime uses same helper                              |
| Partial/delayed image readiness                         | imagesReady tests                                                                   |
| Cosmetic repaint versus real one-row change             | monitorVisual and monitorReplay tests                                               |
| Missing required selector/statistic outside digest time | dailyDiagnostics persistence/recovery tests                                         |
| Unvalidated candidate followed by another candidate     | replay baseline-preservation test; private confirmation self-tests                  |
| SMTP failure, process restart, recovery                 | durable outbox test; channel failure tests                                          |
| Database failure after sample insertion                 | progressTransaction transaction/idempotence contract and durable spool restart test |
| Interruption during state replacement                   | injected pre-replacement failure preserves destination                              |
| Concurrent/initializing/long-running lock owner         | fileLock tests                                                                      |
| Stopped task, stale success, delivery/history backlog   | monitorHealth tests                                                                 |

Browser scenarios use local synthetic HTTP servers. No private target is accessed
from CI. The opt-in `monitorPostgres` test injects an event-write failure after
sample insertion using session-local TEMP tables, then checks rollback and an
idempotent retry. It runs against PostgreSQL 18 in a separate synthetic CI service.
For native Windows validation, set `PCC_TEST_PSQL` to the installed client path and
`PCC_TEST_PGDATABASE` to a database covered by your pgpass credentials. It does not
write permanent tables or use the computer's Docker database.

## Quality gates

`npm run verify` requires production audit, lint, formatting, build, unit/integration
tests and browser tests. Global V8 **statements, branches, functions and lines each
require >=81%**, with the explicit entrypoint/type/barrel exclusions in
`vitest.config.ts`; this is neither per-file nor all-source 81% coverage.
Sonar scan is mandatory in CI and waits up to 300 seconds for the configured
SonarCloud project quality gate. Missing/invalid token, scan failure, timeout or
failed gate fails CI. Secrets are deliberately not exposed to untrusted fork
pull requests; those need a trusted maintainer branch for this mandatory scan.
The local 81% gate does not depend on Sonar's default coverage threshold.

The same-computer watchdog can recover a stopped monitor and throttle warnings
to daily. It cannot alert when Windows is powered off or both tasks are stopped.
An independently hosted observer of a minimal heartbeat is still needed for that
failure mode; no external destination is implicitly configured.
