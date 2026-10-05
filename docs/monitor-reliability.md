# Reliability contract and operations

The CLI and installed local monitor share a durable journal and claimed-delivery
contract. The installed monitor's rule, browser, authentication, coordinator,
history, reporting and replay modules are also tracked and exercised in CI.
Real targets, rules, credentials, browser profiles, evidence and databases remain
ignored local data. CI uses only synthetic identities and pages.

## Check, baseline and delivery boundaries

HTTP/authentication/page validity guard every capture, including image retry
reloads. Initial baselines and changes require two consistent captures. Rule A
can be accepted when B is missing/unstable. Perceptual visual tolerance is shared
by comparison and confirmation. A rule change rebaselines only that rule.

Check, confirmed content event and immutable accepted baseline revisions commit
atomically. The CLI selector baseline and event also share one transaction.
Unprojected events recover regardless of the current page. Frozen mail and stable
Message-IDs are delivered through renewed, expiring SQLite claims shared by health
and normal senders. Recipients are independently acknowledged. A crash after SMTP
acceptance but before acknowledgement can still duplicate a message: this is
at-least-once delivery, not exactly once. Acceptance is not proof of inbox receipt.
Permanent payload rejection is visible quarantine; shared outages back off.

## Daily policy and coverage

All-day 5xx escalation requires a completed Berlin day in which every timestamped
attempt was 5xx. Recovery or ambiguous legacy/midnight evidence defeats that claim.
Recovered retries are daily metrics, not urgent content changes. Earlier missing
content/login/storage diagnostics remain available after recovery. Repeated
diagnostics are grouped instead of generating dozens of duplicate attachments.

Every configured target appears in the reporting-period summary, including earlier
daily checks and interrupted-run omissions. Outcomes are validated unchanged,
confirmed changed, inconclusive, failed, or not due/not checked. Last attempt, last
fully validated success and latest content/progress event are separate.

The local watchdog uses per-target coverage and aged delivery/history queues.
Never-attempted/never-successful configured targets cannot fall out of its metrics.
Stopped/stale tasks can restart; unavailable site content alone does not trigger
browser restarts. Component doctor checks browser launch, encrypted credentials,
tasks, storage/free space, no-send SMTP TLS/authentication and native PostgreSQL
client/server/password-file connectivity. A same-PC watchdog cannot detect that
PC being off: independent NAS/Prometheus observation remains opt-in and no
external heartbeat destination is enabled by default.

## Rule coverage

| Rule                  | Covers                                           | Intentionally ignores                                                                            |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Required literal text | Normalized presence/absence                      | Layout/images/unrelated copy                                                                     |
| Numeric condition     | Whole numeric value paired with label            | Trailing-zero coincidences and formatting separators                                             |
| Scoped visible text   | Visible copy inside scope                        | Images/layout and explicitly ignored lines                                                       |
| Semantic container    | Text, keyed cells, form values, meaningful links | Hidden content, framework/hover attributes, expiring link tokens; row order only when configured |
| Scoped image/visual   | Rendered pixels within scope                     | Outside scope, declared ignored regions and sub-threshold repaint                                |

Original screenshots are never masked or overlaid. A separate marked-change PNG
can show small text, semantic or visual changes. Image readiness applies even with
zero extra wait. Captures bind final URL, title, text, inputs and screenshot; one
bounded recapture handles lazy updates, and persistently inconsistent pages are
rejected without advancing a baseline.

## Replay, history and retention

Actual rule definitions and per-rule baseline revisions are immutable local
records. Production-engine replay handles numeric, literal, scoped semantic/forms,
visual inputs and confirmation. It rechecks validity rather than trusting an old
outcome flag. A new uncaptured selector is inconclusive and requires recapture;
it is never fabricated from full-page text. The legacy `replayText` helper remains
a conservative line-filter experiment, not full replay. Offline replay does not
navigate, log in, advance baselines, insert history or send mail.

Native PostgreSQL samples/events are permanent. A local durable spool drains
independently, chronologically and idempotently, with append-only queued,
attempted, failed/rejected and committed outcomes. Daily activity is distinct from
numeric streak increases, identity-checked against the monitored profile, with an
explicit date/timezone source. Unknown activity remains unknown and a daily
diagnostic; the signed-in account's practice is not used for another profile.
`observedAt` is metric-read/detection time, not exact practice time.
`intervalStartAt` is the prior valid observation when known. Preserve UTC instants
and timezone offsets when graphing a repeated DST hour.

Evidence uses content IDs and explicit capture/expiry metadata. PNG retention is
configurable locally; current baselines/statistics are not pruned with screenshots.
Delivered mail bodies are compressed outside SQLite after seven days; delivery
lookups query compact metadata, not historical image payloads. Email evidence has
target-labelled CID images and a portable HTML attachment containing image bytes.
The append-only journal retains text/input observations and baseline definitions;
image/bundle expiry is not a promise to erase those permanent audit records.
Old validated success remains visible even outside the current digest window.

## Quiet desktop operation

For text-only alerts, use `visibleTextSnapshot` scoped to the required container.
Set `normalizeWhitespace: true` to ignore spacing, tabs and line-break changes
caused by layout. Screenshots remain evidence, not the alert signal. This mode
intentionally ignores images, colors, link destinations and input values that
are not visible text. Text additions, removals and number changes still alert;
authentication and required-element failures remain diagnostics. Changing modes
establishes a new validated baseline rather than comparing unlike evidence.

The local Windows runner defaults to no desktop popups and no automatic report
opening. In private `settings.json`, `showDesktopNotifications` controls normal
and watchdog popups; `openReportOnNotification` independently controls opening
reports after an event. Both default to `false` and require explicit `true` to
opt in. Missing or unreadable settings must not enable desktop actions. The
runner reads these settings at display time so stale notification files cannot
override them. `-DoNotOpenReport` still overrides report opening.

Keep `headless: true` for invisible background website checks. Email delivery,
daily digests, evidence capture and health monitoring are unaffected by desktop
preferences. Explicit manual login/bootstrap commands can still open a browser;
ordinary checks do not automatically start an interactive login session.

## Verification

Run `npm run verify`. Synthetic scenarios exercise the deployed coordinator and
browser paths, login recovery, delayed images, 200 shells, 403/503, one-row changes,
unstable candidates, restart recovery, concurrent claims, poisoned mail, independent
history draining, daily-target reporting, state replacement and stopped-task health.
The opt-in PostgreSQL regression uses TEMP tables only, including atomic rollback,
idempotency and daily-activity intervals. All four global V8 minimums remain 81%.
Browser-evaluated functions also require browser assertions because Node coverage
cannot measure their execution in Chromium. Mandatory Sonar gate success is a
separate release requirement; failed/unavailable scanning is not a green gate.
