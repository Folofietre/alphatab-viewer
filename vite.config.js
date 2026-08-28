import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { alphaTab } from '@coderline/alphatab-vite'

export default defineConfig({
  // GitHub Pages project site: served from https://<user>.github.io/alphatab-viewer/
  // Everything that resolves an asset path (the Bravura font directory, the
  // SoundFont, and the alphaTab worker/worklet chunks) goes through
  // import.meta.env.BASE_URL, so this is the single knob. Must match the repo
  // name. Use '/' if you ever serve it from a domain root instead.
  base: '/alphatab-viewer/',
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
