import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**', '.trunk/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 81,
        functions: 81,
        branches: 81,
        statements: 81
      },
      exclude: [
        'dist/**',
        'tests/**',
        '.trunk/**',
        'playwright.config.ts',
        'eslint.config.js',
        'vitest.config.ts',
        'src/index.ts',
        'src/cli/index.ts',
        'src/core/types.ts',
        'src/scheduler.ts',
        'src/scraper.ts',
        'src/types.ts',
        // barrel re-export shims — zero statements, not meaningful to measure
        'src/config.ts',
        'src/db.ts',
        'src/pageReader.ts',
        'src/reporter.ts'
      ]
    }
  }
});
