import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": api, "/pay": api, "/health": api },
  },
});
