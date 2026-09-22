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
 * The `binary` project is out of both, and out of `pnpm test`: `pnpm test:binary`
 * runs it, after `pnpm build:binary`. It is kept apart because a build rewrites
 * `apps/web/dist` and the generated file list underneath any controller a
 * parallel suite is running from source. Most of its suites test the packaging
 * itself and refuse to start without `./hercule`, saying so; the two that test the
 * controller's own surface rather than the packaging - `e2e/workspace.test.ts`
 * and `e2e/github-push.test.ts` - are the same program either way, so with no
 * build they run the dispatcher's source instead (`releaseBinary` in
 * `e2e/harness.ts`).
 */
const reactPackages = ["apps/web", "packages/ui"];

const binaryTests = [
  "e2e/web.test.ts",
  "e2e/cli.test.ts",
  "e2e/live.test.ts",
  "e2e/runner.test.ts",
  "e2e/session.test.ts",
  "e2e/session-tool.test.ts",
  "e2e/agent-session.test.ts",
  "e2e/subscription-wake.test.ts",
  "e2e/workspace.test.ts",
  "e2e/github-push.test.ts",
  "e2e/binary-size.test.ts",
];

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
            // Agent worktrees are whole copies of this repository.
            "**/.claude/**",
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
