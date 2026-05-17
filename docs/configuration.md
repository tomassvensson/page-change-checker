# Configuration reference

All configuration lives in `config.json` (copy from `config.example.json`).
The file is validated on startup with Zod; startup aborts with a descriptive error
if the schema is invalid.

## Top-level keys

| Key                      | Type          | Default                             | Description                                                        |
| ------------------------ | ------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `databasePath`           | `string`      | `"data/page-change-checker.sqlite"` | SQLite file path. Created automatically.                           |
| `normalize`              | object        | see below                           | Global text-normalisation settings applied before all comparisons. |
| `retry`                  | object        | see below                           | Retry strategy for transient failures.                             |
| `concurrency`            | object        | see below                           | Parallelism limits.                                                |
| `rateLimit`              | object        | see below                           | Per-host request pacing.                                           |
| `browser`                | object        | —                                   | Playwright browser and context options.                            |
| `schedule.intervalHours` | `number`      | `24`                                | Hours between runs when using `npm run schedule`.                  |
| `login.interactive`      | `boolean`     | `true`                              | Open a visible window when a login wall is detected.               |
| `login.waitTimeoutMs`    | `number`      | `600000`                            | Milliseconds to wait for manual login (default 10 min).            |
| `screenshot`             | object        | —                                   | Optional screenshot capture when content changes.                  |
| `notifications`          | object        | —                                   | Optional notification channels (email, webhooks, Telegram).        |
| `urls`                   | `UrlConfig[]` | —                                   | Pages to monitor.                                                  |

---

## `normalize`

Applied globally to every selector's content before comparing. Override per selector
with `selectors[].normalizeOverride`.

| Key                  | Type      | Default | Description                                     |
| -------------------- | --------- | ------- | ----------------------------------------------- |
| `trimWhitespace`     | `boolean` | `true`  | Strip leading and trailing whitespace.          |
| `collapseWhitespace` | `boolean` | `true`  | Replace runs of whitespace with a single space. |
| `caseInsensitive`    | `boolean` | `false` | Lower-case content before comparing.            |

---

## `retry`

