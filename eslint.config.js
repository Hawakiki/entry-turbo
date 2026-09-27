import antfu from '@antfu/eslint-config'

export default antfu(
  {
    typescript: false,
    // JS is formatted by ESLint Stylistic; CSS/HTML/Markdown go through Prettier via eslint-plugin-format
    formatters: {
      css: true,
      html: true,
      markdown: 'prettier',
    },
  },
  {
    languageOptions: {
      globals: {
        chrome: 'readonly',
      },
    },
  },
  {
    // page scripts run in playentry.org's main world
    files: ['src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        Entry: 'readonly',
        Lang: 'readonly',
        BigNumber: 'readonly',
      },
    },
  },
  {
    // node CLI scripts print their results
    files: ['bench/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
)
