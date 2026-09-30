import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // theme.css names the SN Pro arrows file once per weight; inlined, that
    // is ten base64 copies. Emit it as one file instead.
    assetsInlineLimit: (file) => (file.endsWith("sn-pro-arrows.woff2") ? false : undefined),
  },
});
