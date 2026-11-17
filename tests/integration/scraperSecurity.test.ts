import { describe, expect, it } from 'vitest';

import { scraperSecurityScenarios } from '../helpers/scraperSecurityScenarios.js';

describe('scraper security integration', () => {
  for (const scenario of scraperSecurityScenarios) {
    it(
      scenario.name,
      async () => {
        await expect(scenario.run()).resolves.toBeUndefined();
      },
      120_000
    );
  }
});
