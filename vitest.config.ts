import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50
      },
      exclude: [
        'dist/**',
        'tests/**',
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
