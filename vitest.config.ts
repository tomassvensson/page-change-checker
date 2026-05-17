import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**', '.trunk/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50
      },
      exclude: [
        'dist/**',
        'tests/**',
        '.trunk/**',
        'playwright.config.ts',
        'eslint.config.js',
        'vitest.config.ts',
        'src/index.ts',
        'src/scheduler.ts',
        'src/scraper.ts',
        'src/types.ts'
      ]
    }
  }
});
