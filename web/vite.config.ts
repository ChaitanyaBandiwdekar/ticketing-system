import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where `npm run dev:web` proxies API calls (the API from `npm run dev`). */
const API = process.env.FDFS_API ?? "http://localhost:8080";
const API_PATHS = [
  "/auth",
  "/shows",
  "/reservations",
  "/me",
  "/stream",
  "/healthz",
  "/readyz",
  "/metrics",
  "/ops",
];

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // The API owns the spec's root paths (GET /shows/:id...), so the UI lives under /app/.
  base: "/app/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // changeOrigin: a hosted API (FDFS_API=https://...) routes by Host header.
    proxy: Object.fromEntries(API_PATHS.map((p) => [p, { target: API, changeOrigin: true }])),
  },
});
