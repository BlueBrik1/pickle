import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'dist-server/**', 'dist-ext/**', 'fixtures/**', 'demo/**', '.demo/**', '.demo-test/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // VS Code loads the integration-test runner as CommonJS.
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
