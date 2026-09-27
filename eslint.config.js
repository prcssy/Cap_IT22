import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // Cloud Functions are CommonJS Node code (require/exports), not browser
  // modules — same as the root *.cjs scripts, which ESLint already treats
  // as CommonJS by extension.
  {
    files: ['functions/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
])
