# Security policy

## Supported version

Security fixes are applied to the current `main` branch. This project has not
yet published long-term support releases.

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability involving
credential disclosure, outbound network-policy bypass, baseline corruption, or
arbitrary file access. Use GitHub's private vulnerability reporting feature for
this repository. Include:

- affected commit/version and operating system;
- minimal configuration and reproduction steps;
- observed versus expected behavior;
- whether credentials, private network access, or persisted snapshots are
  affected.

Do not include real credentials, session profiles, database files, or monitored
page content. Use synthetic values.

## Security assumptions

- `config.json` and environment variables are controlled by the operator.
- Monitored pages, redirects, subresources, DNS responses, and notification
  endpoints are untrusted.
- The local OS account and host filesystem are outside the application's trust
  boundary. Anyone who can read the browser profile can generally reuse its
  authenticated session.
- This is a single-user CLI and scheduler, not an Internet-facing service.

## Built-in controls

- Strict HTTP(S)-only config validation with no embedded URL credentials.
- Private/reserved address blocking for browser and notification traffic,
  including IPv4-mapped IPv6 handling.
- Exact-origin scoping for configured browser headers.
- Per-origin persistent browser profiles.
- Login checks before watched selectors and atomic all-target persistence.
- Content-size limits and unsafe-regex screening.
- Redacted structured logs and summary-only notification content by default.
- SMTP file/URL access disabled and bounded delivery timeouts.
- Cross-process database locking and integrity-checked SQLite migration backups.
- Non-root, read-only Docker runtime with dropped capabilities.
- Production dependency audit, CodeQL, and immutable CI action revisions.

## Residual risks

The outbound guard is implemented at application level. DNS can change between
policy resolution and the browser/network stack's connection, and browser or
runtime defects can bypass application assumptions. For high-assurance use,
enforce an OS, firewall, proxy, or container-network egress allowlist as a
second layer.

Interactive login stores reusable session material on disk. Protect
`data/user-data`, backups, screenshots, config, and environment secrets with OS
permissions and encrypted storage appropriate to the account's sensitivity.

Monitoring an authorized page does not automatically authorize every linked
third-party resource or every scraping frequency. Respect applicable access
controls, terms, robots policies, privacy obligations, and rate limits.
