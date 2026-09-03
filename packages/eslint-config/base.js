import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import onlyWarn from 'eslint-plugin-only-warn';
import turboPlugin from 'eslint-plugin-turbo';
import tseslint from 'typescript-eslint';

/**
 * Re-apply after any extra `...tseslint.configs.recommended` so underscore-prefixed
 * identifiers stay ignored (next.js / react-internal repeat the recommended preset).
 *
 * @type {import("eslint").Linter.RulesRecord}
 */
export const typescriptNoUnusedVarsAllowLeadingUnderscore = {
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
    },
  ],
};

/**
 * Keep translation lookups statically analyzable so extraction and linting tools
 * can detect missing keys across the monorepo.
 *
 * @type {import("eslint").Linter.RulesRecord}
 */
export const i18nDirectLiteralKeyRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector:
        "CallExpression[callee.name='t'][arguments.length>0]:not([arguments.0.type='Literal']):not([arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0]):not([arguments.0.type='ConditionalExpression'][arguments.0.consequent.type='Literal'][arguments.0.alternate.type='Literal'])",
      message:
        'Use a direct literal translation key in t(...). Avoid key indirection via variables, object access, or function calls.',
    },
    {
      selector:
        "CallExpression[callee.property.name='t'][arguments.length>0]:not([arguments.0.type='Literal']):not([arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0]):not([arguments.0.type='ConditionalExpression'][arguments.0.consequent.type='Literal'][arguments.0.alternate.type='Literal'])",
      message:
        'Use a direct literal translation key in t(...). Avoid key indirection via variables, object access, or function calls.',
    },
  ],
};

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      'turbo/no-undeclared-env-vars': 'warn',
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    rules: {
      // Leading underscore = intentionally unused (placeholder params, future hooks, catch (_e)).
      ...typescriptNoUnusedVarsAllowLeadingUnderscore,
    },
  },
  {
    ignores: [
      'dist/**',
      '.next/**',
      // Dist dir of a second local dev server on the same working tree
      // (NEXT_DIST_DIR) — generated output, same reason as `.next`.
      '.next-review/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.wrangler/**',
      '**/.open-next/**',
      '**/storybook-static/**',
      // Vendored, dynamically-downloaded dev-browser artifacts (side-loaded
      // react-devtools extension + persistent profile for `bun run dev:browser`);
      // gitignored, not our source — never lint them (parity with node_modules).
      '**/.dev-browser-extensions/**',
      '**/.dev-browser-profile/**',
    ],
  },
  {
    settings: {
      // Fix for ESLint 10+: eslint-plugin-react uses context.getFilename() (legacy API)
      // which was removed in ESLint 10 flat config. Declaring the version explicitly
      // prevents the plugin from trying to auto-detect it and failing.
      react: { version: '19' },
    },
  },
];
