import { defineConfig } from "vitest/config";

/**
 * Three projects: the two React packages, everything else, and the one suite
 * that runs the release binary.
 *
 * The first two run on different runtimes, which is why `pnpm test` invokes
 * vitest twice. The `node` project needs Bun: it reaches `bun:sqlite`,
 * `Bun.password` and `Bun.file`. The `react` project must not have it: Bun's
 * `Response` hands back an `ArrayBuffer` from its own realm while jsdom
 * installs another, so a stubbed response decodes as the wrong type. Browser
 * code belongs on Node with jsdom anyway.
 *
 * The `binary` project is out of both, and out of `pnpm test`. It runs `./hydra`
 * as a release does, so it needs a build that has already happened - and a
 * build rewrites `apps/web/dist` and the generated file list underneath any
 * controller a parallel suite is running from source. `pnpm test:binary` runs
 * it, after `pnpm build:binary`.
 */
const reactPackages = ["apps/web", "packages/ui"];

const binaryTests = ["e2e/web.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.{ts,tsx}"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            ...reactPackages.map((p) => `${p}/**`),
            ...binaryTests,
          ],
        },
      },
      {
        test: {
          name: "react",
          environment: "jsdom",
          // Stylesheets are processed rather than stubbed, so a test can read
          // the one this workspace ships as its source.
          css: true,
          // Testing Library registers its auto-cleanup only when a global
          // `afterEach` exists, so without this a second render in one file
          // sees the first one still mounted.
          globals: true,
          setupFiles: ["packages/ui/src/test-setup.ts"],
          include: reactPackages.map((p) => `${p}/src/**/*.test.{ts,tsx}`),
        },
      },
      {
        test: {
          name: "binary",
          environment: "node",
          include: binaryTests,
        },
      },
    ],
  },
});
