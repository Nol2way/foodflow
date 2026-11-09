import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // ลิงก์สาธารณะชั่วคราว (npm run share → Cloudflare Tunnel) เปิดผ่านโดเมนนี้
    allowedHosts: ['.trycloudflare.com'],
    // เรียก /api โดเมนเดียวกัน แล้วส่งต่อให้ backend ในเครื่อง (ใช้เมื่อ VITE_API_URL ว่าง เช่น ตอน share)
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:8787', changeOrigin: true },
    },
  },
})
