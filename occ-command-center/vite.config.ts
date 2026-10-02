import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// **开发代理不是可选项。** 后端一条 CORS 头都不加（"前端必须和 `/api` 同源"），
// 所以浏览器里 `VITE_GATEWAY_URL` 指绝对地址会被同源策略挡掉——只有把 `/api`
// 代理过来这一条路。要连别处就设 `VITE_GATEWAY_DEV_URL`。
//
// 默认端口是**新后端**的（`src/app/settings.py` 里 `port = 8765`）：
// 起法 `OCC_NEXT_ROOT=demo uv run python -m src.serve`。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_GATEWAY_DEV_URL ?? 'http://127.0.0.1:8765',
        changeOrigin: false,
      },
    },
  },
})
