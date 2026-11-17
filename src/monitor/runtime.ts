import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { chromium } from 'playwright';
import type { BrowserContext, Page, Locator } from 'playwright';
import { z } from 'zod';

import { acquireFileLock } from '../core/fileLock.js';

import { watchRecordActivity } from './activity.js';
import { runRuleCheck, annotateChanges } from './capture.js';
import type { MonitorTarget } from './config.js';
import { monitorSettingsSchema } from './config.js';
import { runTargetBatch } from './coordinator.js';
import { drainOutbox, drainHistory } from './delivery.js';
import { runDoctor } from './doctor.js';
import type { DoctorProbe } from './doctor.js';
import { EvidenceStore } from './evidence.js';
import { coverageDegradation } from './health.js';
import type { ProgressSample } from './history.js';
import { progressTransaction, progressSchemaMigration, parseActivityIndicator } from './history.js';
import type { BaselineRevision, NavigationAttempt } from './journal.js';
import { MonitorJournal, ruleVersion, atomicWrite } from './journal.js';
import { projectMonitorMail, renderTextChangeDiff, verifyAcceptance } from './mail.js';
import type { EvidenceResult } from './mail.js';
import { navigateWithRetries } from './navigation.js';
import { renderPeriodSummary, periodSummary } from './period.js';
import { createStageRecorder } from './pipeline.js';
import { safePathPart, windowsPowerShell } from './platform.js';
import type { ReplayEntry } from './replay.js';
import { replayRules } from './replay.js';
import { ruleSchema, extractStatistic as sharedExtractStatistic } from './rules.js';
import type { Observation } from './rules.js';
import {
  httpRetrySettings,
  httpStatusFailureMessage,
  isFiveXxStatus,
  normalizePageTitle,
  berlinDateKey,
  berlinHour,
  renderTable,
  summarizeResult,
  fingerprintFor,
  errorResult,
  isTargetDue,
  normalizeWhitespace,
  escapeHtml,
  formatLocalDate,
  formatElapsedSince,
  latestInterestingChangeCell,
  firstLine,
  errorMessage
} from './runtimePolicy.js';
import {
  monitorStateSchema,
  progressSampleSchema,
  observationSchema,
  signatureSchema,
  parseQueuedMail
} from './runtimeTypes.js';
import type {
  MonitorState,
  MonitorResult,
  MonitorEvent,
  ProgressConfig,
  HistoryConnection,
  DailyEmail,
  NavigationOutcome,
  EmailDelivery,
  ReportContext
} from './runtimeTypes.js';
import {
  createWebsiteAdapter,
  authenticationFailure as websiteAuthenticationFailure
} from './sites.js';

