# Page Change Checker

[![CI](https://github.com/tomassvensson/page-change-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/tomassvensson/page-change-checker/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=tomassvensson_page-change-checker&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=tomassvensson_page-change-checker)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=tomassvensson_page-change-checker&metric=coverage)](https://sonarcloud.io/summary/new_code?id=tomassvensson_page-change-checker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TypeScript scraper that uses Playwright with Chromium to load each configured URL once, compare configured CSS selector matches against the previous SQLite snapshot, and print a console report for changes or problems.

## Setup

```bash
npm install
npx playwright install chromium
Copy-Item config.example.json config.json
npm run seed
npm run scrape
```

The default database is `data/page-change-checker.sqlite`. Browser session data is stored in `data/user-data`, so cookies and local storage are reused between runs.

## Configuration

Edit `config.json`.

- `urls[].url`: page to load.
- `urls[].selectors[]`: watched elements for the URL.
- `cssPath`: CSS selector.
- `elementIndex`: zero-based index when the selector matches multiple elements.
- `compareMode`: `innerText` or `innerHTML`.
- `initialLastContent`: optional starting baseline inserted during `npm run seed`.
- `loginChecks[]`: optional selectors that should only exist after login. If a login check is missing, the scraper reports login as needed.

The same URL is loaded once per run even if it has several watched selectors.

## Login Flow

If `login.interactive` is `true` and a URL appears to need login, the scraper opens a visible persistent Chromium window for that host and pauses the rest of that host until the configured login check selector appears or `login.waitTimeoutMs` expires. Leave the browser window open while logging in. The persistent profile in `data/user-data` retains cookies and local storage for later runs.

## Running Every 24 Hours

Set `schedule.intervalHours` in `config.json`, then run:

```bash
npm run schedule
```

For production, prefer running that command under your normal process manager or OS scheduler.

## Quality Gates

```bash
npm run verify:static
npm run test:coverage
npm run test:e2e
npm run verify
```

Husky hooks are included:

- pre-commit: lint, format check, build, and unit/integration tests
- pre-push: full verification including coverage and E2E tests

The hooks are installed by `npm install` through the `prepare` script. They can also be installed explicitly with:

```bash
npm run prepare
```

## GitHub

This repository is configured for:

```bash
git remote add origin https://github.com/tomassvensson/page-change-checker
```

Publish the current `main` branch with:

```bash
git push -u origin main
```

CI runs on pushes to `main` and on pull requests using GitHub Actions. The workflow installs dependencies, installs Playwright Chromium, runs verification, and sends coverage and analysis data to SonarQube Cloud:

```bash
npm run verify
```

## License

MIT. See [LICENSE](LICENSE).
