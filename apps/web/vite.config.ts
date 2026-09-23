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
    // A route's chunk holds what only that route uses. A module of a workspace
    // package reaches the first paint through the package's index all the
    // same, unless the package declares which of its modules have side
    // effects, as `@hercule/contract`, `@hercule/client-core` and
    // `@hercule/ui` do. The budget check measures the first paint on each
    // build: scripts/check-bundle-budget.ts.
    build: {
      rolldownOptions: {
        output: {
          // The workflow editor loads its libraries with the two pages that
          // edit a workflow. Together they pass the size at which a build
          // warns about a chunk. So the text editor's library, the largest,
          // gets a chunk of its own, and the warning keeps its limit for
          // every chunk. The graph's library stays with the page, because it
          // shares React with the first paint: a group of its own would take
          // React with it, and the first paint would load the graph.
          codeSplitting: {
            groups: [
              {
                name: "workflow-text-editor",
                test: /[\\/]node_modules[\\/](@codemirror|@lezer)[\\/]/,
              },
            ],
          },
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
