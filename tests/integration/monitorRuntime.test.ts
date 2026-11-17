import type * as ChildProcess from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { MonitorJournal } from '../../src/monitor/journal.js';
import type * as Platform from '../../src/monitor/platform.js';
import { runLocalMonitor } from '../../src/monitor/runtime.js';
import { monitorStateSchema } from '../../src/monitor/runtimeTypes.js';
import { html, startServer } from '../helpers/scraperSecurityScenarios.js';

const stubs = vi.hoisted(() => ({
  sqlFailure: false,
  sendMail: vi.fn(() =>
    Promise.resolve({ accepted: ['test@example.com'], rejected: [], messageId: 'test' })
  )
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: stubs.sendMail,
      verify: () => Promise.resolve(true),
      close: () => undefined
    })
  }
}));
vi.mock('../../src/monitor/platform.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Platform>()),
  windowsPowerShell: () => '/synthetic/powershell'
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>();
  return {
    ...original,
    execFileSync: vi.fn((file: string, args: string[]) => {
      const command = args.join(' ');
      if (file === 'synthetic-psql') {
        if (stubs.sqlFailure) throw new Error('Synthetic database unavailable');
        if (command.includes('--version')) return 'psql (PostgreSQL) 18.0';
        if (command.includes('server_version_num')) return '180000|C:\\Synthetic\\PostgreSQL';
        return command.includes('json_agg') ? '["value_a_increased"]' : '';
      }
      if (command.includes('-CredentialPath'))
        return JSON.stringify({ user: 'test', password: 'synthetic' });
      return command.includes('Measure-Object') ? '2' : 'Running';
    })
  };
});

it('fails closed on invalid commands, missing credentials/configuration and corrupted saved state without opening a browser', async () => {
  const root = mkdtempSync(join(tmpdir(), 'typed-command-errors-'));
  const settings = {
    intervalMinutes: 30,
    headless: true,
    targets: [
      {
        id: 'example',
        label: 'Example',
        url: 'https://example.com',
        rules: [{ id: 'text', kind: 'visibleTextSnapshot', selector: 'main', message: 'Changed' }]
      }
    ]
  };
  const save = () => writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
  const previousExitCode = process.exitCode;
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    save();
    for (const args of [['--dry-run-target', 'unknown'], ['--replay-rules'], ['--login']]) {
      await runLocalMonitor(root, args);
      expect(process.exitCode).toBe(1);
      process.exitCode = previousExitCode;
    }
    const proposed = join(root, 'rules.json');
    writeFileSync(
      proposed,
      JSON.stringify([settings.targets[0].rules[0], settings.targets[0].rules[0]])
    );
    await runLocalMonitor(root, ['--replay-rules', proposed]);
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
    await expect(runLocalMonitor(root, ['--test-login'])).rejects.toThrow(
      'No automatic'
    );
    await expect(runLocalMonitor(root, ['--send-health-alert', 'Synthetic'])).rejects.toThrow(
      'not configured'
    );
    writeFileSync(join(root, 'state.json'), '{');
    await expect(runLocalMonitor(root, ['--health-snapshot'])).rejects.toThrow('Invalid JSON');
    writeFileSync(join(root, 'settings.json'), '{');
    await expect(runLocalMonitor(root, [])).rejects.toThrow('Invalid JSON');
    writeFileSync(join(root, 'settings.json'), '{}');
    await expect(runLocalMonitor(root, [])).rejects.toThrow('Invalid private settings');
  } finally {
    errorLog.mockRestore();
    process.exitCode = previousExitCode;
    rmSync(root, { recursive: true, force: true });
  }
});

