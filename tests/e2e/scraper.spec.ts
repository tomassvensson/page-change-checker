import { test } from '@playwright/test';

import { scraperSecurityScenarios } from '../helpers/scraperSecurityScenarios.js';

for (const scenario of scraperSecurityScenarios) {
  test(scenario.name, () => scenario.run());
}
