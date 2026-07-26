# Development guide

## Prerequisites

| Tool                  | Minimum version         | Install                                       |
| --------------------- | ----------------------- | --------------------------------------------- |
| Node.js               | 22                      | [nodejs.org](https://nodejs.org/)             |
| npm                   | bundled with Node.js 22 | —                                             |
| Chromium (Playwright) | any recent              | `npx playwright install chromium --with-deps` |

## First-time setup

```bash
git clone https://github.com/tomassvensson/page-change-checker.git
cd page-change-checker
npm install          # installs dependencies and sets up Husky git hooks
npx playwright install chromium --with-deps
cp config.example.json config.json   # edit config.json to your needs
```

## Project structure

```
src/
  cli/
    index.ts         Commander commands: seed / run / schedule
    config.ts        Zod schema, loadConfig(), parseConfig()
    scheduler.ts     Interval loop with overlap-prevention guard
  browser/
    scraper.ts       Playwright orchestration, retry, semaphore, jitter
    pageReader.ts    DOM extraction, waitForSelector support
  storage/
    db.ts            SQLite: migration backups, reconciliation, atomic snapshots
  reporting/
    reporter.ts      Diff formatting, selector aliases, tags
  core/
    types.ts         All shared TypeScript interfaces and enums
    errors.ts        Structured error hierarchy + classifyError()
    fileLock.ts      Cross-process database lock
    logger.ts        Correlated structured logging and redaction
    networkPolicy.ts Outbound host/IP policy
    normalize.ts     normalizeText(), applyIgnorePatterns(), processContent()
    redact.ts        URL, message, and structured-field sanitization
tests/
  unit/              Fast policy, config, reporting, and helper tests
  integration/       SQLite plus real-Chromium security scenarios under coverage
  e2e/               Shared security scenarios executed by Playwright
docs/
  architecture.md    Module diagram and data-flow description
  configuration.md   Full config reference
  development.md     This file
  operations.md      Running in production
```

## Available scripts

| Script                  | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `npm run seed`          | Insert/update DB rows from config.json   |
| `npm run scrape`        | One-shot scrape and report               |
| `npm run schedule`      | Continuous scheduler                     |
| `npm run dev`           | Run the CLI with `tsx` (no compile step) |
| `npm run build`         | Compile TypeScript → `dist/`             |
| `npm run lint`          | ESLint                                   |
| `npm run format`        | Prettier write                           |
| `npm run format:check`  | Prettier check (CI-safe)                 |
| `npm run test`          | Vitest unit + integration                |
| `npm run test:watch`    | Vitest watch mode                        |
| `npm run test:coverage` | Vitest with V8 coverage                  |
| `npm run test:e2e`      | Playwright E2E                           |
| `npm run audit:prod`    | Production dependency vulnerability gate |
| `npm run verify:static` | lint + format:check + build              |
| `npm run verify`        | Audit + static + coverage + E2E          |

## Running tests

```bash
# Unit and integration (includes local real-browser security scenarios)
npm run test

# With coverage report in coverage/
npm run test:coverage

# E2E (requires Playwright Chromium)
npm run test:e2e

# Full pipeline
npm run verify
```

Coverage gates are calibrated to the measured suite (79% lines, 69% branches,
80% functions, 77% statements). The core scraper, scheduler, and error model are
included rather than excluded. Coverage is reported to SonarCloud via `lcov.info`.

## Git hooks (Husky)

Hooks are installed automatically by `npm install`.

| Hook         | What runs                                            |
| ------------ | ---------------------------------------------------- |
| `pre-commit` | lint → format:check → build → unit+integration tests |
| `pre-push`   | full `npm run verify` (includes coverage + E2E)      |

Re-install hooks manually with `npm run prepare`.

## TypeScript conventions

- Module system: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`.
- All imports of project files must use the **`.js` extension** (even for `.ts` sources), per NodeNext ESM requirements.
- `rootDir: "."`, `outDir: "dist"` — both `src/` and `tests/` compile under the same root.
- Strict mode is enabled. No `any` without an explicit justification comment.

## Adding a new feature

1. Add or extend types in `src/core/types.ts`.
2. Update the Zod schema in `src/cli/config.ts` with defaults.
3. Implement in the appropriate layer (`browser/`, `storage/`, `reporting/`, `cli/`).
4. Update the re-export shims in the old flat `src/*.ts` files if the public surface changes.
5. Add a regression test at the lowest useful layer. Security-sensitive browser
   behavior should also use the shared real-Chromium scenarios.
6. Keep measured coverage at or above every configured gate.
7. Update `config.example.json`, `README.md`, and relevant docs.

## Linting and formatting

ESLint is configured in `eslint.config.js` with the TypeScript plugin and import-order rules.
Prettier is configured via the `prettier` key in `package.json` (or `.prettierrc` if present).

Run both together:

```bash
npm run lint && npm run format:check
```

## SonarCloud

The project is connected to SonarCloud via `sonar-project.properties`.
Coverage is uploaded automatically in CI via the `sonarqube-scan-action` step.
To run a local analysis, install the [SonarScanner CLI](https://docs.sonarqube.org/latest/analyzing-source-code/scanners/sonarscanner/) and run:

```bash
sonar-scanner
```
