import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const HQ = process.env.HQ_ORIGIN ?? "http://127.0.0.1:4800";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": HQ,
      "/ws": { target: HQ.replace("http", "ws"), ws: true },
    },
  },
});
