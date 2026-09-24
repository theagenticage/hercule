import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

/**
 * The rule is only useful if the tests prove it fails when it should. Each
 * fixture is a runner entrypoint that imports one forbidden thing with one
 * import form; `clean` is the control.
 */
const FIXTURES = {
  clean: `export function run(argv: readonly string[]): void {
  console.log(argv.join(" "));
}`,
  "db-static": `import { Database } from "bun:sqlite";
export const run = (): void => console.log(Database);`,
  "db-bare": `import "bun:sqlite";
export const run = (): void => console.log("runner");`,
  "db-dynamic": `export async function run(): Promise<void> {
  const { Database } = await import("bun:sqlite");
  console.log(Database);
}`,
  // Mentioning a forbidden module in a comment does not break the rule, and a
  // type-only import is not a runtime edge. Both must pass.
  "type-only": `// The runner must never import "bun:sqlite" or require("bun:sqlite").
import type { Database } from "bun:sqlite";
export const run = (db?: Database): void => console.log(typeof db);`,
  "plugin-host": `import { run as controller } from ${JSON.stringify(join(root, "apps/controller/src/index.ts"))};
export const run = (): void => controller([]);`,
  web: `import { Logo } from ${JSON.stringify(join(root, "packages/ui/src/index.ts"))};
export const run = (): void => console.log(typeof Logo);`,
} as const;

let dir: string;

const roots: Array<string> = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hercule-dep-lint-"));
  await Promise.all(
    Object.entries(FIXTURES).map(([name, body]) => writeFile(join(dir, `${name}.ts`), `${body}\n`)),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const one of roots.splice(0)) await rm(one, { recursive: true, force: true });
});

const runDepLint = (fixture: string, script = join(root, "scripts/dep-lint.ts")) =>
  run("bun", ["run", script, join(dir, `${fixture}.ts`)], { cwd: root });

/** Resolves to the failure dep-lint exited with, or fails the test. */
async function readDepLintFailure(fixture: string): Promise<{ code?: number; stderr?: string }> {
  const error = await runDepLint(fixture).then(
    () => undefined,
    (e: { code?: number; stderr?: string }) => e,
  );
  if (error === undefined) throw new Error(`dep-lint accepted the ${fixture} fixture`);
  return error;
}

describe("dep-lint", () => {
  it("passes an entrypoint that links nothing forbidden", async () => {
    const { stdout } = await runDepLint("clean");
    expect(stdout).toContain("is clean");
  });

  it("passes an entrypoint that only names the DB engine in a comment or a type", async () => {
    const { stdout } = await runDepLint("type-only");
    expect(stdout).toContain("is clean");
  });

  it.each(["db-static", "db-bare", "db-dynamic"])(
    "fails on the DB engine reached by %s",
    async (fixture) => {
      const error = await readDepLintFailure(fixture);
      expect(error.code).toBe(1);
      expect(error.stderr).toContain("the DB engine");
    },
  );

  it("fails on the plugin host", async () => {
    const error = await readDepLintFailure("plugin-host");
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("the plugin host");
  });

  it("fails on the web bundle", async () => {
    const error = await readDepLintFailure("web");
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("the web bundle");
  });
});

/**
 * The vendor SDK's eight per-platform CLI packages (one is 196 MB) are excluded
 * from the install and must stay excluded. This is a workspace rule, not an
 * import-graph rule: pnpm links only direct dependencies, so an optional
 * dependency of the SDK shows up in the store and nowhere else.
 */
/** How pnpm names the vendor SDK's directory in its store. */
const SDK = "@anthropic-ai+claude-agent-sdk";

/**
 * Copies the script into a separate root with the given store packages, and
 * returns the copy's path. The script reads the workspace it is in, so a
 * failing case runs a copy without writing into this repository's own store
 * or source.
 */
