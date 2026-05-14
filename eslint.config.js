import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'node_modules/**',
      'eslint.config.js',
      'vitest.config.ts',
      'playwright.config.ts'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      'import-x': importX
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'import-x/order': [
        'error',
        {
          'newlines-between': 'always',
          alphabetize: { order: 'asc' }
        }
      ]
    }
  }
);
