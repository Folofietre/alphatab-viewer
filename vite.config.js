import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { alphaTab } from '@coderline/alphatab-vite'

export default defineConfig({
  // Served from the domain root. Change to '/<repo-name>/' before deploying to
  // a GitHub Pages project site — everything that resolves an asset path goes
  // through import.meta.env.BASE_URL, so this is the single knob.
  base: '/',
  // Stay on Vite 7: Vite 8 (rolldown) breaks @coderline/alphatab-vite@1.8 with
  // a "Missing field moduleType" error.
  plugins: [vue(), alphaTab()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
})
