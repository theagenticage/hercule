import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    // The router plugin rewrites route files, so it runs before React's.
    // `autoCodeSplitting` is what puts every route's component in a chunk of
    // its own: the generated tree keeps only the route definitions, and the
    // component is fetched when the route is first visited.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  // In development the app is served by Vite and the API by a controller the
  // developer started themselves, so `/api` is proxied to the port `hydra
  // serve` binds by default and the app talks to one origin here as it does in
  // production.
  server: {
    proxy: { "/api": "http://127.0.0.1:4937" },
  },
});
