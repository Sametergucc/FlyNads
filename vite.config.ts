import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const serverPort = Number(env.FLYORDIE_SERVER_PORT ?? 8788);
  const devPort = Number(env.VITE_PORT ?? 5174);

  return {
    plugins: [react()],
    server: {
      port: devPort,
      proxy: { "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true } },
    },
  };
});
