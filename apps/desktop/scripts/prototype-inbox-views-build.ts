/**
 * PROTOTYPE, throwaway. Builds the Inbox views prototype into static files,
 * in `out/prototype-inbox-views/`, so it can be shared on the tailnet
 * without a dev server:
 *
 *     node scripts/prototype-inbox-views-build.ts
 *     tailscale serve --bg --https=8443 <absolute path>/out/prototype-inbox-views
 *
 * The dev server sends hundreds of separate modules, and through Tailscale's
 * proxy many of them failed with 502; a build sends a handful of files.
 */
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const root = `${packageDir}/src/renderer`;

// Not the renderer's config file: its chunk group for the app's first screen
// swallows this page's entry, and the built page then runs nothing.
await build({
  configFile: false,
  root,
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  base: "./",
  logLevel: "warn",
  build: {
    target: "es2022",
    outDir: `${packageDir}/out/prototype-inbox-views`,
    emptyOutDir: true,
    rolldownOptions: { input: { inbox: `${root}/specimens/prototype-inbox-views/index.html` } },
  },
});
process.stdout.write(`Built into ${packageDir}out/prototype-inbox-views\n`);
