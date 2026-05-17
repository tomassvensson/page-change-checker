# Page Change Checker

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

CI runs on pushes to `main` and on pull requests using GitHub Actions. The workflow installs dependencies, installs Playwright Chromium, and runs:

```bash
npm run verify
```

## Dependency Licenses

Direct dependency license summary from installed package metadata:

| Package                | Scope           | Version   | License      | Project                                                                             |
| ---------------------- | --------------- | --------- | ------------ | ----------------------------------------------------------------------------------- |
| better-sqlite3         | dependencies    | ^11.8.1   | MIT          | http://github.com/WiseLibs/better-sqlite3                                           |
| commander              | dependencies    | ^13.1.0   | MIT          | git+https://github.com/tj/commander.js.git                                          |
| cron-parser            | dependencies    | ^4.9.0    | MIT          | https://github.com/harrisiirak/cron-parser.git                                      |
| diff                   | dependencies    | ^7.0.0    | BSD-3-Clause | git://github.com/kpdecker/jsdiff.git                                                |
| playwright             | dependencies    | ^1.51.1   | Apache-2.0   | https://playwright.dev                                                              |
| zod                    | dependencies    | ^3.24.2   | MIT          | https://zod.dev                                                                     |
| @eslint/js             | devDependencies | ^9.22.0   | MIT          | https://eslint.org                                                                  |
| @playwright/test       | devDependencies | ^1.51.1   | Apache-2.0   | https://playwright.dev                                                              |
| @types/better-sqlite3  | devDependencies | ^7.6.13   | MIT          | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/better-sqlite3 |
| @types/diff            | devDependencies | ^7.0.0    | MIT          | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/diff           |
| @types/node            | devDependencies | ^22.13.11 | MIT          | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node           |
| @vitest/coverage-v8    | devDependencies | ^3.0.9    | MIT          | https://github.com/vitest-dev/vitest/tree/main/packages/coverage-v8#readme          |
| eslint                 | devDependencies | ^9.22.0   | MIT          | https://eslint.org                                                                  |
| eslint-plugin-import-x | devDependencies | ^4.8.0    | MIT          | https://github.com/un-ts/eslint-plugin-import-x#readme                              |
| husky                  | devDependencies | ^9.1.7    | MIT          | git+https://github.com/typicode/husky.git                                           |
| prettier               | devDependencies | ^3.5.3    | MIT          | https://prettier.io                                                                 |
| tsx                    | devDependencies | ^4.19.3   | MIT          | https://tsx.hirok.io                                                                |
| typescript             | devDependencies | ^5.8.2    | Apache-2.0   | https://www.typescriptlang.org/                                                     |
| typescript-eslint      | devDependencies | ^8.26.1   | MIT          | https://typescript-eslint.io/packages/typescript-eslint                             |
| vitest                 | devDependencies | ^3.0.9    | MIT          | https://github.com/vitest-dev/vitest#readme                                         |
