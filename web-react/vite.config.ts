import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const backendTarget = process.env.AGENTIC_BACKEND_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Read-only access to backend types so the React app stays type-safe
      // against the same store/contract definitions the server uses.
      "@server": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  server: {
    port: 3001,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
        // SSE on /api/runs/:id/events and /api/tool-services/logs/events.
        // Disable response buffering so events stream to the browser as they arrive.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.headers.accept?.includes("text/event-stream")) {
              proxyReq.setHeader("accept", "text/event-stream");
            }
          });
        },
      },
    },
  },
});
