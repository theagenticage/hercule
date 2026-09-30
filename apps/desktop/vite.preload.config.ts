import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Builds the preload: the script Electron runs in the window before the page,
 * to expose the bridge. The output is one CommonJS file,
 * `out/preload/index.cjs`, because Electron runs a sandboxed window's preload
 * as a classic script with a small `require`, not as an ES module.
 *
 * The preload may import only `electron`, which stays external, and types.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    // Built like main, as an SSR build: Vite's other builds expect either a
    // page with an `index.html` or a library.
    ssr: "src/preload/index.ts",
    outDir: "out/preload",
    emptyOutDir: true,
    // The Chromium version inside Electron 44. The preload runs in the
    // sandboxed window, which has no Node, so it targets the browser.
    target: "chrome152",
    // Minified like main; `scripts/dev.ts` adds a source map in development.
    minify: true,
    rolldownOptions: {
      output: { format: "cjs", entryFileNames: "index.cjs" },
    },
  },
  ssr: {
    noExternal: true,
    external: ["electron"],
  },
});
