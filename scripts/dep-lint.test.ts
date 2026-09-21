import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

/**
 * The rule is only worth having if the failing direction is proven. Each
 * fixture is a runner entrypoint that reaches one forbidden thing by one
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
  // Talking about the rule is not breaking it, and a type-only import is no
  // runtime edge. Both must pass.
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

const depLint = (fixture: string, script = join(root, "scripts/dep-lint.ts")) =>
  run("bun", ["run", script, join(dir, `${fixture}.ts`)], { cwd: root });

/** Resolves to the failure dep-lint exited with, or fails the test. */
async function failure(fixture: string): Promise<{ code?: number; stderr?: string }> {
  const error = await depLint(fixture).then(
    () => undefined,
    (e: { code?: number; stderr?: string }) => e,
  );
  if (error === undefined) throw new Error(`dep-lint accepted the ${fixture} fixture`);
  return error;
}

describe("dep-lint", () => {
  it("passes an entrypoint that links nothing forbidden", async () => {
    const { stdout } = await depLint("clean");
    expect(stdout).toContain("is clean");
  });

  it("passes an entrypoint that only names the DB engine in a comment or a type", async () => {
    const { stdout } = await depLint("type-only");
    expect(stdout).toContain("is clean");
  });

  it.each(["db-static", "db-bare", "db-dynamic"])(
    "fails on the DB engine reached by %s",
    async (fixture) => {
      const error = await failure(fixture);
      expect(error.code).toBe(1);
      expect(error.stderr).toContain("the DB engine");
    },
  );

  it("fails on the plugin host", async () => {
    const error = await failure("plugin-host");
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("the plugin host");
  });

  it("fails on the web bundle", async () => {
    const error = await failure("web");
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("the web bundle");
  });
});

/**
 * The vendor SDK's eight per-platform CLI packages (one is 196 MB) are excluded
 * from the install and must stay excluded. This is a workspace rule, not an
 * import-graph one: pnpm links only direct dependencies, so an optional
 * dependency of the SDK shows up in the store and nowhere else.
 */
describe("the vendor SDK's per-platform CLI packages", () => {
  const SDK = "@anthropic-ai+claude-agent-sdk";

  /**
   * The script reads the workspace it sits in, so a copy in a root of its own is
   * how the failing direction is proven without writing into this repository's
   * own store.
   */
  const scriptOver = async (...packages: ReadonlyArray<string>): Promise<string> => {
    const one = await mkdtemp(join(tmpdir(), "hercule-dep-lint-root-"));
    roots.push(one);
    await mkdir(join(one, "scripts"), { recursive: true });
    await copyFile(join(root, "scripts/dep-lint.ts"), join(one, "scripts/dep-lint.ts"));
    for (const name of packages) {
      await mkdir(join(one, "node_modules/.pnpm", name), { recursive: true });
    }
    return join(one, "scripts/dep-lint.ts");
  };

  it("are not installed, and dep-lint says so over the repository as it stands", async () => {
    const { stdout } = await run("bun", ["run", join(root, "scripts/dep-lint.ts")], { cwd: root });

    expect(stdout).toContain("is clean");
    expect(stdout).toContain("no per-platform CLI package");
  });

  // Without the SDK there are no per-platform packages beside it either, so the
  // platform check alone would call an install that never happened clean.
  it("fail the check when the SDK itself is not installed", async () => {
    const script = await scriptOver("effect@4.0.0");

    const refusal = await depLint("clean", script).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );

    expect(refusal, "dep-lint accepted a store with no SDK in it").toBeDefined();
    expect(refusal!.stderr).toContain("is not installed");
  });

  it("fail the check when one finds its way into the store", async () => {
    const script = await scriptOver(`${SDK}@0.3.263`, `${SDK}-darwin-arm64@0.3.263`);

    const refusal = await depLint("clean", script).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );

    expect(refusal, "dep-lint accepted a store with a per-platform package in it").toBeDefined();
    expect(refusal!.stderr).toContain(`${SDK}-darwin-arm64@0.3.263`);
  });
});
