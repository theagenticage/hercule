import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

/**
 * Vite decides whether a build is a production build from `NODE_ENV`, not from
 * the build mode, and React ships two builds behind an export condition keyed
 * on the same variable. A shell where `NODE_ENV` is anything but "production" -
 * a test runner sets "test" - therefore emits a bundle carrying React's
 * development runtime: development warnings, the slow reconciler, and 64 kB
 * gzipped of it on the first paint. Building this app is always building it
 * for production, so the answer is settled here rather than at every call
 * site; the dev server is left as it was.
 */
export default defineConfig(({ command }) => {
  if (command === "build") process.env.NODE_ENV = "production";

  return {
    plugins: [
      // The router plugin rewrites route files, so it runs before React's.
      // `autoCodeSplitting` is what puts every route's component in a chunk of
      // its own: the generated tree keeps only the route definitions, and the
      // component is fetched when the route is first visited.
      // Tests sit beside the route files they drive, and a file with no `Route`
      // export is otherwise reported as a route that could not be read.
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routeFileIgnorePattern: "\\.test\\.tsx?$",
      }),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
    ],
    build: {
      rolldownOptions: {
        treeshake: {
          // `yaml` declares no `sideEffects` in its package, so a bundler keeps
          // each of its module-level statements, and what they reference, in
          // every chunk that imports it. `@hercule/contract` imports it for the
          // one parse of a workflow's source, and the first paint imports the
          // contract. The package defines symbols, classes and constants and
          // changes nothing outside itself, so it is declared free of side
          // effects here, and the parse reaches only the chunks that call it.
          moduleSideEffects: [{ test: /[\\/]node_modules[\\/]yaml[\\/]/, sideEffects: false }],
        },
      },
    },
    // In development the app is served by Vite and the API by a controller the
    // developer started themselves, so `/api` is proxied to the port `hercule
    // serve` binds by default and the app talks to one origin here as it does in
    // production. The live connection is on the same authority in production, so
    // it is proxied too: without it nothing on a screen ever updates in dev.
    server: {
      proxy: {
        "/api": "http://127.0.0.1:4937",
        "/ws": { target: "ws://127.0.0.1:4937", ws: true },
      },
    },
  };
});
