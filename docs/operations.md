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
warning is logged — overlapping runs are never started.

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
ExecStart=/usr/bin/node /opt/page-change-checker/dist/cli/index.js schedule
Restart=on-failure
RestartSec=10s
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
    <string>/Users/you/page-change-checker/dist/cli/index.js</string>
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
  -Argument "dist\cli\index.js schedule" `
  -WorkingDirectory "C:\path\to\page-change-checker"

$trigger = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName "PageChangeChecker" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -RunLevel Highest
```

## Capturing output

The tool writes to stdout only. To save output:

```bash
npm run scrape >> logs/scrape.log 2>&1
```

Or with timestamps:

```bash
npm run scrape 2>&1 | ts '[%Y-%m-%d %H:%M:%S]' >> logs/scrape.log
# requires `moreutils` (apt install moreutils / brew install moreutils)
```

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
