import { describe, it } from 'vitest';

import { scraperSecurityScenarios } from '../helpers/scraperSecurityScenarios.js';

describe('scraper security integration', () => {
  for (const scenario of scraperSecurityScenarios) {
    it(scenario.name, () => scenario.run(), 60_000);
  }
});
