import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Generated shadcn/ui files export helpers (e.g. buttonVariants) next to
      // components; same allowance as the dashboard frontend.
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    // Generated shadcn/ui primitives (byte-identical to the dashboard) export
    // variant helpers alongside components, like the dashboard's own exemptions.
    files: ['src/components/ui/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
