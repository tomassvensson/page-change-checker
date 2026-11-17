import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { runRuleCheck } from '../../src/monitor/capture.js';
import type { PipelineStage } from '../../src/monitor/pipeline.js';
import type { MonitorRule } from '../../src/monitor/rules.js';

const rule: MonitorRule = {
  id: 'text',
  kind: 'visibleTextSnapshot',
  selector: 'main',
  message: 'Changed'
};
it('authenticates before readiness/capture and reloads the requested page after login', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let loggedIn = false;
  const stages: PipelineStage[] = [];
  let navigations = 0;
  try {
    const result = await runRuleCheck(
      page,
      [rule],
      {},
      {
        navigate: async () => {
          navigations++;
          await page.setContent(loggedIn ? '<main>Account</main>' : '<main>Login</main>');
          return 200;
        },
        authenticateSession: () => {
          if (loggedIn) return Promise.resolve(false);
          loggedIn = true;
          return Promise.resolve(true);
        },
        authenticate: (_url, text) => (text.includes('Login') ? 'Login required' : null),
        onStage: (stage) => stages.push(stage),
        confirmationWaitMs: 1
      }
    );
    expect(result.confirmedAll).toBe(true);
    expect(navigations).toBe(3);
    expect(stages.slice(0, 5)).toEqual([
      'load',
      'authenticate',
      'load',
      'validate-readiness',
      'capture'
    ]);
    expect(result.evidence.text).toBe('Account');
  } finally {
    await browser.close();
  }
});
it('stops before capture and comparison when an offline shell persists after bounded recovery', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const stages: PipelineStage[] = [];
  let attempts = 0;
  try {
    await expect(
      runRuleCheck(
        page,
        [rule],
        {},
        {
          navigate: async () => {
            attempts++;
            await page.setContent(
              '<body class="neterror"><main>Press space to play DNS_PROBE_FINISHED_NO_INTERNET</main></body>'
            );
            return 200;
          },
          authenticate: () => null,
          onStage: (stage) => stages.push(stage),
          timeoutMs: 1000
        }
      )
    ).rejects.toThrow();
    expect(attempts).toBe(2);
    expect(stages).not.toContain('capture');
    expect(stages).not.toContain('confirm-change');
  } finally {
    await browser.close();
  }
});