it(
  'keeps history and email delivery durable across failures, recovery and malformed queued messages',
  { timeout: 120000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'typed-delivery-'));
    let text = '1200\nValue A\n7\nValue B';
    const server = await startServer((_request, response) =>
      html(response, `<title>Account</title><main style="white-space:pre-line">${text}</main>`)
    );
    const settings = {
      intervalMinutes: 30,
      headless: true,
      navigationTimeoutMs: 2000,
      defaultSettleMs: 1,
      requiredElementTimeoutMs: 1000,
      changeConfirmationWaitMs: 1,
      dailyEmail: {
        enabled: true,
        sendOnNewEvents: true,
        sendAfterHour: 0,
        from: 'sender@example.com',
        to: ['test@example.com'],
        subjectPrefix: 'Synthetic',
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          credentialFile: 'credential.xml'
        }
      },
      metricHistory: {
        enabled: true,
        host: 'localhost',
        port: 5432,
        database: 'synthetic',
        username: 'test',
        psqlPath: 'synthetic-psql',
        connectTimeoutSeconds: 1,
        activeTargetIds: ['example']
      },
      targets: [
        {
          id: 'example',
          label: 'Example',
          url: server.url,
          progress: { metricALabel: 'Value A', metricBLabel: 'Value B' },
          rules: [{ id: 'text', kind: 'visibleTextSnapshot', selector: 'main', message: 'Changed' }]
        }
      ]
    };
    writeFileSync(join(root, 'credential.xml'), 'synthetic');
    writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
    try {
      stubs.sendMail.mockClear();
      await runLocalMonitor(root, []);
      expect(stubs.sendMail).toHaveBeenCalled();
      stubs.sqlFailure = true;
      text = '1250\nValue A\n8\nValue B';
      stubs.sendMail.mockRejectedValueOnce(
        Object.assign(new Error('Synthetic SMTP unavailable'), { code: 'ECONNECTION' })
      );
      await runLocalMonitor(root, []);
      let journal = new MonitorJournal(join(root, 'operations.sqlite'));
      try {
        expect(journal.backlog()).toHaveLength(1);
        expect(journal.queueHealth().pending).toBeGreaterThan(0);
        journal.enqueue('malformed', {});
      } finally {
        journal.close();
      }
      stubs.sqlFailure = false;
      await runLocalMonitor(root, ['--send-daily-email-now']);
      journal = new MonitorJournal(join(root, 'operations.sqlite'));
      try {
        expect(journal.backlog()).toHaveLength(0);
        expect(journal.queueHealth().quarantined).toBe(1);
        expect(
          journal.storageRecords('1970-01-01', '2999-01-01').some((r) => r.outcome === 'committed')
        ).toBe(true);
      } finally {
        journal.close();
      }
      await runLocalMonitor(root, ['--doctor']);
      await runLocalMonitor(root, ['--dry-run-target', 'example']);
      await runLocalMonitor(root, ['--send-health-alert', 'Synthetic health warning']);
      expect(readFileSync(join(root, 'reports', 'dry-run.json'), 'utf8')).toContain('replay');
    } finally {
      stubs.sqlFailure = false;
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);

it(
  'runs the typed production runner through baseline, change, invalid-page rejection and read-only commands',
  { timeout: 120000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'typed-monitor-'));
    let body = '<title>Account</title><main>Stable account text</main>';
    const server = await startServer((_request, response) => html(response, body));
    const rule = {
      id: 'text',
      kind: 'visibleTextSnapshot',
      selector: 'main',
      normalizeWhitespace: true,
      message: 'Text changed'
    };
    const settings = {
      intervalMinutes: 30,
      headless: true,
      navigationTimeoutMs: 2000,
      defaultSettleMs: 1,
      requiredElementTimeoutMs: 100,
      changeConfirmationWaitMs: 1,
      targets: [
        {
          id: 'example',
          label: 'Example',
          url: server.url,
          rules: [rule],
          httpRetry: { maxAttempts: 1, retryDelayMs: 1 }
        }
      ]
    };
    writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
    const readState = () =>
      monitorStateSchema.parse(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')));
    try {
      await runLocalMonitor(root, []);
      expect(readState().targets.example.status).toBe('unchanged');
      body = '<title>Account</title><main>Real new account text</main>';
      await runLocalMonitor(root, []);
      expect(readState().targets.example.status).toBe('alert');
      const before = new MonitorJournal(join(root, 'operations.sqlite'), { readOnly: true });
      const baseline = before.latestBaselines('example');
      expect(baseline.length).toBeGreaterThan(0);
      expect(before.events('1970-01-01', '2999-01-01')).toHaveLength(1);
      before.close();
      body =
        '<body class="neterror"><main>Press space to play DNS_PROBE_FINISHED_NO_INTERNET</main></body>';
      await runLocalMonitor(root, []);
      expect(readState().targets.example.status).not.toBe('alert');
      const after = new MonitorJournal(join(root, 'operations.sqlite'), { readOnly: true });
      try {
        expect(after.latestBaselines('example')).toEqual(baseline);
        expect(after.events('1970-01-01', '2999-01-01')).toHaveLength(1);
        const successful = after.checks('1970-01-01', '2999-01-01').filter((c) => c.validated);
        expect(successful).toHaveLength(2);
        const payload = successful[0].payload as { stages: { stage: string }[] };
        expect(payload.stages.map((s) => s.stage)).toContain('save');
      } finally {
        after.close();
      }
      for (const command of [
        '--health-snapshot',
        '--doctor',
        '--dashboard',
        '--replay',
        '--self-test'
      ])
        await runLocalMonitor(root, [command]);
      const proposed = join(root, 'proposed.json');
      writeFileSync(proposed, JSON.stringify([rule]));
      await runLocalMonitor(root, ['--replay-rules', proposed]);
      expect(readFileSync(join(root, 'reports', 'doctor.json'), 'utf8')).toContain('components');
      expect(readFileSync(join(root, 'reports', 'rule-replay.json'), 'utf8')).toContain('proposed');
      expect(process.exitCode ?? 0).toBe(0);
      writeFileSync(
        join(root, 'settings.json'),
        JSON.stringify({ ...settings, targets: [{ ...settings.targets[0], enabled: false }] })
      );
      await runLocalMonitor(root, []);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
