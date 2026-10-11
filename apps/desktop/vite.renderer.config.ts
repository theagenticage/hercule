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
        // Puts a route's loader in the chunk of its component. By default the
        // loader stays in the route's own file, which loads with the first
        // screen, together with every module the loader imports, even when
        // the route never opens. A route the app starts on opts out with
        // `codeSplitGroupings: []`.
        codeSplittingOptions: {
          defaultBehavior: [["loader", "component"], ["errorComponent"], ["notFoundComponent"]],
        },
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
      // Vite warns about any chunk over 500 kB before gzip. Two chunks are
      // over that on purpose:
      // - the first-screen chunk (see `rolldownOptions` below), 748 kB, whose
      //   real limit is the first-paint budget of 250 kB gzipped, which
      //   scripts/check-bundle-budget.ts checks;
      // - the Office's chunk, 805 kB, three.js and the Office together, which
      //   loads only when the Office opens. Its real limit is spec 17's
      //   limit for the Office's chunk, gzipped.
      // This limit sits just above the larger of the two, so the warning
      // still fires if either grows a lot.
      chunkSizeWarningLimit: 850,
      rolldownOptions: {
        output: {
          // Puts every module the entry imports statically, directly or not,
          // into one chunk, the first-screen chunk. A screen or dialog the
          // app imports with `import()` stays in a chunk of its own, loaded
          // the first time it shows.
          //
          // Without this group, the bundler gives each set of modules that
          // the entry and the lazy chunks share a chunk of its own. The first
          // screen then loads many files, and that costs bytes twice: each
          // file is compressed apart, and the files import and export names
          // from each other, which the minifier cannot shorten across a file
          // boundary. Measured on the first screen as it stood before this
          // group, one chunk was 7.4 kB smaller gzipped (spec 17,
          // §Measured). The app is read from the local disk, so splitting
          // buys no caching in return.
          codeSplitting: { groups: [{ name: "first-screen", tags: ["$initial"] }] },
        },
      },
      // Writes `.vite/manifest.json`, which maps each chunk to the source file
      // it came from. scripts/check-bundle-budget.ts reads it to find the
      // chunks of the routes the first screen renders, so that splitting one
      // of those routes cannot move bytes out of the budget.
      manifest: true,
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
