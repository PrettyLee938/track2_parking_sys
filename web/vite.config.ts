import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the dashboard runs on Vite's port and proxies API calls to the server.
const server = process.env.GPA_API_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": server, "/debug": server },
  },
});
