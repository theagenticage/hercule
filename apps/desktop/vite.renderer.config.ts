import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

/**
 * Builds the renderer: the React app the window shows. The output goes to
 * `out/renderer`, which main serves on the `app://hercule/` origin.
 *
 * A build always sets `NODE_ENV` to "production", for the reason given in
 * `apps/web/vite.config.ts`: Vite and React both pick their production build
 * from that variable, and a test runner sets it to "test". The dev server is
 * not affected.
 */
export default defineConfig(({ command }) => {
  if (command === "build") process.env.NODE_ENV = "production";

  return {
    root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
    plugins: [
      // The same plugins as the web app, in the same order, for the reasons
      // given in `apps/web/vite.config.ts`. The router plugin's paths are
      // relative to `root` above.
      tanstackRouter({
        target: "react",
        routesDirectory: "routes",
        generatedRouteTree: "routeTree.gen.ts",
        autoCodeSplitting: true,
        routeFileIgnorePattern: "\\.test\\.tsx?$",
      }),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
    ],
    build: {
      // The Chromium version inside Electron 44. The app only ever runs in
      // that browser, so no newer syntax needs rewriting for older ones.
      target: "chrome152",
      // Chromium has supported `<link rel="modulepreload">` since version 66,
      // so Vite's polyfill for older browsers would never run.
      modulePreload: { polyfill: false },
      // Vite warns about any chunk over 500 kB before gzip. The entry chunk is
      // over that on purpose: it holds the launch screens, so the first screen
      // needs no second file. The real limit is the first-paint budget of
      // 250 kB gzipped, which scripts/check-bundle-budget.ts enforces. This
      // limit sits just above the entry chunk's current size (520 kB), so the
      // warning still fires if a chunk grows a lot.
      chunkSizeWarningLimit: 600,
      outDir: fileURLToPath(new URL("./out/renderer", import.meta.url)),
      // The output folder is outside `root`, so Vite empties it only when asked.
      emptyOutDir: true,
    },
    // The dev script (`scripts/dev.ts`) picks the port and passes it in, for
    // both the server and its WebSocket. The page runs at `app://hercule/`,
    // not at the dev server's own address, so the HMR client cannot work out
    // where the WebSocket is from the page's URL: it is told the host and port
    // explicitly instead.
    server: {
      host: "127.0.0.1",
      strictPort: true,
      ws: { host: "127.0.0.1" },
    },
  };
});
