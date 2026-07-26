# Operations guide

## Running once

```bash
npm run scrape
```

Loads `config.json`, opens Chromium, scrapes all enabled URLs, prints diffs.

## Running on a schedule

```bash
npm run schedule
```

Runs immediately, then repeats every `schedule.intervalHours` hours.
If a run is still in progress when the next tick fires, the tick is skipped and a
warning is logged — overlapping runs are never started. `SIGINT` and `SIGTERM`
cancel pending waits, close active browser contexts, wait for cleanup, and release
the database lock.

A stale-aware lock file next to SQLite prevents two processes from using the same
database/profile state. Use separate `databasePath` and `browser.userDataDir`
values when intentionally running independent instances.

## Linux — systemd

Create a service unit:

```ini
# /etc/systemd/system/page-change-checker.service
[Unit]
Description=Page Change Checker
After=network.target

[Service]
Type=simple
User=pcc
WorkingDirectory=/opt/page-change-checker
ExecStart=/usr/bin/node /opt/page-change-checker/dist/src/cli/index.js schedule
Restart=on-failure
RestartSec=10s
TimeoutStopSec=60s
UMask=0077
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now page-change-checker
sudo journalctl -u page-change-checker -f   # tail logs
```

Or use `npm run schedule` as `ExecStart` if you prefer to run via npm:

```ini
ExecStart=/usr/bin/npm run schedule
```

## macOS — launchd

```xml
<!-- ~/Library/LaunchAgents/com.page-change-checker.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.page-change-checker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/page-change-checker/dist/src/cli/index.js</string>
    <string>schedule</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/page-change-checker</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/page-change-checker/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/page-change-checker/logs/stderr.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.page-change-checker.plist
launchctl start com.page-change-checker
```

## Windows — Task Scheduler

```powershell
$action  = New-ScheduledTaskAction `
  -Execute "node" `
  -Argument "dist\src\cli\index.js schedule" `
  -WorkingDirectory "C:\path\to\page-change-checker"

$trigger = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName "PageChangeChecker" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings
```

## Capturing output

Reports and machine-readable `--json` output go to stdout. Correlated structured
logs go to stderr so logging cannot corrupt JSON pipelines.

```bash
npm run scrape > logs/report.log 2> logs/runtime.log
```

Or with timestamps:

```bash
npm run scrape 2>&1 | ts '[%Y-%m-%d %H:%M:%S]' >> logs/scrape.log
# requires `moreutils` (apt install moreutils / brew install moreutils)
```

## Docker Compose

The provided image runs as UID 1000. Its root filesystem is read-only and all
Linux capabilities are dropped. It installs only Chromium's headless shell;
interactive login requires a separate visible environment or a custom image and
display setup.

```bash
cp config.example.json config.json
mkdir -p data screenshots
chown -R 1000:1000 data screenshots  # Linux bind mounts
docker compose up --build -d
docker compose logs -f
```

Only `data/`, `screenshots/`, and bounded tmpfs paths are writable. Keep secrets
in an ignored `.env` file or an external secret manager and reference complete
values from config as `${NAME}`.

For high-assurance deployments, add an outbound firewall/proxy allowlist. The
application network guard is defense in depth, not a replacement for network
segmentation.

## Backup and restore

Before changing an existing schema, the application creates an integrity-checked
`*.backup.*` SQLite snapshot using `VACUUM INTO`; committed WAL state is included.
Stop the service before manual restore, preserve the failed database for
forensics, and copy the selected backup into `databasePath` with owner-only
permissions.

## Sending notifications

Pipe stdout to a notification script. Example using `curl` to post to a Slack webhook when a change is detected:

```bash
npm run scrape | grep -q "changed: yes" && \
  curl -s -X POST "$SLACK_WEBHOOK_URL" \
    -H 'Content-type: application/json' \
    -d '{"text":"Page change detected! Check the log."}'
```

## Database maintenance

The SQLite database grows slowly (one row per watched selector). No automatic
cleanup is done.

To inspect the database:

```bash
sqlite3 data/page-change-checker.sqlite
.tables
SELECT url, last_checked FROM urls;
SELECT css_path, last_content FROM watch_targets;
.quit
```

To reset all snapshots (forces a fresh baseline on next run):

```bash
sqlite3 data/page-change-checker.sqlite "UPDATE watch_targets SET last_content = NULL, last_changed = NULL;"
```

## Updating config without losing history

Add new URLs or selectors to `config.json`, then re-run seed:

```bash
npm run seed
```

This inserts new rows and skips existing ones. Existing snapshots are preserved.
