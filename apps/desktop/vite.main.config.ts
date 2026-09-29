import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Builds main: the program Electron runs in its browser process. The output is
 * one ES module, `out/main/index.js`, which `main` in package.json points at.
 *
 * Everything main imports is bundled into that file, including the workspace
 * packages, which export TypeScript source. Only `electron`, which Electron
 * provides at run time, and Node's built-in modules stay external. That is why
 * the packaged app ships no `node_modules`.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    // An SSR build is Vite's build for a Node program: it resolves packages
    // with Node's export conditions and leaves Node's built-in modules external.
    ssr: "src/main/index.ts",
    outDir: "out/main",
    emptyOutDir: true,
    // The Node version inside Electron 44.
    target: "node24",
    // Minified, because Electron reads and compiles all of main before the app
    // is ready, and the Effect code main bundles is large. No source map is
    // written: the packaged app cannot use one, because Node applies a source
    // map only to code loaded after source maps are switched on, and the fuses
    // block the command-line flag that would switch them on first.
    // `scripts/dev.ts` writes one for development, where it can switch them
    // on.
    minify: true,
  },
  ssr: {
    // An SSR build leaves every dependency external by default; this bundles
    // them all. A name listed in `external` stays external all the same.
    noExternal: true,
    external: ["electron"],
  },
});