const createScriptRoot = async (...packages: ReadonlyArray<string>): Promise<string> => {
  const one = await mkdtemp(join(tmpdir(), "hercule-dep-lint-root-"));
  roots.push(one);
  await mkdir(join(one, "scripts"), { recursive: true });
  await copyFile(join(root, "scripts/dep-lint.ts"), join(one, "scripts/dep-lint.ts"));
  for (const name of packages) {
    await mkdir(join(one, "node_modules/.pnpm", name), { recursive: true });
  }
  return join(one, "scripts/dep-lint.ts");
};

describe("the vendor SDK's per-platform CLI packages", () => {
  it("are not installed, and dep-lint reports that for this repository", async () => {
    const { stdout } = await run("bun", ["run", join(root, "scripts/dep-lint.ts")], { cwd: root });

    expect(stdout).toContain("is clean");
    expect(stdout).toContain("no per-platform CLI package");
  });

  // Without the SDK there are no per-platform packages either, so the platform
  // check alone would pass on an install that never happened.
  it("fail the check when the SDK itself is not installed", async () => {
    const script = await createScriptRoot("effect@4.0.0");

    const refusal = await runDepLint("clean", script).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );

    expect(refusal, "dep-lint accepted a store with no SDK in it").toBeDefined();
    expect(refusal!.stderr).toContain("is not installed");
  });

  it("fail the check when one of them is in the store", async () => {
    const script = await createScriptRoot(`${SDK}@0.3.263`, `${SDK}-darwin-arm64@0.3.263`);

    const refusal = await runDepLint("clean", script).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );

    expect(refusal, "dep-lint accepted a store with a per-platform package in it").toBeDefined();
    expect(refusal!.stderr).toContain(`${SDK}-darwin-arm64@0.3.263`);
  });
});

/**
 * The controller daemon's folders form a DAG and import each other through
 * their `index.ts`. Each case writes a small controller daemon into a copy's
 * root: `events/` uses `sessions/`, both use the top-level `absorbing.ts`, and
 * the top-level `index.ts` imports both folders.
 */
describe("the controller daemon's folders", () => {
  const CLEAN_DAEMON = {
    "absorbing.ts": "export const absorb = 1;\n",
    "index.ts": 'import "./sessions";\nimport "./events";\n',
    "sessions/index.ts": 'import "../absorbing";\nexport * from "./placement";\n',
    "sessions/placement.ts": "export const place = 1;\n",
    "events/index.ts": 'import "../absorbing";\nimport "../sessions";\n',
  };

  /** Writes a controller daemon from `files` into a copy's root, and returns the copy's path. */
  const createDaemonRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const script = await createScriptRoot(`${SDK}@0.3.263`);
    const daemon = join(dirname(script), "../apps/controller/src/daemon");
    for (const [name, body] of Object.entries(files)) {
      await mkdir(dirname(join(daemon, name)), { recursive: true });
      await writeFile(join(daemon, name), body);
    }
    return script;
  };

  /** Resolves to the error output dep-lint failed with, or fails the test. */
  const readDaemonFailure = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const refusal = await runDepLint("clean", await createDaemonRoot(files)).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );
    if (refusal === undefined) throw new Error("dep-lint accepted the controller daemon");
    return refusal.stderr;
  };

  it("pass when they import each other through their index without a cycle", async () => {
    const { stdout } = await runDepLint("clean", await createDaemonRoot(CLEAN_DAEMON));

    expect(stdout).toContain("the controller daemon's 2 folders form a DAG");
  });

  it("fail the check when two of them import each other", async () => {
    const stderr = await readDaemonFailure({
      ...CLEAN_DAEMON,
      "sessions/index.ts": 'import "../events";\nexport * from "./placement";\n',
    });

    expect(stderr).toContain("in a cycle");
    expect(stderr).toContain("sessions/ -> events/");
  });

  it("fail the check when one reaches past another's index", async () => {
    const stderr = await readDaemonFailure({
      ...CLEAN_DAEMON,
      "events/index.ts": 'import "../sessions/placement";\n',
    });

    expect(stderr).toContain('events/index.ts imports "../sessions/placement"');
  });
});
