import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// A config of its own rather than a `test` block in vite.config.js: the
// @coderline/alphatab-vite plugin exists to copy the fonts, the soundfont and
// the worker chunks into the browser bundle, and none of that is wanted, or
// works, in a Node test run. Only the `@` alias is shared.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
})
