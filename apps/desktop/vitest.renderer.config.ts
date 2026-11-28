import { defineProject } from "vitest/config";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

/**
 * How long a test or a hook may run before vitest stops it. The same limit as
 * the other projects in the root `vitest.config.ts`, which explains it: it
 * catches a hang and is not a speed check. The renderer's tests render the
 * whole app, so on a busy machine one takes several times longer than usual,
 * and vitest's default of 5 seconds fails it though it is correct.
 */
const HANG_LIMIT_MS = 60_000;

/**
 * The `desktop-renderer` project of the root `vitest.config.ts`: the
 * renderer's tests on jsdom. It lives here, not in the root file, because
 * its plugins are the desktop app's own dependencies.
 *
 * The tests run the React Compiler, with the same plugins as
 * `vite.renderer.config.ts`, so a component is tested as the build ships
 * it. A value the compiler caches by mistake, such as one computed from the
 * time without the time being an input, then fails a test instead of only
 * the built app.
 */
export default defineProject({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  test: {
    name: "desktop-renderer",
    environment: "jsdom",
    // Stylesheets are processed rather than stubbed, so a test can read the
    // one its workspace ships as its source.
    css: true,
    // Testing Library registers its auto-cleanup only when a global
    // `afterEach` exists, so without this a second render in one file sees
    // the first one still mounted.
    globals: true,
    testTimeout: HANG_LIMIT_MS,
    hookTimeout: HANG_LIMIT_MS,
    setupFiles: ["src/renderer/test-setup.ts"],
    include: ["src/renderer/**/*.test.{ts,tsx}"],
  },
});
