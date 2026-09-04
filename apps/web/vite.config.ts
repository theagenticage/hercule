import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  // In development the app is served by Vite and the API by a controller the
  // developer started themselves, so `/api` is proxied to the port `hydra
  // serve` binds by default and the app talks to one origin here as it does in
  // production.
  server: {
    proxy: { "/api": "http://127.0.0.1:4937" },
  },
});
