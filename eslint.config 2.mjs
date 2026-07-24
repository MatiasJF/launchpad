import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.db', 'docs/artifacts/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
];
