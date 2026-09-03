import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  "db-require": `const { Database } = require("bun:sqlite");
console.log(Database);`,
  "plugin-host": `import { run as controller } from ${JSON.stringify(join(root, "apps/controller/src/index.ts"))};
export const run = (): void => controller([]);`,
  web: `import { Logo } from ${JSON.stringify(join(root, "packages/ui/src/index.tsx"))};
export const run = (): void => console.log(typeof Logo);`,
} as const;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hydra-dep-lint-"));
  await Promise.all(
    Object.entries(FIXTURES).map(([name, body]) => writeFile(join(dir, `${name}.ts`), `${body}\n`)),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const depLint = (fixture: string) =>
  run("bun", ["run", join(root, "scripts/dep-lint.ts"), join(dir, `${fixture}.ts`)], { cwd: root });

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

  it.each(["db-static", "db-bare", "db-dynamic", "db-require"])(
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
