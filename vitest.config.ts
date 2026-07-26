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
        lines: 79,
        functions: 80,
        branches: 69,
        statements: 77
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
