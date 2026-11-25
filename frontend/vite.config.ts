import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"

export default defineConfig({
  plugins: [svelte()],
  // mupdf.js 使用顶层 await，Worker 必须是 ES 模块
  build: { target: "esnext", chunkSizeWarningLimit: 2000 },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
  server: { proxy: { "/api": "http://127.0.0.1:34115" } },
})