export async function runLocalMonitor(root: string, args: string[] = process.argv.slice(2)) {
  const monitorDir = resolve(root);

  const settingsPath = join(monitorDir, 'settings.json');

  const statePath = join(monitorDir, 'state.json');

  const notificationPath = join(monitorDir, 'notification.json');

  const profilesDir = join(monitorDir, 'profiles');

  const reportsDir = join(monitorDir, 'reports');

  const screenshotsDir = join(monitorDir, 'screenshots');

  const parsedSettings = monitorSettingsSchema.safeParse(readJson(settingsPath));

  if (!parsedSettings.success)
    throw new Error(
      'Invalid private settings: ' +
        parsedSettings.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')
    );

  const settings = parsedSettings.data;

  const evidenceStore = new EvidenceStore(
    join(monitorDir, 'evidence'),
    Number(settings.evidenceMaxAgeDays ?? 90)
  );

  const monitorHostname = normalizeWhitespace(hostname()) || 'unknown-host';

  let journal: MonitorJournal;

  for (const directory of [profilesDir, reportsDir, screenshotsDir]) {
    mkdirSync(directory, { recursive: true });
  }

  function readState(): MonitorState {
    return monitorStateSchema.parse(readJson(statePath, { targets: {} }));
  }

  await main();

  async function main() {
    if (args.includes('--self-test')) {
      execFileSync(
        process.execPath,
        [
          resolve(monitorDir, '../../node_modules/vitest/vitest.mjs'),
          'run',
          'tests/unit/monitorRules.test.ts',
          'tests/unit/monitorOperations.test.ts',
          'tests/integration/monitorCapture.test.ts'
        ],
        { cwd: resolve(monitorDir, '../..'), stdio: 'inherit', windowsHide: true }
      );
      return;
    }
    if (args.includes('--test-login')) {
      await testAutomaticLogin();
      return;
    }
    const healthAlertIndex = args.indexOf('--send-health-alert');
    if (healthAlertIndex >= 0) {
      const message = args
        .slice(healthAlertIndex + 1)
        .join(' ')
        .trim();
      await sendHealthAlert(
        message || 'The local monitor watchdog detected an unhealthy monitor run.'
      );
      return;
    }

    if (args.includes('--health-snapshot')) {
      journal = new MonitorJournal(join(monitorDir, 'operations.sqlite'), { readOnly: true });
      try {
        writeHealthSnapshot(readState());
      } finally {
        journal.close();
      }
      return;
    }
    if (args.includes('--doctor')) {
      journal = new MonitorJournal(join(monitorDir, 'operations.sqlite'), { readOnly: true });
      try {
        const output = {
          components: await localDoctor(),
          health: writeHealthSnapshot(readState())
        };
        writeJson(join(reportsDir, 'doctor.json'), output);
        console.log('Component preflight saved locally; no email sent or history inserted.');
      } finally {
        journal.close();
      }
      return;
    }
    const lock = acquireFileLock(join(monitorDir, 'monitor'));
    journal = new MonitorJournal(join(monitorDir, 'operations.sqlite'));

    try {
      const dryIndex = args.indexOf('--dry-run-target');
      if (dryIndex >= 0) {
        const match = args[dryIndex + 1];
        const target = settings.targets.find((t) => t.id === match || t.url.includes(match));
        if (!target) throw new Error('Unknown local dry-run target');
        const context = await chromium.launchPersistentContext(
          profileDirectory(new URL(target.url).origin, target),
          {
            headless: true,
            ...(target.browserChannel ? { channel: target.browserChannel } : {}),
            locale: 'de-DE',
            timezoneId: 'Europe/Berlin',
            viewport: { width: 1400, height: 1000 }
          }
        );
        try {
          const result = await inspectTarget(context, target, new Date(), readState());
          const replay =
            result.captureEvidence && result.firstEvidence && result.evidenceId
              ? replayRules([
                  {
                    target: target.id,
                    evidenceId: result.evidenceId,
                    rules: target.rules,
                    firstEvidence: result.firstEvidence,
                    evidence: result.captureEvidence
                  }
                ])
              : [];
          writeJson(join(reportsDir, 'dry-run.json'), { result, replay });
          console.log(
            JSON.stringify({
              status: result.status,
              validated: result.observationsValidated,
              confirmedRules: result.decisions?.filter((d) => d.confirmed).length ?? 0,
              activityKnown:
                result.metricValues?.activeToday !== null && result.metricValues !== null
            })
          );
        } finally {
          await context.close();
        }
        return;
      }
      const replayIndex = args.indexOf('--replay-rules');
      if (replayIndex >= 0) {
        const proposedPath = args[replayIndex + 1];
        if (!proposedPath) throw new Error('Provide a local proposed rules JSON file.');
        const proposed = ruleSchema
          .array()
          .min(1)
          .parse(JSON.parse(readFileSync(proposedPath, 'utf8')));
        if (new Set(proposed.map((r) => r.id)).size !== proposed.length)
          throw new Error('Duplicate proposed rule IDs');
        const unavailable: { evidenceId: string; reason: string }[] = [];
        const records = journal
          .checks('1970-01-01', new Date().toISOString())
          .map((c) => c.payload as Partial<MonitorResult>)
          .map((r): ReplayEntry | null => {
            if (!r.id || !r.evidenceId || !r.captureEvidence || !r.firstEvidence) return null;
            let archive;
            try {
              archive = evidenceStore.get(r.evidenceId);
            } catch {
              unavailable.push({
                evidenceId: r.evidenceId,
                reason: 'Archive unavailable; recapture required.'
              });
              return null;
            }
            const definition = z.object({ rules: ruleSchema.array() }).safeParse(archive.bundle);
            if (archive.expired || !definition.success) {
              unavailable.push({
                evidenceId: r.evidenceId,
                reason: 'Archive expired or lacks rule definitions; recapture required.'
              });
              return null;
            }
            return {
              target: r.id,
              evidenceId: r.evidenceId,
              rules: definition.data.rules,
              firstEvidence: r.firstEvidence,
              evidence: r.captureEvidence
            };
          })
          .filter((r): r is ReplayEntry => r !== null);
        writeJson(join(reportsDir, 'rule-replay.json'), {
          original: replayRules(records),
          proposed: replayRules(records, proposed),
          unavailable
        });
        return;
      }
      if (args.includes('--dashboard') || args.includes('--replay')) {
        const until = new Date().toISOString();
        const since = new Date(Date.now() - 7 * 86400000).toISOString();
        const output = args.includes('--replay')
          ? journal.checks(since, until)
          : journal.metrics(since, until);
        const path = join(
          reportsDir,
          args.includes('--replay') ? 'replay-evidence.json' : 'dashboard.json'
        );
        writeJson(path, output);
        console.log(`Local read-only report: ${path}`);
        return;
      }
      if (args.includes('--login')) {
        await bootstrapLogin();
        return;
      }
      await runMonitor();
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(message);
      writeJson(notificationPath, {
        notify: true,
        title: 'Private page monitor failed',
        message: firstLine(message),
        reportPath: existsSync(join(reportsDir, 'latest.html'))
          ? join(reportsDir, 'latest.html')
          : null,
        openReport: false
      });
      process.exitCode = 1;
    } finally {
      journal.close();
      lock.release();
    }
  }

  function writeHealthSnapshot(state: MonitorState) {
    const now = new Date().toISOString();

    const metrics = journal.metrics(new Date(Date.now() - 86400000).toISOString(), now);
    let taskRunning = false;
    try {
      taskRunning =
        execFileSync(
          windowsPowerShell(),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "(Get-ScheduledTask -TaskName 'PageChangeChecker-PrivateMonitor' -ErrorAction Stop).State.ToString()"
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 10000 }
        ).trim() === 'Running';
    } catch {
      /* A missing task is reported by coverage health. */
    }
    const issues = coverageDegradation({
      now,
      lastCompletedAt: state.checkedAt ?? null,
      intervalMs: settings.intervalMinutes * 60000,
      taskRunning,
      targets: metrics.targets.map((t) => ({
        target: t.target,
        lastSuccessAt: t.lastSuccess,
        coverageAgeMs: t.coverageAgeMs,
        staleAfterMs: t.staleAfterMs
      })),
      queue: metrics.queue
    });
    const snapshot = {
      now,
      issues,
      taskRunning,
      metrics,
      lastCompletedAt: state.checkedAt ?? null,
      lastDailyEmailDate: journal.latestDailyDelivery(settings.dailyEmail?.to)?.dailyDate ?? null
    };
    writeJson(join(monitorDir, 'coverage-health.json'), snapshot);
    return snapshot;
  }

  async function localDoctor() {
    const probes: DoctorProbe[] = [
      {
        name: 'compiled-runtime-and-storage',
        check: () => {
          const path = join(monitorDir, '.doctor-' + process.pid + '.json');
          try {
            atomicWrite(path, '{}');
            if (readFileSync(path, 'utf8') !== '{}') throw new Error('Storage readback failed');
            const disk = statfsSync(monitorDir);
            if (disk.bavail * disk.bsize < 512 * 1024 * 1024) throw new Error('Low disk space');
            return 'Runtime loaded, storage read-write and disk free-space checked';
          } finally {
            rmSync(path, { force: true });
          }
        }
      },
      {
        name: 'browser-launch',
        check: async () => {
          const browser = await chromium.launch({ headless: true });
          await browser.close();
          return 'Bundled Chromium launches';
        }
      },
      {
        name: 'windows-scheduled-tasks',
        check: () => {
          const value = execFileSync(
            windowsPowerShell(),
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "(Get-ScheduledTask -TaskName 'PageChangeChecker-PrivateMonitor','PageChangeChecker-PrivateMonitorHealth' -ErrorAction Stop | Where-Object State -eq 'Running' | Measure-Object).Count"
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 10000 }
          );
          if (value.trim() !== '2') throw new Error('Tasks not both running');
          return 'Both scheduled tasks are running';
        }
      }
    ];
    for (const credentialFile of new Set(
      settings.targets.map((t) => t.autoLogin?.credentialFile).filter(Boolean)
    ))
      probes.push({
        name: 'login-credential-read',
        check: () => {
          const credential = readWindowsCredential(credentialFile, 'Credential unreadable');
          if (!credential.user || !credential.password) throw new Error('Incomplete credential');
          return 'Encrypted login credential readable by this Windows user';
        }
      });
    if (settings.dailyEmail?.enabled)
      probes.push({
        name: 'smtp-starttls-authentication',
        check: async () => {
          const email = settings.dailyEmail;
          if (!email) throw new Error('Email configuration unavailable');
          const credential = readWindowsCredential(
            email.smtp.credentialFile,
            'SMTP credential unreadable'
          );
          const transport = nodemailer.createTransport({
            host: email.smtp.host,
            port: email.smtp.port,
            secure: email.smtp.secure,
            requireTLS: !email.smtp.secure,
            auth: { user: credential.user, pass: credential.password },
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000
          });
          try {
            await transport.verify();
            return 'TLS and SMTP authentication succeeded; no message sent';
          } finally {
            transport.close();
          }
        }
      });
    const connection = historyConnection();
    if (connection)
      probes.push({
        name: 'native-postgresql-client-and-server',
        check: () => {
          const client = execFileSync(connection.psqlPath, ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10000
          });
          if (!/psql.*18\./i.test(client)) throw new Error('Wrong PostgreSQL client version');
          const server = runPsql(
            connection,
            "SELECT current_setting('server_version_num')||'|'||current_setting('data_directory');",
            { tuplesOnly: true }
          )
            .trim()
            .split('|');
          if (Number(server[0]) < 180000 || !/^([A-Za-z]:|\\\\)/.test(server[1] ?? ''))
            throw new Error('Expected native Windows PostgreSQL 18, not Docker');
          return 'Native PostgreSQL 18 client, server and password-file connection verified';
        }
      });
    return runDoctor(probes);
  }

  async function bootstrapLogin() {
    const target = settings.targets.find((candidate) => candidate.authenticationRequired === true);
    if (!target) {
      throw new Error('No authentication-required target is configured.');
    }

    const origin = new URL(target.url).origin;
    const profileDir = profileDirectory(origin, target);
    mkdirSync(profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1400, height: 1000 }
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://example.com/resource', {
      waitUntil: 'domcontentloaded',
      timeout: Number(settings.navigationTimeoutMs ?? 60_000)
    });

    const timeoutMinutes = Number(settings.loginBootstrapTimeoutMinutes ?? 15);
    console.log(
      `A visible Metric browser is open. Log in, confirm the profile is visible, then close the browser. It will close automatically after ${timeoutMinutes.toString()} minutes.`
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolveClose) => context.once('close', () => resolveClose())),
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(() => {
          void context
            .close()
            .catch(() => undefined)
            .finally(resolveTimeout);
        }, timeoutMinutes * 60_000);
      })
    ]);
    clearTimeout(timeout);
    console.log('Metric browser profile bootstrap finished.');
  }

  async function testAutomaticLogin() {
    const target = settings.targets.find((candidate) => candidate.adapterKey === 'provider');
    if (!target?.autoLogin) {
      throw new Error('No automatic provider login target is configured.');
    }

    const browser = await chromium.launch({
      ...(target.browserChannel ? { channel: target.browserChannel } : {}),
      headless: true
    });
    try {
      const context = await browser.newContext({
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        viewport: { width: 1400, height: 1000 }
      });
      const page = await context.newPage();
      await navigateTargetAndSettle(page, target);
      const loginMarker = await firstVisibleTextMarker(
        page,
        target.authCheck?.loggedOutTextContains ?? []
      );
      if (!loginMarker) {
        throw new Error(
          'Fresh provider browser did not expose a configured logged-out marker.'
        );
      }
      if (!(await ensureAutomaticLogin(page, target))) {
        throw new Error(`provider marker "${loginMarker}" did not trigger automatic login.`);
      }

      await navigateTargetAndSettle(page, target);
      const text = await page.locator('body').innerText({
        timeout: Number(settings.navigationTimeoutMs ?? 60_000)
      });
      const authenticationFailure = authenticationFailureReason(target, page.url(), text);
      if (authenticationFailure) throw new Error(authenticationFailure);
      const requiredRule = target.rules.find((rule) => 'selector' in rule);
      if (requiredRule && 'selector' in requiredRule && requiredRule.selector) {
        await waitForRequiredElement(page.locator(requiredRule.selector).first(), requiredRule);
      }
      console.log(
        `provider automatic-login test passed from marker "${loginMarker}" without using #accessCode.`
      );
    } finally {
      await browser.close();
    }
  }

  async function runMonitor() {
    const checkedAt = new Date();
    const runId = `${checkedAt.toISOString()}-${process.pid}`;
    const previousState = readState();
    journal.registerTargets(
      settings.targets
        .filter((t) => t.enabled !== false)
        .map((t) => ({
          id: t.id,
          label: t.label,
          url: t.url,
          intervalMs:
            t.checkSchedule?.frequency === 'daily' ? 86400000 : settings.intervalMinutes * 60000
        }))
    );
    const earlyHistory = await recoverHistory();
    const nextState: MonitorState = {
      checkedAt: checkedAt.toISOString(),
      lastDailyEmailDate: previousState.lastDailyEmailDate ?? null,
      emailErrorFingerprint: null,
      pendingEventEmailFingerprint: null,
      targets: { ...previousState.targets }
    };
    const results: MonitorResult[] = [];
    const newEvents: MonitorEvent[] = [];
    const dueTargets = settings.targets.filter(
      (target) =>
        target.enabled !== false &&
        isTargetDue(target, previousState.targets?.[target.id], checkedAt)
    );
    results.push(
      ...(await runTargetBatch(dueTargets, {
        deadline: Date.now() + Number(settings.maximumRunMinutes ?? 30) * 60000,
        open: async (origin, targets) => {
          const profileDir = profileDirectory(origin, targets[0]);
          mkdirSync(profileDir, { recursive: true });
          const channel = targets.find((t) => t.browserChannel)?.browserChannel;
          const context = await chromium.launchPersistentContext(profileDir, {
            ...(channel ? { channel } : {}),
            headless: settings.headless !== false,
            locale: 'de-DE',
            timezoneId: 'Europe/Berlin',
            viewport: { width: 1400, height: 1000 }
          });
          context.setDefaultTimeout(Number(settings.navigationTimeoutMs ?? 60000));
          return context;
        },
        inspect: (context, target) => inspectTarget(context, target, checkedAt, previousState),
        failure: (target, error) =>
          errorResult(target, checkedAt, 'Browser/inspection failed: ' + errorMessage(error)),
        persist: (target, result) => {
          createStageRecorder((result.stages ??= []))('save');
          recordMetricProgressHistory(target, result);
          finishResult(result, target, previousState, nextState, newEvents);
          recordCheck(result, target, runId);
          writeJson(statePath, {
            ...nextState,
            checkedAt: previousState.checkedAt ?? null,
            inProgress: true,
            runStartedAt: checkedAt.toISOString()
          });
        }
      }))
    );

    const checkedTargetIds = new Set(results.map((r) => r.id));
    const historyOutcome = await recoverHistory();
    for (const event of journal.events('1970-01-01', new Date().toISOString())) {
      const targetState = nextState.targets[event.target];
      if (
        event.kind === 'progress' &&
        targetState &&
        (!targetState.lastInterestingChangeAt ||
          Date.parse(event.at) > Date.parse(targetState.lastInterestingChangeAt))
      )
        targetState.lastInterestingChangeAt = event.at;
    }
    for (const result of results)
      if (nextState.targets[result.id]?.lastInterestingChangeAt)
        result.lastInterestingChangeAt = nextState.targets[result.id].lastInterestingChangeAt;
    if (historyOutcome.error || earlyHistory.error)
      for (const result of results.filter((r) =>
        isActiveMetricHistoryTarget(settings.targets.find((t) => t.id === r.id))
      ))
        result.warnings.push(
          'History backlog recovery failed; queued data is retained: ' +
            (historyOutcome.error ?? earlyHistory.error)
        );
    const skippedTargets = settings.targets
      .filter((t) => !checkedTargetIds.has(t.id))
      .map((t) => {
        const prev = previousState.targets?.[t.id];
        return {
          id: t.id,
          label: t.label,
          url: t.url,
          title: prev?.title ?? '',
          checkedAt: prev?.checkedAt ?? null,
          lastInterestingChangeAt: prev?.lastInterestingChangeAt ?? null
        };
      });

    const until = new Date().toISOString();
    writeJson(
      join(reportsDir, 'dashboard.json'),
      journal.metrics(new Date(Date.now() - 86400000).toISOString(), until)
    );

    let reportPath = writeReport(results, checkedAt, null, { skippedTargets });
    for (const result of results) createStageRecorder((result.stages ??= []))('notify');
    const emailOutcome = await maybeSendEmailReport(
      results,
      reportPath,
      checkedAt,
      previousState,
      newEvents.length,
      args.includes('--send-daily-email-now')
    );
    if (emailOutcome.sentDate) {
      nextState.lastDailyEmailDate = emailOutcome.sentDate;
      nextState.dailyJournalCutoff = emailOutcome.cutoff;
    }
    nextState.dailyJournalCutoff ??= previousState.dailyJournalCutoff ?? null;
    nextState.pendingEventEmailFingerprint = emailOutcome.pendingEventEmailFingerprint;
    if (emailOutcome.error) {
      const emailErrorFingerprint = createHash('sha256').update(emailOutcome.error).digest('hex');
      nextState.emailErrorFingerprint = emailErrorFingerprint;
      if (previousState.emailErrorFingerprint !== emailErrorFingerprint) {
        newEvents.push({
          label: 'Email delivery',
          status: 'error',
          summary: emailOutcome.error
        });
      }
      reportPath = writeReport(
        results,
        checkedAt,
        {
          status: 'error',
          message: emailOutcome.error
        },
        { skippedTargets }
      );
    }
    nextState.checkedAt = new Date().toISOString();
    writeJson(statePath, nextState);
    writeHealthSnapshot(nextState);
    const retainedEvidence = [
      ...settings.targets.flatMap((t) => journal.latestBaselines(t.id).map((b) => b.evidenceId)),
      ...journal.unprojectedEvents().map((e) => (e.payload as Partial<EvidenceResult>)?.evidenceId)
    ].filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id));
    evidenceStore.expire(new Date().toISOString(), retainedEvidence);
    journal.archiveDelivered(new Date(Date.now() - 7 * 86400000).toISOString(), (id, payload) =>
      evidenceStore.archiveMail(id, payload)
    );
    pruneReports(Number(settings.maxArchivedReports ?? 200));
    pruneScreenshots(Number(settings.screenshotMaxAgeDays ?? 90));

    const alertCount = newEvents.filter((event) => event.status === 'alert').length;
    const diagnosticCount = newEvents.length - alertCount;
    writeJson(notificationPath, {
      notify: newEvents.length > 0,
      title:
        newEvents.length === 0
          ? 'Private page monitor: no new alerts'
          : `Private page monitor: ${alertCount.toString()} alert(s), ${diagnosticCount.toString()} diagnostic(s)`,
      message:
        newEvents.length === 0
          ? 'No confirmed content changes. See the report for validated, skipped or inconclusive checks.'
          : newEvents
              .slice(0, 5)
              .map(
                (event) =>
                  `${event.label}${event.title ? ` — ${event.title}` : ''}: ${event.summary}`
              )
              .join('\n'),
      reportPath,
      openReport: settings.openReportOnNotification === true
    });

    printConsoleTables(results, reportPath);
  }

  function recordCheck(result: MonitorResult, target: MonitorTarget, runId: string) {
    result.evidenceId ??= `${runId}:${result.id}`;
    const evidenceId = result.evidenceId;
    const baselines: BaselineRevision[] = Object.entries(result.observations).map(
      ([ruleId, observation]) => ({
        target: target.id,
        ruleId,
        version: observation.version,
        definition: target.rules.find((r) => r.id === ruleId),
        observation,
        at: result.checkedAt,
        evidenceId
      })
    );
    if (result.captureSignature && result.pageValidated)
      baselines.push({
        target: target.id,
        ruleId: '__screenshot__',
        version: 'capture-v2',
        definition: { kind: 'evidenceScreenshot' },
        observation: result.captureSignature,
        at: result.checkedAt,
        evidenceId: result.evidenceId
      });
    journal.record(
      {
        runId,
        target: result.id,
        startedAt: result.startedAt,
        endedAt: result.endedAt ?? new Date().toISOString(),
        validated: result.observationsValidated === true,
        status: result.status,
        httpStatus: result.httpStatus,
        retries: result.retries,
        attemptStatuses: result.attemptStatuses,
        attempts: result.attempts,
        authentication: target.authenticationRequired
          ? result.pageValidated
            ? 'validated'
            : 'unverified'
          : 'not-required',
        baselineVersion: ruleVersion(target.rules),
        evidenceId: result.evidenceId,
        storageResult: result.storageResult,
        rejectedCandidates: result.decisions?.filter((d) => !d.valid).length ?? 0,
        payload: result
      },
      result.confirmedChange
        ? [
            {
              id: `content:${result.evidenceId}`,
              target: result.id,
              at: result.checkedAt,
              kind: 'content',
              payload: result
            }
          ]
        : [],
      baselines
    );
  }

  async function inspectTarget(
    context: BrowserContext,
    target: MonitorTarget,
    checkedAt: Date,
    previousState: MonitorState
  ): Promise<MonitorResult> {
    const saved = previousState.targets?.[target.id];
    const revisions = journal.latestBaselines(target.id);
    const prior: Record<string, Observation> = Object.fromEntries(
      revisions
        .filter((r) => r.ruleId !== '__screenshot__')
        .flatMap((r) => {
          const parsed = observationSchema.safeParse(r.observation);
          return parsed.success ? [[r.ruleId, parsed.data]] : [];
        })
    );
    const parsedSignature = signatureSchema.safeParse(
      revisions.find((r) => r.ruleId === '__screenshot__')?.observation
    );
    const previousSignature = parsedSignature.success ? parsedSignature.data : undefined;
    const result: MonitorResult = {
      id: target.id,
      label: target.label,
      url: target.url,
      finalUrl: target.url,
      title: saved?.title ?? '',
      checkedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      retries: 0,
      attemptStatuses: [],
      attempts: [],
      status: 'unchanged',
      httpStatus: null,
      alerts: [],
      warnings: [],
      notes: [],
      observations: {},
      observationsValidated: false,
      pageValidated: false,
      persistentFailure: false,
      error: null,
      text: '',
      metricValues: null,
      screenshotPath: null,
      diffScreenshotPath: null,
      skipScreenshot: false,
      confirmedChange: false,
      storageResult: 'not-required'
    };
    const page = await context.newPage();
    const activityObserver =
      target.progress?.activityResponseUrlContains && target.progress.activityDatePath
        ? watchRecordActivity(page, {
            username: new URL(target.url).pathname.split('/').filter(Boolean).at(-1) ?? '',
            responseUrlContains: target.progress.activityResponseUrlContains,
            datePath: target.progress.activityDatePath,
            timeZone: target.progress.activityTimeZone
          })
        : null;
    const adapter = createWebsiteAdapter(target, () =>
      readWindowsCredential(
        target.autoLogin?.credentialFile,
        'Encrypted login credential is unavailable.'
      )
    );
    const observeStage = createStageRecorder((result.stages ??= []));
    const navigate = async () => {
      const outcome = await navigateTargetWithHttpRetries(
        page,
        target,
        result.notes,
        result.attemptStatuses,
        result.attempts
      );
      applyNavigationOutcome(result, outcome, target, page);
      return outcome.status;
    };
    try {
      const outcome = await runRuleCheck(page, target.rules, prior, {
        ...target,
        timeoutMs: Number(settings.requiredElementTimeoutMs ?? 30000),
        navigate,
        authenticate: adapter.authenticationFailure,
        authenticateSession: () => adapter.authenticate(page),
        onStage: observeStage,
        recoverAuthentication: target.autoLogin
          ? async () => {
              await ensureAutomaticLogin(page, target);
            }
          : undefined,
        requiredStatistics: adapter.requiredStatistics,
        authenticatedSelector: adapter.authenticatedSelector,
        title: (title) => normalizePageTitle(title, target),
        confirmationWaitMs: changeConfirmationWaitMs(target)
      });
      const { evidence, firstEvidence, screenshot, signature, decisions } = outcome;
      Object.assign(result, {
        finalUrl: evidence.finalUrl,
        title: evidence.title,
        text: evidence.text,
        httpStatus: evidence.httpStatus,
        captureEvidence: evidence,
        firstEvidence,
        captureSignature: signature,
        decisions,
        observations: outcome.observations,
        observationsValidated: outcome.confirmedAll,
        pageValidated: true,
        confirmedChange: outcome.changed,
        metricReadAt: evidence.at
      });
      result.alerts = decisions.flatMap((d) =>
        d.valid && d.confirmed && d.alert ? [d.alert] : []
      );
      result.warnings.push(...decisions.filter((d) => !d.valid).map((d) => `${d.id}: ${d.reason}`));
      result.notes.push(
        ...decisions
          .filter((d) => d.initial && d.valid)
          .map((d) => `${d.id}: initial baseline confirmed twice.`),
        ...decisions
          .filter((d) => d.rebaselined && d.valid)
          .map((d) => `${d.id}: rule changed; independent new baseline confirmed and archived.`)
      );
      result.evidenceId = evidenceStore.put(
        { target: target.id, rules: target.rules, firstEvidence, evidence, decisions },
        screenshot,
        evidence.at
      );
      result.screenshotPath = evidenceStore.imagePath(result.evidenceId);
      if (
        target.adapterKey !== 'provider' &&
        outcome.changed &&
        previousSignature &&
        signature &&
        screenshot
      ) {
        const diff = await annotateChanges(page, screenshot, previousSignature, signature);
        if (diff)
          result.diffScreenshotPath = saveScreenshotBuffer(target, checkedAt, diff, 'changes');
      }
      if (isActiveMetricHistoryTarget(target)) {
        result.metricValues = {
          ...extractMetricProgress(evidence.text, target.progress),
          activeToday: null,
          activitySource: 'unavailable'
        };
        const progress = target.progress;
        if (activityObserver) {
          const activity = await activityObserver.read(evidence.at);
          if (
            activity &&
            (activity.apiValueA === null ||
              activity.apiValueA === result.metricValues.valueA) &&
            (activity.apiValueB === null ||
              activity.apiValueB === result.metricValues.valueB)
          ) {
            result.metricValues.activeToday = activity.activeToday;
            result.metricValues.activitySource = activity.source;
            result.metricValues.activityDay = activity.activityDay;
            result.metricValues.activityTimeZone = activity.timeZone;
          }
        }
        if (progress?.activitySelector) {
          const locator = page.locator(progress.activitySelector).first();
          if (await locator.count()) {
            const value = progress.activityAttribute
              ? await locator.getAttribute(progress.activityAttribute)
              : await locator.innerText();
            result.metricValues.activeToday = parseActivityIndicator(
              value,
              progress.activeValues ?? [],
              progress.inactiveValues ?? []
            );
            result.metricValues.activitySource = progress.activityAttribute ?? 'visible-text';
          }
        }
        if (result.metricValues.activeToday === null)
          result.warnings.push(
            'Activation indicator unavailable; stored as unknown, not inferred from metric values.'
          );
        if (result.metricValues.valueA === null || result.metricValues.valueB === null)
          result.warnings.push(
            'A required progress statistic was unavailable; valid metrics retained independently.'
          );
      }
      result.status = outcome.changed
        ? 'alert'
        : !outcome.confirmedAll
          ? 'inconclusive'
          : result.warnings.length
            ? 'warning'
            : 'unchanged';
    } catch (error) {
      result.status = 'error';
      result.error = errorMessage(error);
      result.httpStatus = result.attempts.at(-1)?.status ?? result.httpStatus;
      result.finalUrl = page.url() || target.url;
      result.title =
        normalizePageTitle(await page.title().catch(() => ''), target) || saved?.title || '';
      result.text = await page
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => '');
      result.persistentFailure = Boolean(
        authenticationFailureReason(target, result.finalUrl, result.text)
      );
      try {
        const screenshot = await page.screenshot({ fullPage: true, timeout: 5000 });
        result.evidenceId = evidenceStore.put(
          { target: target.id, title: result.title, text: result.text, error: result.error },
          screenshot
        );
        result.screenshotPath = evidenceStore.imagePath(result.evidenceId);
      } catch {
        result.warnings.push('Error evidence screenshot unavailable.');
      }
    } finally {
      activityObserver?.close();
      await page.close().catch(() => undefined);
    }
    result.endedAt = new Date().toISOString();
    result.checkedAt = result.endedAt;
    result.retries = result.attempts.filter((a) => a.status === null || a.status >= 400).length;
    result.fingerprint = fingerprintFor(result);
    return result;
  }

  function finishResult(
    result: MonitorResult,
    target: MonitorTarget,
    previousState: MonitorState,
    nextState: MonitorState,
    newEvents: MonitorEvent[]
  ) {
    const previous = previousState.targets?.[target.id];
    result.title ||= previous?.title ?? '';
    result.fingerprint = fingerprintFor(result);
    const interesting = result.confirmedChange
      ? (result.metricReadAt ?? result.checkedAt)
      : (result.progressInterestingAt ?? previous?.lastInterestingChangeAt ?? null);
    result.lastInterestingChangeAt = interesting;
    if (result.confirmedChange)
      newEvents.push({
        label: target.label,
        title: result.title,
        status: 'alert',
        summary: summarizeResult(result)
      });
    nextState.targets[target.id] = {
      ...previous,
      status: result.status,
      fingerprint: result.fingerprint,
      title: result.title || previous?.title || '',
      observations: { ...previous?.observations, ...result.observations },
      lastScreenshot: result.screenshotPath ?? previous?.lastScreenshot ?? null,
      lastDiffScreenshot: result.diffScreenshotPath ?? null,
      lastInterestingChangeAt: interesting,
      lastAttemptAt: result.checkedAt,
      checkedAt: result.checkedAt,
      lastSuccessfulValidatedCheckAt: result.observationsValidated
        ? result.checkedAt
        : (previous?.lastSuccessfulValidatedCheckAt ?? null),
      lastProgressObservedAt:
        result.metricValues && result.pageValidated
          ? result.metricReadAt
          : (previous?.lastProgressObservedAt ?? null),
      rulesVersion: ruleVersion(target.rules)
    };
  }

  function isActiveMetricHistoryTarget(target: MonitorTarget | undefined) {
    const history = settings.metricHistory;
    return (
      history?.enabled === true &&
      Array.isArray(history.activeTargetIds) &&
      target !== undefined &&
      history.activeTargetIds.includes(target.id)
    );
  }

  function extractMetricProgress(text: string, progress: ProgressConfig) {
    return {
      valueA: sharedExtractStatistic(text, progress?.metricALabel ?? 'Value A'),
      valueB: sharedExtractStatistic(text, progress?.metricBLabel ?? 'Value B')
    };
  }

  function historyConnection() {
    const h = settings.metricHistory;
    if (!h?.enabled) return null;
    return {
      host: h.host,
      port: h.port,
      user: h.username,
      database: h.database,
      psqlPath: h.psqlPath,
      connectTimeoutSeconds: h.connectTimeoutSeconds
    };
  }

  function recordMetricProgressHistory(target: MonitorTarget, result: MonitorResult) {
    if (!isActiveMetricHistoryTarget(target) || !result.metricValues || !result.pageValidated)
      return;
    const { valueA, valueB, activeToday, activitySource, activityDay, activityTimeZone } =
      result.metricValues;
    if (valueA === null && valueB === null) {
      result.storageResult = 'no-valid-sample';
      return;
    }
    const observedAt = result.metricReadAt ?? result.checkedAt;
    const sample: ProgressSample = {
      profile: target.id,
      label: target.label,
      observedAt,
      valueA,
      valueB,
      status: result.status,
      activeToday,
      activitySource,
      activityDay: activityDay ?? berlinDateKey(new Date(observedAt)),
      activityTimeZone: activityTimeZone ?? target.progress?.activityTimeZone ?? 'Europe/Berlin',
      intervalStartAt: readState().targets?.[target.id]?.lastProgressObservedAt ?? null
    };
    const id = `${target.id}:${sample.observedAt}`;
    try {
      progressTransaction(sample);
      journal.spool(id, sample);
      result.storageResult = 'queued';
    } catch (error) {
      result.storageResult = 'rejected';
      journal.storageAttempt(id, 'rejected', 'Sample could not be spooled');
      result.warnings.push('Metric history storage failed: ' + errorMessage(error));
      if (result.status === 'unchanged') result.status = 'warning';
    }
  }

  async function recoverHistory() {
    const connection = historyConnection();
    if (!connection) return { stored: 0, error: null };
    try {
      ensureMetricHistorySchema(connection);
      return await drainHistory(journal, (id, payload) => {
        const sample = progressSampleSchema.parse(payload);
        runPsql(connection, progressTransaction(sample));
        const events = z
          .array(z.string())
          .parse(
            JSON.parse(
              runPsql(
                connection,
                `SELECT coalesce(json_agg(event_type),'[]'::json) FROM metric_progress_events WHERE profile_id=${sqlLiteral(sample.profile)} AND observed_at=${sqlLiteral(sample.observedAt)}::timestamptz;`,
                { tuplesOnly: true }
              ).trim() || '[]'
            )
          );
        if (events.length)
          journal.addEvent({
            id: `progress:${id}`,
            target: sample.profile,
            at: sample.observedAt,
            kind: 'progress',
            payload: { sample, events }
          });
        return Promise.resolve();
      });
    } catch (error) {
      journal.storageAttempt('database-preflight', 'failed', firstLine(errorMessage(error)));
      return { stored: 0, error: errorMessage(error) };
    }
  }

  function ensureMetricHistorySchema(connection: HistoryConnection) {
    runPsql(
      connection,
      `create table if not exists metric_progress_samples (
       id bigserial primary key,
       profile_id text not null,
       profile_label text not null,
       observed_at timestamptz not null,
       value_a integer,
       value_b integer,
       source_status text not null,
       recorded_at timestamptz not null default now(),
       unique (profile_id, observed_at)
     );
     create index if not exists metric_progress_samples_profile_time_idx
       on metric_progress_samples (profile_id, observed_at);
     create table if not exists metric_progress_events (
       id bigserial primary key,
       profile_id text not null,
       observed_at timestamptz not null,
       event_type text not null check (event_type in ('value_a_increased', 'value_b_increased', 'activated')),
       previous_value_a integer,
       value_a integer,
       previous_value_b integer,
       value_b integer,
       recorded_at timestamptz not null default now(),
       unique (profile_id, observed_at, event_type)
     );
     create index if not exists metric_progress_events_profile_time_idx
       on metric_progress_events (profile_id, observed_at);`
    );
    runPsql(connection, progressSchemaMigration);
  }

  function runPsql(
    connection: HistoryConnection,
    sql: string,
    options: { tuplesOnly?: boolean } = {}
  ) {
    const args = [
      '--no-password',
      '--host',
      connection.host,
      '--port',
      connection.port.toString(),
      '--username',
      connection.user,
      '--dbname',
      connection.database,
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql
    ];
    if (options.tuplesOnly === true) {
      args.push('--tuples-only', '--no-align', '--field-separator', '|');
    }
    return execFileSync(connection.psqlPath, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(connection.connectTimeoutSeconds ?? 5)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  function sqlLiteral(value: unknown) {
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  function changeConfirmationWaitMs(target: MonitorTarget) {
    const configured = Number(
      target.changeConfirmationWaitMs ?? settings.changeConfirmationWaitMs ?? 60_000
    );
    return Number.isFinite(configured)
      ? Math.max(10_000, Math.min(configured, 5 * 60_000))
      : 60_000;
  }

  async function navigateTargetAndSettle(
    page: Page,
    target: MonitorTarget,
    timeoutMs: number = Number(settings.navigationTimeoutMs ?? 60000)
  ) {
    const response = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    const status = response?.status() ?? null;
    if (status === null || status < 400) {
      await dismissCookieConsent(page);
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(Number(target.settleMs ?? settings.defaultSettleMs ?? 5_000));
    }
    return status;
  }

  async function navigateTargetWithHttpRetries(
    page: Page,
    target: MonitorTarget,
    notes: string[],
    attemptStatuses: (number | null)[] = [],
    attempts: NavigationAttempt[] = []
  ) {
    const retry = httpRetrySettings(target),
      start = attempts.length;
    const status = await navigateWithRetries(
      page,
      target.url,
      {
        timeoutMs: Number(settings.navigationTimeoutMs ?? 60000),
        maxAttempts: retry.maxAttempts,
        retryDelayMs: retry.retryDelayMs,
        statuses: retry.statuses,
        settleMs: Number(target.settleMs ?? settings.defaultSettleMs ?? 5000),
        afterLoad: () => dismissCookieConsent(page)
      },
      attempts
    );
    attemptStatuses.push(...attempts.slice(start).map((a) => a.status));
    if (attempts.length - start > 1)
      notes.push(
        'Recovered navigation after retry; counted in daily diagnostics, not an urgent error.'
      );
    return { status, attempts: attempts.length - start, persistentFailure: false };
  }

  function applyNavigationOutcome(
    result: MonitorResult,
    navigation: NavigationOutcome,
    target: MonitorTarget,
    page: Page
  ) {
    result.httpStatus = navigation.status;
    result.finalUrl = page.url() || result.finalUrl;
    result.persistentFailure ||= navigation.persistentFailure === true;
    if (navigation.error)
      throw navigation.error instanceof Error
        ? navigation.error
        : new Error(errorMessage(navigation.error), { cause: navigation.error });
    if (navigation.status !== null && isFiveXxStatus(navigation.status)) {
      throw new Error(httpStatusFailureMessage(navigation.status, target));
    }
    if (navigation.status !== null && navigation.status >= 400) {
      throw new Error(httpStatusFailureMessage(navigation.status, target));
    }
  }

  function ensureAutomaticLogin(page: Page, target: MonitorTarget) {
    return createWebsiteAdapter(target, () =>
      readWindowsCredential(
        target.autoLogin?.credentialFile,
        'Encrypted login credential is unavailable.'
      )
    ).authenticate(page);
  }

  async function firstVisibleTextMarker(page: Page, markers: string[]) {
    for (const marker of markers) {
      if (
        await page
          .getByText(String(marker), { exact: true })
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false)
      ) {
        return String(marker);
      }
    }
    return null;
  }

  function authenticationFailureReason(target: MonitorTarget, finalUrl: string, text: string) {
    return websiteAuthenticationFailure(target, finalUrl, text);
  }

  async function waitForRequiredElement(
    locator: Locator,
    rule: { selector?: string; timeoutMs?: number }
  ) {
    const timeoutMs = Number(rule.timeoutMs ?? settings.requiredElementTimeoutMs ?? 60_000);
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      throw new Error(
        `Required element "${rule.selector}" was not visible within ${(timeoutMs / 1_000).toString()} seconds; the login may have expired or the page structure may have changed.`
      );
    }
  }

  async function dismissCookieConsent(page: Page) {
    const selectors = [
      '#onetrust-accept-btn-handler',
      '[data-testid="cookie-banner-accept"]',
      'button:has-text("Alle akzeptieren")',
      'button:has-text("Accept all")'
    ];
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
        await button.click({ timeout: 2_000 }).catch(() => undefined);
        return;
      }
    }
  }

  function saveScreenshotBuffer(
    target: MonitorTarget,
    checkedAt: Date,
    buffer: Buffer,
    variant: string = ''
  ) {
    const day = checkedAt.toISOString().slice(0, 10);
    const dayDir = join(screenshotsDir, day);
    mkdirSync(dayDir, { recursive: true });
    const timestamp = checkedAt.toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const suffix = variant ? `-${safePathPart(variant)}` : '';
    const screenshotPath = join(dayDir, `${safePathPart(target.id)}-${timestamp}${suffix}.png`);
    writeFileSync(screenshotPath, buffer, { mode: 0o600 });
    return screenshotPath;
  }

  function writeReport(
    results: MonitorResult[],
    checkedAt: Date,
    emailDelivery: EmailDelivery | null = null,
    reportContext: ReportContext = {}
  ) {
    const timestamp = checkedAt.toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const archivePath = join(reportsDir, `monitor-${timestamp}.html`);
    const latestPath = join(reportsDir, 'latest.html');
    const html = renderReport(results, checkedAt, emailDelivery, {
      latestReportPath: latestPath,
      reportsDir,
      logsDir: join(monitorDir, 'logs'),
      metrics: journal.metrics(
        new Date(Date.now() - 86400000).toISOString(),
        new Date().toISOString()
      ),
      periodHtml: journal
        ? renderPeriodSummary(
            periodSummary(
              settings.targets
                .filter((t) => t.enabled !== false)
                .map((t) => ({
                  ...t,
                  intervalMs:
                    t.checkSchedule?.frequency === 'daily'
                      ? 86400000
                      : settings.intervalMinutes * 60000
                })),
              journal.reportChecks(
                new Date(Date.now() - 48 * 3600000).toISOString(),
                new Date().toISOString()
              ),
              readState().dailyJournalCutoff ?? new Date(Date.now() - 86400000).toISOString(),
              new Date().toISOString(),
              journal.events('1970-01-01', new Date().toISOString())
            ),
            new Date().toISOString()
          )
        : '',
      ...reportContext
    });
    writeFileSync(archivePath, html, { encoding: 'utf8', mode: 0o600 });
    writeAtomically(latestPath, html);
    return latestPath;
  }

  function renderReport(
    results: MonitorResult[],
    checkedAt: Date,
    emailDelivery: EmailDelivery | null = null,
    reportContext: ReportContext = {}
  ) {
    const alerts = results.flatMap((result) =>
      result.alerts.map((alert) => [
        pageTitleCell(result),
        link(result.url, result.label),
        alert.textDiff ? 'Text diff' : escapeHtml(alert.message),
        alert.textDiff
          ? renderTextChangeDiff(alert.textDiff.oldText, alert.textDiff.newText).html
          : escapeHtml(alert.observed),
        latestInterestingChangeCell(result, checkedAt),
        screenshotLinks(result)
      ])
    );
    const unchanged = results
      .filter((result) => result.status === 'unchanged' && result.observationsValidated)
      .map((result) => [
        pageTitleCell(result),
        link(result.url, result.label),
        result.notes.length > 0
          ? escapeHtml(result.notes.join(' '))
          : 'No configured alert condition triggered',
        result.httpStatus === null ? '—' : escapeHtml(String(result.httpStatus)),
        escapeHtml(formatLocalDate(result.checkedAt)),
        latestInterestingChangeCell(result, checkedAt)
      ]);
    const skippedRows = (reportContext.skippedTargets ?? []).map((skipped) => [
      escapeHtml(skipped.title || '(title unavailable)'),
      link(skipped.url, skipped.label),
      'Not checked this run',
      '—',
      skipped.checkedAt ? escapeHtml(formatLocalDate(skipped.checkedAt)) : '—',
      latestInterestingChangeCell(skipped, checkedAt)
    ]);
    const inconclusiveRows = results
      .filter((r) => !r.observationsValidated && r.status !== 'error')
      .map((r) => [
        pageTitleCell(r),
        link(r.url, r.label),
        'Inconclusive; prior baseline retained',
        latestInterestingChangeCell(r, checkedAt)
      ]);
    const diagnostics = results.flatMap((result) => {
      const rows = [];
      if (result.error) {
        rows.push([
          pageTitleCell(result),
          link(result.url, result.label),
          'Error',
          escapeHtml(result.error),
          latestInterestingChangeCell(result, checkedAt),
          screenshotLinks(result)
        ]);
      }
      for (const warning of result.warnings) {
        rows.push([
          pageTitleCell(result),
          link(result.url, result.label),
          'Warning',
          escapeHtml(warning),
          latestInterestingChangeCell(result, checkedAt),
          screenshotLinks(result)
        ]);
      }
      return rows;
    });
    if (emailDelivery?.message) {
      diagnostics.push([
        'Email delivery',
        '—',
        escapeHtml(emailDelivery.status),
        escapeHtml(emailDelivery.message),
        latestInterestingChangeCell(
          { lastInterestingChangeAt: checkedAt.toISOString() },
          checkedAt
        ),
        '—'
      ]);
    }

    const latestReportPath = reportContext.latestReportPath ?? join(reportsDir, 'latest.html');
    const localReportUrl = settings.localReportUrl ?? null;
    const reportHref = localReportUrl ?? pathToFileURL(latestReportPath).href;
    const reportsDirHref = pathToFileURL(reportContext.reportsDir ?? reportsDir).href;
    const logsDirHref = pathToFileURL(reportContext.logsDir ?? join(monitorDir, 'logs')).href;
    const quickLinksHtml = [
      `<a href="${escapeHtml(reportHref)}">${localReportUrl ? 'Open local web report' : 'Open latest report'}</a>`,
      `<a href="${escapeHtml(reportsDirHref)}">Reports folder</a>`,
      `<a href="${escapeHtml(logsDirHref)}">Logs folder</a>`
    ].join(' &mdash; ');

    const fullText = results
      .map(
        (result) => `
      <details ${result.status === 'unchanged' ? '' : 'open'}>
        <summary><span class="status ${escapeHtml(result.status)}">${escapeHtml(result.status)}</span>
          ${escapeHtml(result.title || '(title unavailable)')} \u2014 ${escapeHtml(result.label)}</summary>
        <p>URL: ${link(result.finalUrl, result.finalUrl)}</p>
        <p>HTTP status: ${result.httpStatus === null ? 'unknown' : escapeHtml(String(result.httpStatus))}</p>
        <p>Latest interesting change: ${latestInterestingChangeCell(result, checkedAt)}</p>
        ${result.screenshotPath || result.diffScreenshotPath ? `<p>${screenshotLinks(result)}</p>` : ''}
        <pre>${escapeHtml(result.text || '(No page text captured.)')}</pre>
      </details>`
      )
      .join('\n');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Private page monitor \u2014 ${escapeHtml(formatLocalDate(checkedAt.toISOString()))}</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; color: #172033; background: #f5f7fb; margin: 0; padding: 24px; }
    main { max-width: 1200px; margin: auto; }
    h1, h2 { color: #102a43; }
    table { width: 100%; border-collapse: collapse; background: white; margin: 12px 0 28px; }
    th, td { text-align: left; vertical-align: top; border: 1px solid #d8e1eb; padding: 9px; }
    th { background: #eaf0f7; }
    details { background: white; border: 1px solid #d8e1eb; border-radius: 6px; margin: 10px 0; padding: 10px; }
    summary { cursor: pointer; font-weight: 600; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 620px; overflow: auto; background: #111827; color: #f9fafb; padding: 14px; }
    .status { display: inline-block; border-radius: 999px; padding: 2px 8px; margin-right: 6px; color: white; background: #52616b; }
    .status.unchanged { background: #18794e; }
    .status.alert { background: #b42318; }
    .status.warning { background: #b54708; }
    .status.error { background: #7a271a; }
    .muted { color: #52616b; }
  </style>
</head>
<body>
<main>
  <h1>Private page monitor</h1>
  <p class="muted">Generated ${escapeHtml(formatLocalDate(checkedAt.toISOString()))} on ${escapeHtml(monitorHostname)}. Notifications are stateful: persistent identical alerts are not repeated.</p>
  <p>${quickLinksHtml}</p>
  ${
    reportContext.metrics
      ? `<h2>Monitoring health</h2><p>Unsent events: ${reportContext.metrics.unsentEvents}; history backlog: ${reportContext.metrics.historyBacklog}. Sustained degradation: ${escapeHtml(reportContext.metrics.sustainedDegradation.join(', ') || 'none')}.</p>${renderTable(
          [
            'Target',
            'Validated success',
            'Last attempt',
            'Last validated success',
            'Time since success',
            'Duration (seconds)',
            'Rejected candidates',
            'Recovered retries'
          ],
          reportContext.metrics.targets.map((t) => [
            escapeHtml(t.target),
            t.validatedSuccessRate === null
              ? 'No attempts'
              : `${(t.validatedSuccessRate * 100).toFixed(1)}%`,
            escapeHtml(formatLocalDate(t.lastAttempt)),
            t.lastSuccess ? escapeHtml(formatLocalDate(t.lastSuccess)) : 'None recorded',
            t.lastSuccess ? escapeHtml(formatElapsedSince(t.lastSuccess, checkedAt)) : 'Unknown',
            (t.durationMs / 1000).toFixed(1),
            String(t.rejectedCandidates),
            String(t.recoveredRetries)
          ]),
          'No check records yet'
        )}`
      : ''
  }
  <h2>Alerts</h2>
  ${renderTable(['Title', 'URL', 'Condition', 'Observed', 'Latest interesting change', 'Images'], alerts, 'No alert condition triggered.')}
  ${reportContext.periodHtml ?? ''}
  <h2>Validated unchanged pages in this run</h2>
  ${renderTable(['Title', 'URL', 'Result', 'HTTP', 'Checked', 'Latest interesting change'], unchanged, 'No page completed as validated unchanged.')}
  <h2>Not checked this run</h2>
  ${renderTable(['Title', 'URL', 'Result', 'HTTP', 'Last attempt', 'Latest interesting change'], skippedRows, 'All enabled pages were checked.')}
  <h2>Inconclusive checks</h2>
  ${renderTable(['Title', 'URL', 'Result', 'Latest interesting change'], inconclusiveRows, 'No inconclusive checks.')}
  <h2>Errors and warnings</h2>
  ${renderTable(['Title', 'URL', 'Type', 'Message', 'Latest interesting change', 'Images'], diagnostics, 'No errors or warnings.')}
  <h2>Captured page text</h2>
  ${fullText}
</main>
</body>
</html>`;
  }

  async function drainMonitorMail(targetJournal: MonitorJournal) {
    const email = settings.dailyEmail;
    if (!email?.enabled) return { sent: 0, quarantined: 0, deferred: 0, errors: [] };
    let transporter: Transporter<SMTPTransport.SentMessageInfo> | undefined;
    try {
      validateEmailSettings(email);
      const credential = readWindowsCredential(
        email.smtp.credentialFile,
        'Encrypted SMTP credential unavailable.'
      );
      transporter = nodemailer.createTransport({
        host: email.smtp.host,
        port: email.smtp.port,
        secure: email.smtp.secure,
        requireTLS: !email.smtp.secure,
        auth: { user: credential.user, pass: credential.password },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        disableFileAccess: true,
        disableUrlAccess: true
      });
      return await drainOutbox(targetJournal, async (pending) => {
        const payload = parseQueuedMail(pending.payload);
        const recipient = payload.recipient;
        if (!email.to.includes(recipient))
          throw Object.assign(
            new Error('Recipient configuration changed; archived mail needs rerouting'),
            { code: 'EMESSAGE' }
          );
        if (!transporter) throw new Error('Email transport unavailable');
        const info = await transporter.sendMail({
          from: { name: emailSenderDisplayName(email), address: email.from },
          to: [recipient],
          messageId: `<${createHash('sha256').update(pending.id).digest('hex')}@${monitorHostname}>`,
          subject: payload.subject,
          text: payload.text,
          html: payload.html,
          attachments: [
            {
              filename: 'monitor-report.html',
              content: payload.portableHtml ?? payload.html,
              contentType: 'text/html'
            },
            ...payload.attachments.map((a) => ({
              ...a,
              content: Buffer.from(a.content, 'base64')
            }))
          ]
        });
        verifyAcceptance(info, recipient);
      });
    } catch (error) {
      return { sent: 0, quarantined: 0, deferred: 1, errors: [errorMessage(error)] };
    } finally {
      transporter?.close();
    }
  }

  async function maybeSendEmailReport(
    results: MonitorResult[],
    reportPath: string,
    checkedAt: Date,
    previousState: MonitorState,
    newEventCount: number,
    forceDaily: boolean
  ) {
    const email = settings.dailyEmail;
    if (!email?.enabled) return { error: null, sentDate: null, pendingEventEmailFingerprint: null };
    const delivered = journal.latestDailyDelivery(settings.dailyEmail?.to);
    const date = berlinDateKey(checkedAt);
    const dailyDue =
      forceDaily ||
      (berlinHour(checkedAt) >= email.sendAfterHour &&
        (delivered?.dailyDate ?? previousState.lastDailyEmailDate) !== date);
    const cutoff = new Date().toISOString(),
      since = previousState.dailyJournalCutoff ?? new Date(Date.now() - 48 * 3600000).toISOString();
    const checks = journal.reportChecks(
      new Date(Math.min(Date.parse(since) - 86400000, Date.now() - 48 * 3600000)).toISOString(),
      cutoff
    );
    projectMonitorMail(journal, {
      targets: settings.targets
        .filter((t) => t.enabled !== false)
        .map((t) => ({
          ...t,
          intervalMs:
            t.checkSchedule?.frequency === 'daily' ? 86400000 : settings.intervalMinutes * 60000,
          title: previousState.targets?.[t.id]?.title ?? '',
          lastInterestingChangeAt: previousState.targets?.[t.id]?.lastInterestingChangeAt ?? null
        })),
      checks,
      recipients: email.to,
      subjectPrefix: email.subjectPrefix,
      since,
      now: cutoff,
      dailyDate: dailyDue ? date : undefined,
      sendEvents: email.sendOnNewEvents !== false
    });
    const outcome = await drainMonitorMail(journal),
      latest = journal.latestDailyDelivery(settings.dailyEmail?.to),
      queue = journal.queueHealth();
    return {
      error: outcome.errors.length
        ? outcome.errors.join('; ')
        : queue.quarantined
          ? 'A permanently rejected message is quarantined; inspect dashboard.'
          : null,
      sentDate: latest?.dailyDate ?? null,
      cutoff: latest?.cutoff ?? null,
      pendingEventEmailFingerprint: queue.pending ? 'pending' : null
    };
  }

  async function sendHealthAlert(message: string) {
    const healthJournal = new MonitorJournal(join(monitorDir, 'operations.sqlite'));
    try {
      const email = settings.dailyEmail;
      if (!email?.enabled) throw new Error('Daily email is not configured.');
      const day = berlinDateKey(new Date());
      for (const recipient of email.to)
        healthJournal.enqueue(
          `health:${day}:${createHash('sha256').update(recipient).digest('hex').slice(0, 16)}`,
          {
            recipient,
            subject: `${email.subjectPrefix} — monitor health warning — ${day}`,
            text: `Monitor health warning on ${monitorHostname}\n\n${message}`,
            html: `<p>Monitor health warning on ${escapeHtml(monitorHostname)}</p><p>${escapeHtml(message)}</p>`,
            attachments: [],
            dailyDate: null
          }
        );
      const outcome = await drainMonitorMail(healthJournal);
      if (outcome.errors.length) throw new Error(outcome.errors.join('; '));
    } finally {
      healthJournal.close();
    }
  }

  function validateEmailSettings(email: DailyEmail) {
    if (typeof email.from !== 'string' || !email.from.includes('@')) {
      throw new Error('dailyEmail.from must contain a sender email address');
    }
    if (!Array.isArray(email.to) || email.to.length === 0) {
      throw new Error('dailyEmail.to must contain at least one recipient');
    }
    if (typeof email.smtp?.host !== 'string' || email.smtp.host.trim() === '') {
      throw new Error('dailyEmail.smtp.host is required');
    }
    const port = Number(email.smtp.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('dailyEmail.smtp.port must be a valid TCP port');
    }
  }

  function readWindowsCredential(credentialFile: string | undefined, missingMessage: string) {
    if (typeof credentialFile !== 'string' || credentialFile.trim() === '') {
      throw new Error('Credential file must be a non-empty path');
    }
    const credentialPath = resolve(monitorDir, credentialFile);
    const monitorPrefix = `${resolve(monitorDir)}${sep}`.toLocaleLowerCase('en-US');
    if (!credentialPath.toLocaleLowerCase('en-US').startsWith(monitorPrefix)) {
      throw new Error('Credential file must remain inside the private monitor directory.');
    }
    if (!existsSync(credentialPath)) {
      throw new Error(missingMessage);
    }
    const helperPath = join(monitorDir, 'read-credential.ps1');
    const output = execFileSync(
      windowsPowerShell(),
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helperPath,
        '-CredentialPath',
        credentialPath
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    const credential = z
      .object({ user: z.string().min(1), password: z.string().min(1) })
      .parse(JSON.parse(output.trim()));
    if (!credential.user || !credential.password) {
      throw new Error('Encrypted credential did not contain a username and password');
    }
    return credential;
  }

  function emailSenderDisplayName(email: DailyEmail) {
    return (normalizeWhitespace(email.senderName) || monitorHostname).slice(0, 100);
  }

  function printConsoleTables(results: MonitorResult[], reportPath: string) {
    const unchanged = results
      .filter((result) => result.status === 'unchanged')
      .map((result) => `- unchanged | ${result.title || '(title unavailable)'} | ${result.url}`);
    const diagnostics = results
      .filter((result) => result.status !== 'unchanged')
      .map(
        (result) =>
          `- ${result.status} | ${result.title || '(title unavailable)'} | ${result.url} | ${summarizeResult(result)}`
      );

    console.log('\nUnchanged URLs');
    console.log(unchanged.length > 0 ? unchanged.join('\n') : '(none)');
    console.log('\nAlerts, errors, and warnings');
    console.log(diagnostics.length > 0 ? diagnostics.join('\n') : '(none)');
    console.log(`\nFull report: ${reportPath}`);
  }

  function profileDirectory(origin: string, target?: MonitorTarget) {
    if (target?.profileDirectoryName) {
      return join(profilesDir, safePathPart(target.profileDirectoryName));
    }
    const host = safePathPart(new URL(origin).hostname);
    const hash = createHash('sha256').update(origin).digest('hex').slice(0, 12);
    return join(profilesDir, `${host}-${hash}`);
  }

  function pruneReports(maxReports: number) {
    const reports = readdirSync(reportsDir)
      .filter((name) => /^monitor-.*\.html$/u.test(name))
      .sort((a, b) => a.localeCompare(b))
      .reverse();
    for (const name of reports.slice(Math.max(1, maxReports))) {
      rmSync(join(reportsDir, name), { force: true });
    }
  }

  function pruneScreenshots(maxAgeDays: number) {
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * 86_400_000;
    for (const day of readdirSync(screenshotsDir, { withFileTypes: true })) {
      if (!day.isDirectory()) continue;
      const dayPath = join(screenshotsDir, day.name);
      for (const file of readdirSync(dayPath, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const filePath = join(dayPath, file.name);
        if (statSync(filePath).mtimeMs < cutoff) rmSync(filePath, { force: true });
      }
    }
  }

  function screenshotLink(path: string | null | undefined, label: string = 'Open screenshot') {
    return path
      ? `<a href="${escapeHtml(pathToFileURL(path).href)}">${escapeHtml(label)}</a>`
      : null;
  }

  function screenshotLinks(result: MonitorResult) {
    const links = [
      screenshotLink(result.screenshotPath, 'Open screenshot'),
      screenshotLink(result.diffScreenshotPath, 'Open annotated change map')
    ].filter(Boolean);
    return links.length > 0 ? links.join('<br>') : '—';
  }

  function pageTitleCell(result: MonitorResult) {
    return escapeHtml(result.title || '(title unavailable)');
  }

  function link(url: string, label: string) {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  }

  function readJson(path: string, fallback: unknown = undefined) {
    if (!existsSync(path)) {
      if (arguments.length > 1) return fallback;
      throw new Error(`Required file not found: ${path}`);
    }
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON in ${path}: ${errorMessage(error)}`, { cause: error });
    }
  }

  function writeJson(path: string, value: unknown) {
    writeAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  function writeAtomically(path: string, content: string) {
    atomicWrite(path, content);
  }
}
