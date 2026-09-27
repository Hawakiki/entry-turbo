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
)