| Key             | Type     | Default | Description                                                                                                                              |
| --------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAttempts`   | `number` | `3`     | Total attempts before a URL is marked as failed.                                                                                         |
| `baseDelayMs`   | `number` | `1000`  | Delay before the first retry (milliseconds).                                                                                             |
| `backoffFactor` | `number` | `2`     | Multiplier applied to delay on each subsequent retry. Attempt 1 waits `baseDelayMs`, attempt 2 waits `baseDelayMs * backoffFactor`, etc. |

Transient errors (navigation timeouts, HTTP 5xx) are retried. Permanent errors
(HTTP 4xx, login-missing, comparison errors) are not.

---

## `concurrency`

| Key       | Type     | Default | Description                                                                                      |
| --------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `global`  | `number` | `3`     | Maximum simultaneous URL loads across all hosts.                                                 |
| `perHost` | `number` | `1`     | Maximum simultaneous requests to a single hostname. Setting to `1` serialises requests per host. |

---

## `rateLimit`

A random delay drawn from `[minDelayMs, maxDelayMs]` is inserted between consecutive
requests to the same host.

| Key          | Type     | Default | Description                    |
| ------------ | -------- | ------- | ------------------------------ |
| `minDelayMs` | `number` | `500`   | Minimum pause in milliseconds. |
| `maxDelayMs` | `number` | `2000`  | Maximum pause in milliseconds. |

Set both to `0` to disable rate limiting (not recommended for production use).

---

## `browser`

| Key                             | Type       | Description                                                                                  |
| ------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `headless`                      | `boolean`  | Run Chromium without a visible window.                                                       |
| `userDataDir`                   | `string`   | Persistent profile directory (stores cookies, local storage).                                |
| `timeoutMs`                     | `number`   | Navigation timeout in milliseconds.                                                          |
| `waitUntil`                     | `string`   | Playwright navigation event: `"load"`, `"domcontentloaded"`, `"networkidle"`, or `"commit"`. |
| `userAgent`                     | `string`   | Browser User-Agent string.                                                                   |
| `locale`                        | `string`   | Browser locale (e.g. `"de-DE"`).                                                             |
| `timezoneId`                    | `string`   | IANA timezone (e.g. `"Europe/Berlin"`).                                                      |
| `extraHTTPHeaders`              | `object`   | Additional HTTP headers added to every request.                                              |
| `viewport.width`                | `number`   | Default viewport width in pixels (default `1280`).                                           |
| `viewport.height`               | `number`   | Default viewport height in pixels (default `900`).                                           |
| `cookieConsent.enabled`         | `boolean`  | Attempt to auto-click a cookie-consent accept button.                                        |
| `cookieConsent.timeoutMs`       | `number`   | How long to wait for the consent button to appear.                                           |
| `cookieConsent.buttonTextRegex` | `string`   | Regex matched against button text.                                                           |
| `cookieConsent.cssSelectors`    | `string[]` | CSS selectors tried first before falling back to text matching.                              |

---

## `urls[]`

| Key                  | Type       | Default | Description                                                       |
| -------------------- | ---------- | ------- | ----------------------------------------------------------------- |
| `url`                | `string`   | —       | Page URL.                                                         |
| `enabled`            | `boolean`  | `true`  | Set `false` to skip without deleting from config.                 |
| `tags`               | `string[]` | `[]`    | Arbitrary labels shown in reports (e.g. `["price", "de"]`).       |
| `overrides.viewport` | `object`   | —       | Override global viewport for this URL only (`{ width, height }`). |
| `selectors[]`        | array      | —       | Elements to watch on this page.                                   |
| `loginChecks[]`      | array      | —       | Elements that must exist for the page to count as logged in.      |

### `selectors[]`

| Key                        | Type                           | Default | Description                                                                                          |
| -------------------------- | ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `cssPath`                  | `string`                       | —       | CSS selector.                                                                                        |
| `elementIndex`             | `number`                       | —       | Zero-based index when selector matches multiple elements.                                            |
| `compareMode`              | `"innerText"` \| `"innerHTML"` | —       | What to extract and compare.                                                                         |
| `name`                     | `string`                       | —       | Human-readable label shown in reports instead of the CSS path.                                       |
| `enabled`                  | `boolean`                      | `true`  | Set `false` to skip this selector.                                                                   |
| `initialLastContent`       | `string`                       | —       | Seed the snapshot baseline without a live scrape. Applied by `npm run seed`.                         |
| `ignorePatterns`           | `string[]`                     | `[]`    | Regex strings stripped from content before comparison. Useful for timestamps, ad IDs, view counters. |
| `waitForSelector`          | `string`                       | —       | Wait for this CSS selector to appear before extracting content.                                      |
| `waitForSelectorTimeoutMs` | `number`                       | `30000` | Timeout for `waitForSelector` in milliseconds.                                                       |
| `normalizeOverride`        | `object`                       | —       | Per-selector normalisation settings (same shape as top-level `normalize`).                           |

### `loginChecks[]`

| Key               | Type                           | Description                                                         |
| ----------------- | ------------------------------ | ------------------------------------------------------------------- |
| `cssPath`         | `string`                       | Selector for an element that only exists when logged in.            |
| `elementIndex`    | `number`                       | Zero-based index.                                                   |
| `compareMode`     | `"innerText"` \| `"innerHTML"` | Compare mode.                                                       |
| `expectedContent` | `string`                       | Optional. Content must also match this value to count as logged in. |
| `description`     | `string`                       | Optional human-readable label shown in the report.                  |

---

## Minimal config

```json
{
  "databasePath": "data/pcc.sqlite",
  "browser": {
    "headless": true,
    "userDataDir": "data/user-data",
    "timeoutMs": 30000,
    "waitUntil": "domcontentloaded"
  },
  "schedule": { "intervalHours": 24 },
  "login": { "interactive": false, "waitTimeoutMs": 60000 },
  "urls": [
    {
      "url": "https://example.com/product",
      "selectors": [
        {
          "cssPath": "span.price",
          "elementIndex": 0,
          "compareMode": "innerText"
        }
      ]
    }
  ]
}
```

Fields not specified use the defaults shown in the tables above.

---

## `screenshot`

Capture a screenshot of the page whenever a selector's content changes. Screenshots are saved as PNG files named `<hostname>-<timestamp>.png`.

| Key        | Type      | Default         | Description                                              |
| ---------- | --------- | --------------- | -------------------------------------------------------- |
| `onChange` | `boolean` | `false`         | Capture a screenshot when at least one selector changed. |
| `dir`      | `string`  | `"screenshots"` | Directory for screenshot files (relative to cwd).        |

Omit the `screenshot` key entirely to disable screenshots.

---

## `notifications`

All channels are opt-in. Set `enabled: true` on each channel to activate it.

### Top-level

| Key           | Type      | Default | Description                                                                   |
| ------------- | --------- | ------- | ----------------------------------------------------------------------------- |
| `onlyChanges` | `boolean` | `true`  | Send notifications only when at least one monitored selector changed content. |
| `email`       | object    | —       | SMTP email channel. See below.                                                |
| `webhooks`    | array     | `[]`    | HTTP webhook endpoints. See below.                                            |
| `telegram`    | object    | —       | Telegram Bot API channel. See below.                                          |

### `notifications.email`

Uses [nodemailer](https://nodemailer.com) for SMTP delivery.

| Key              | Type       | Description                                                        |
| ---------------- | ---------- | ------------------------------------------------------------------ |
| `enabled`        | `boolean`  | Activate email. Default `false`.                                   |
| `from`           | `string`   | Sender address (e.g. `"alerts@example.com"`).                      |
| `to`             | `string[]` | Recipient addresses.                                               |
| `subject`        | `string`   | Email subject line.                                                |
| `smtp.host`      | `string`   | SMTP server hostname.                                              |
| `smtp.port`      | `number`   | SMTP port (`587` for STARTTLS, `465` for TLS).                     |
| `smtp.secure`    | `boolean`  | Start TLS immediately (`true` for port 465, `false` for STARTTLS). |
| `smtp.auth.user` | `string`   | SMTP username.                                                     |
| `smtp.auth.pass` | `string`   | SMTP password. **Do not commit this value to version control.**    |

### `notifications.webhooks[]`

Each entry in the array is an independent webhook. Formats:

| `format`    | Target                  | Notes                                         |
| ----------- | ----------------------- | --------------------------------------------- |
| `"slack"`   | Slack Incoming Webhook  | Posts a formatted attachment with the diff.   |
| `"discord"` | Discord Webhook         | Posts an embed with the diff.                 |
| `"teams"`   | Microsoft Teams Webhook | Posts an Adaptive Card with the diff.         |
| `"generic"` | Any HTTP endpoint       | Posts a plain JSON object with results array. |

| Key       | Type      | Description                                                       |
| --------- | --------- | ----------------------------------------------------------------- |
| `enabled` | `boolean` | Activate this webhook endpoint. Default `false`.                  |
| `url`     | `string`  | Webhook URL.                                                      |
| `format`  | `string`  | One of `"slack"`, `"discord"`, `"teams"`, `"generic"`.            |
| `headers` | `object`  | Additional HTTP headers (e.g. `{ "Authorization": "Bearer …" }`). |

### `notifications.telegram`

Uses the [Telegram Bot API](https://core.telegram.org/bots/api) (`sendMessage`).

| Key           | Type      | Description                                                               |
| ------------- | --------- | ------------------------------------------------------------------------- |
| `enabled`     | `boolean` | Activate Telegram. Default `false`.                                       |
| `botToken`    | `string`  | Bot API token from [@BotFather](https://t.me/BotFather). Keep out of VCS. |
| `chatId`      | `string`  | Target chat or channel ID. Prefix with `-100` for supergroups/channels.   |
| `onlyChanges` | `boolean` | Per-channel override for `onlyChanges`. Defaults to the top-level value.  |
