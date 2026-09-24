import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

/**
 * Vite decides whether a build is a production build from `NODE_ENV`, not from
 * the build mode, and React picks its production or development build from the
 * same variable. So in a shell where `NODE_ENV` is anything but "production" -
 * a test runner sets "test" - the bundle includes React's development runtime:
 * development warnings, the slow reconciler, and 64 kB gzipped on the first
 * paint. A build of this app is always a production build, so this config sets
 * `NODE_ENV` for every build instead of relying on each caller. The dev server
 * is not affected.
 */
export default defineConfig(({ command }) => {
  if (command === "build") process.env.NODE_ENV = "production";

  return {
    plugins: [
      // The router plugin rewrites route files, so it runs before React's.
      // `autoCodeSplitting` puts every route's component in its own chunk: the
      // generated tree keeps only the route definitions, and the component is
      // fetched when the route is first visited.
      // Tests sit beside the route files they test, and the plugin would
      // otherwise report a file with no `Route` export as an unreadable route.
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routeFileIgnorePattern: "\\.test\\.tsx?$",
      }),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
    ],
    // Each route gets a chunk with the code that only that route uses. A
    // workspace package can still pull all its modules into the initial bundle
    // through its index, unless its package.json declares `sideEffects`, as
    // `@hercule/contract`, `@hercule/client-core` and `@hercule/ui` do.
    // scripts/check-bundle-budget.ts checks the initial bundle size on every
    // build.
    build: {
      rolldownOptions: {
        output: {
          // The two pages that edit a workflow load the text editor library
          // (CodeMirror) and the graph library. Together they are bigger than
          // the chunk size at which the build warns. So CodeMirror, the larger
          // one, gets its own chunk, and the warning limit stays the same for
          // every chunk. The graph library stays in the page chunk: a separate
          // chunk for it would also take in React, which the initial bundle
          // needs, so every page would then load the graph library.
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
    // In development, Vite serves the app and a controller the developer
    // started serves the API. `/api` is proxied to the default `hercule serve`
    // port, so the app talks to one origin, as it does in production. The live
    // connection uses the same origin in production, so `/ws` is proxied too;
    // without it no screen would update live in development.
    server: {
      proxy: {
        "/api": "http://127.0.0.1:4937",
        "/ws": { target: "ws://127.0.0.1:4937", ws: true },
      },
    },
  };
});
