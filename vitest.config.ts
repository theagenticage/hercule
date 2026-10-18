import { globSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Seven projects: the React code of the web app and the UI library, everything
 * else (split in two, see `isolatedTests` below), the desktop app's two
 * halves, the suite that runs the release binary,
 * and the suite that runs the packaged desktop app. A few tests run in both
 * `react` and `node`; see `bothEngineTests` below.
 *
 * The projects run on different runtimes, which is why `pnpm test` invokes
 * vitest twice. The `node` project needs Bun: it reaches `bun:sqlite`,
 * `Bun.password` and `Bun.file`. The `react` project must not have it: Bun's
 * `Response` hands back an `ArrayBuffer` from its own realm while jsdom
 * installs another, so a stubbed response decodes as the wrong type. Browser
 * code belongs on Node with jsdom anyway.
 *
 * The desktop app runs on no Bun at all. `desktop-main` holds every desktop
 * test outside the renderer: main runs in Electron's main process, which is
 * Node, and the IPC contract and the build scripts run there or under plain
 * Node too. `desktop-renderer` is the renderer's page on jsdom, compiled by the
 * React Compiler as the build compiles it; its config is
 * `apps/desktop/vitest.renderer.config.ts`. Both run in the
 * Node half of `pnpm test`.
 *
 * The `binary` project is out of both, and out of `pnpm test`: `pnpm test:binary`
 * runs it, after `pnpm build:binary`. It is kept apart because a build rewrites
 * `apps/web/dist` and the generated file list underneath any controller a
 * parallel suite is running from source. Most of its suites test the packaging
 * itself and fail with a clear error when `./hercule` is missing; the five that test the
 * controller's own surface rather than the packaging - `e2e/workspace.test.ts`,
 * `e2e/workspace-steps.test.ts`, `e2e/github-push.test.ts`, `e2e/workflows.test.ts`
 * and the cases of `e2e/text-generation-step.test.ts` that call no model - are the
 * same program either way, so with no build they run the dispatcher's source
 * instead (`findReleaseBinary` in `e2e/harness.ts`).
 *
 * The `desktop` project is out of `pnpm test` too: `pnpm test:desktop` runs it,
 * after `pnpm build:desktop` and `pnpm build:binary`. It drives the packaged
 * app with Playwright, which runs on Node, against a controller started from
 * the compiled binary.
 */

/** The source folders whose tests run in the `react` project, on jsdom. */
const reactSources = ["apps/web/src", "packages/ui/src"];

/** The desktop app's page, whose tests run in the `desktop-renderer` project. */
const desktopRenderer = "apps/desktop/src/renderer";

/** The settings of the `react` project, which renders React on jsdom. */
const reactOnJsdom = {
  environment: "jsdom",
  // Stylesheets are processed rather than stubbed, so a test can read the
  // one its workspace ships as its source.
  css: true,
  // Testing Library registers its auto-cleanup only when a global `afterEach`
  // exists, so without this a second render in one file sees the first one
  // still mounted.
  globals: true,
} as const;

/**
 * Tests that run in both the `react` and the `node` project, so that both
 * JavaScript engines run them: V8 under Node and JavaScriptCore under Bun.
 *
 * The workflow parser in the contract runs in the controller (Bun) and in the
 * browser (V8 in Chrome, JavaScriptCore in Safari). The engines have different
 * limits, such as the maximum number of arguments to one function call, and a
 * long workflow source can hit them. Completion and the graph code only read
 * the parse result and hit no such limit, so their tests run on one engine.
 *
 * The skill folder reader runs in desktop main (Node) and in the CLI (Bun),
 * whose file system modules differ in details such as the errors a symbolic
 * link gives, so its tests run on both too.
 */
const bothEngineTests = [
  "packages/contract/src/groups/workflow-source.test.ts",
  "packages/client-core/src/workflow-source.test.ts",
  "packages/client-core/src/skill-folder.test.ts",
];

const binaryTests = [
  "e2e/web.test.ts",
  "e2e/cli.test.ts",
  "e2e/live.test.ts",
  "e2e/runner.test.ts",
  "e2e/session.test.ts",
  "e2e/session-tool.test.ts",
  "e2e/agent-session.test.ts",
  "e2e/edits-by-commands.test.ts",
  "e2e/subscription-wake.test.ts",
  "e2e/workspace.test.ts",
  "e2e/workspace-steps.test.ts",
  "e2e/github-push.test.ts",
  "e2e/workflows.test.ts",
  "e2e/text-generation-step.test.ts",
  "e2e/binary-size.test.ts",
  "e2e/logs.test.ts",
  "e2e/home-in-session.test.ts",
  "e2e/promote.test.ts",
  "e2e/skills.test.ts",
  // upgrade.test.ts downloads the matching edge asset for this platform
  // (linux-x64, linux-arm64, or darwin-arm64) and runs it. Other platforms
  // fail in CI and skip locally.
  "e2e/upgrade.test.ts",
];

/** The test files that neither the `node` nor the `node-isolated` project runs. */
const nodeExclude = [
  "**/node_modules/**",
  "**/dist/**",
  // Agent worktrees are whole copies of this repository.
  "**/.claude/**",
  ...reactSources.map((folder) => `${folder}/**`),
  ...binaryTests,
  "apps/desktop/**",
  "e2e/desktop/**",
];

/**
 * Finds the test files that replace a module (`vi.mock`, `vi.doMock`) or a
 * global (`vi.stubGlobal`, `vi.spyOn(globalThis, ...)`). Returns their paths
 * relative to the repository root.
 *
 * The `node` project shares one module cache across the files a worker runs
 * (`isolate: false`): loading Effect and the controller once per worker rather
 * than once per file makes the project about a third faster. A replaced module
 * would then stay replaced, or stay real, for whichever file runs next. A
 * replaced global can be missed altogether: Effect's fetch client keeps the
 * first `fetch` it reads, which in a shared cache may be another file's. So
 * these files run in `node-isolated`, which gives each file its own module
 * cache. They are found by reading the files, so a new one cannot land in the
 * shared cache by mistake.
 */
const findTestsThatReplaceModulesOrGlobals = (): Array<string> =>
  globSync("**/*.test.{ts,tsx}", {
    // Depending on the Node version, this receives a path or a directory entry.
    exclude: (entry: string | { name: string }) =>
      /(^|\/)(node_modules|\.claude|\.git|dist|out)$/.test(
        typeof entry === "string" ? entry : entry.name,
      ),
  }).filter((file) =>
    /\bvi\.(mock|doMock|stubGlobal)\(|\bspyOn\(globalThis\b/.test(readFileSync(file, "utf8")),
  );

const isolatedTests = findTestsThatReplaceModulesOrGlobals();

/**
 * How long a test or a hook may run before vitest stops it. This catches a
 * hang. It is not a speed check: many tests start real `git` processes or a
 * real controller, and on a machine with every core busy (a full test run, or
 * several agents at once) the same test takes several times longer. A limit
 * near the usual duration then fails a test that is correct, only slow. A test
 * that must check speed counts the work it does instead of timing it.
 */
const HANG_LIMIT_MS = 60_000;

/** Migrates the database every controller test copies, once per test run. */
const templateDatabaseSetup = "apps/controller/src/db/template.global-setup.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          testTimeout: HANG_LIMIT_MS,
          hookTimeout: HANG_LIMIT_MS,
          isolate: false,
          globalSetup: [templateDatabaseSetup],
          include: ["**/*.test.{ts,tsx}"],
          exclude: [...nodeExclude, ...isolatedTests],
        },
      },
      {
        test: {
          name: "node-isolated",
          environment: "node",
          testTimeout: HANG_LIMIT_MS,
          hookTimeout: HANG_LIMIT_MS,
          globalSetup: [templateDatabaseSetup],
          include: isolatedTests,
          exclude: nodeExclude,
        },
      },
      {
        test: {
          name: "react",
          ...reactOnJsdom,
          testTimeout: HANG_LIMIT_MS,
          hookTimeout: HANG_LIMIT_MS,
          setupFiles: ["packages/ui/src/test-setup.ts"],
          include: [
            ...reactSources.map((folder) => `${folder}/**/*.test.{ts,tsx}`),
            ...bothEngineTests,
          ],
        },
      },
      {
        test: {
          name: "desktop-main",
          environment: "node",
          testTimeout: HANG_LIMIT_MS,
          hookTimeout: HANG_LIMIT_MS,
          // A tested module must not import `electron`: under plain Node the
          // package's main export is the path to the Electron binary, so
          // `import { app } from "electron"` is undefined. Keep the logic
          // worth testing in modules that take what they need as arguments.
          include: ["apps/desktop/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            `${desktopRenderer}/**`,
            "apps/desktop/out/**",
            "apps/desktop/dist/**",
          ],
        },
      },
      // Its config sits in the desktop app, which has the React Compiler's plugins.
      "apps/desktop/vitest.renderer.config.ts",
      {
        test: {
          name: "binary",
          environment: "node",
          include: binaryTests,
        },
      },
      {
        test: {
          name: "desktop",
          environment: "node",
          include: ["e2e/desktop/**/*.test.ts"],
          // Each test starts the packaged app, which takes seconds.
          testTimeout: HANG_LIMIT_MS,
          hookTimeout: HANG_LIMIT_MS,
          // A poll waits for the app to act on something, such as showing
          // its window. On a slow CI runner, with two apps starting at once,
          // that can take longer than the default of 1 s.
          expect: { poll: { timeout: 5_000 } },
        },
      },
    ],
  },
});
