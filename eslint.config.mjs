import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/out/**',
      '**/target/**',
      '**/tmp/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    ignores: [
      'apps/api/src/app.module.ts',
      'apps/api/src/simulator/**',
      'apps/api/src/sandbox/**',
      'apps/api/src/**/*.test.ts',
      'apps/worker/src/main.ts',
      'apps/worker/src/simulator/**',
      'apps/worker/src/sandbox/**',
      'apps/worker/src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/simulator/**', '**/sandbox/**'],
              message:
                'Production modules must depend on ports, never simulator or sandbox implementations.',
            },
          ],
        },
      ],
    },
  },
);
