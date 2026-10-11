import { defineProject } from "vitest/config";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

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
    setupFiles: ["src/renderer/test-setup.ts"],
    include: ["src/renderer/**/*.test.{ts,tsx}"],
  },
});
