# Typed local monitor

The local scheduler now has a TypeScript entry point, `src/monitor/local.ts`.
Build with `npm run build`, then use `npm run monitor -- --monitor-root <private-directory>`.
Node.js 22 or newer is required. The compiler rejects implicit `any`, unchecked
JavaScript inputs, missing returns, switch fallthrough and missing override markers;
it does not emit a build when type checking fails. Type-aware ESLint also rejects
unsafe values and unhandled promises. Persisted JSON is validated with Zod.

## Acceptance pipeline

`load → authenticate → validate-readiness → capture → confirm-change → save → notify`

`sites.ts` owns provider-specific authentication and readiness policy. Browser
capture, independent confirmation, baselines, history and delivery remain shared.
Preparation runs again on confirmation/recovery navigation. A login page, missing
statistics, missing authenticated selector, offline browser page or HTTP failure
cannot be accepted as a changed page. Bounded retries retain the last good baseline.
Stage timings are recorded with checks; the delivery ledger records notification
attempts and outcomes separately. No background run opens an interactive login window.

The daily email distinguishes the reporting period's outcomes from the latest
check. Historical diagnostics can coexist with an entirely healthy current status.
Recovered evidence is explicitly labelled and placed after coverage. A subsequent
failure is not hidden by an earlier success; sustained failure needs investigation.
Coverage is a count of validated checks, not a claim of uninterrupted availability.

Health readers open SQLite read-only and do not rerun schema migrations. This
avoids taking a write lock merely to ask whether the monitor is healthy.

## Consolidation assessment

| Implementations                                                     | Decision / next step                                                                                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private JavaScript runner and typed monitor library                 | Moved the active orchestration into typed source; removed unreachable legacy copies during migration. Private configuration and browser profiles remain local.                                           |
| Inline provider authentication versus browser authentication helper | Provider policy is now in `sites.ts`, using the same credential-login helper for all school modules.                                                                                                     |
| First capture, confirmation and recovery navigation                 | All run the same preparation and validation path.                                                                                                                                                        |
| Local and emailed period/current-health interpretation              | Both use `periodSummary`; email uses the same current-status overview in HTML and plain text.                                                                                                            |
| CLI scraper (`src/browser`) versus private monitor (`src/monitor`)  | Still two orchestration stacks, with different configuration and database models. Share small validity/evidence primitives next; do not merge the workflows without a migration plan and contract tests. |
| Notification modules versus monitor SMTP outbox                     | Generic notifier channels and the durable private digest are not interchangeable. Extract a shared SMTP transport factory/acceptance contract without removing durable delivery semantics.               |
| Local HTML report versus email HTML                                 | Period tables and text diff are shared; layout, escaping and evidence presentation still have overlap. Extract presentation components after preserving their distinct link/attachment requirements.     |
| Windows loop and watchdog helpers                                   | Both discover Node, invoke a runner and log failures. A shared invocation helper would prevent path/version drift. Keep watchdog process independence.                                                   |
| PostgreSQL command execution in runtime versus integration helpers  | SQL generation is shared; process invocation can become an injected client. This would simplify deterministic timeout/recovery tests without changing native-Windows-only storage policy.                |

## NAS SonarQube

Set `SONAR_HOST_URL` and `SONAR_TOKEN` locally, then run `scripts/sonar-nas.ps1`.
The scan reuses the repository's public-source exclusions: private settings,
credentials, browser profiles and archived evidence under `data/` are not uploaded.
The script runs verification first and waits for the server quality gate. A server
response with no evaluated conditions is rejected, not presented as quality proof.
Assign a project gate with explicit coverage and new-code reliability/security
conditions using an administrator account. The local coverage minimum remains 81%
for statements, branches, functions and lines; adding code does not relax it.
The NAS script additionally requires at least 81% for Sonar's overall combined,
line and branch coverage, and new-code combined coverage. This explicitly raises
the server's default 80% new-code combined threshold without changing a gate shared
by other projects. Missing metrics fail closed. New-code branch coverage is a
separate diagnostic metric, not the configured overall-branch minimum.

SonarCloud CI authentication and the NAS scan are separate integrations. A NAS
analysis does not prove that the Cloud scanner or the GitHub workflow succeeded.
