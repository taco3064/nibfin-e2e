import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'sandbox-template/', '.e2e-work/', 'relay/.wrangler/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
);
