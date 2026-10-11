import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite 配置。
 *
 * 前端根目录为 src/（沿用原有 src/index.html 与资源布局），构建产物输出到 ../dist，
 * 由 src-tauri/tauri.conf.json 的 frontendDist 指回。Tauri 要求开发服务器使用固定端口。
 */
export default defineConfig({
  root: "src",
  // 相对 root 解析：src/public 下的文件按根路径提供（如 /vendor/xterm.js、/locales/en-US.json）
  publicDir: "public",
  plugins: [react()],
  // 让 Tauri CLI 自己管理清屏，避免覆盖其日志
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri 在移动端调试时会给出 TAURI_DEV_HOST
    host: process.env.TAURI_DEV_HOST || false,
    hmr: process.env.TAURI_DEV_HOST
      ? { protocol: "ws", host: process.env.TAURI_DEV_HOST, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2020",
  },
  envPrefix: ["VITE_", "TAURI_"],
});
