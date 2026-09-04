import { defineConfig } from "vitest/config";

/**
 * The two React packages; everything else is a plain node project.
 *
 * The two projects run on different runtimes, which is why `pnpm test` invokes
 * vitest twice. The `node` project needs Bun: it reaches `bun:sqlite`,
 * `Bun.password` and `Bun.file`, and it compiles the binary. The `react`
 * project must not have it: Bun's `Response` hands back an `ArrayBuffer` from
 * its own realm while jsdom installs another, so a stubbed response decodes as
 * the wrong type. Browser code belongs on Node with jsdom anyway.
 */
const reactPackages = ["apps/web", "packages/ui"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**", ...reactPackages.map((p) => `${p}/**`)],
        },
      },
      {
        test: {
          name: "react",
          environment: "jsdom",
          // Testing Library registers its auto-cleanup only when a global
          // `afterEach` exists, so without this a second render in one file
          // sees the first one still mounted.
          globals: true,
          setupFiles: ["packages/ui/src/test-setup.ts"],
          include: reactPackages.map((p) => `${p}/src/**/*.test.{ts,tsx}`),
        },
      },
    ],
  },
});
