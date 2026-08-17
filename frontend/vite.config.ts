import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Phase 1 接上后端后启用：开发时把 /api 转发给 FastAPI，避免跨域问题
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
