import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'sandbox-template/', '.e2e-work/', 'relay/.wrangler/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: true,
    jsx: false,
    arrowParens: true,
    braceStyle: '1tbs',
    commaDangle: 'always-multiline',
    quoteProps: 'as-needed',
  }),
  {
    // Match the layout the code already has, so ESLint keeps the existing style instead of reformatting it.
    rules: {
      // Double quotes are allowed to avoid escaping, and template literals are never rewritten.
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      // Binary operators end a line; ternary and union/intersection operators start one.
      '@stylistic/operator-linebreak': [
        'error',
        'after',
        { overrides: { '?': 'before', ':': 'before', '|': 'before', '&': 'before' } },
      ],
      // These conflict with closings such as `})),\n  );` and with the indent of binary continuations.
      '@stylistic/list-style': 'off',
      '@stylistic/indent-binary-ops': 'off',
    },
  },
);
