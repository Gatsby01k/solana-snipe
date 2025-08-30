import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Если публикуешь на GitHub Pages, раскомментируй base и укажи имя репо:
// const base = '/creator-snipe-ultimate/'

export default defineConfig({
  plugins: [react()],
  // base,
  server: { port: 5173, host: true }
})
