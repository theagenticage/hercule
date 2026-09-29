import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

const folders: Array<string> = [];

afterAll(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

/**
 * Writes a build folder the way Vite lays one out, and returns its path.
 * `index.html` loads `assets/entry.js` and preloads `assets/vendor.js` with
 * paths that start with `prefix`, and `assets/route.js` is a chunk that no
 * page fetches first.
 */
const createBuild = async (prefix: string, entry = "export const entry = 1;"): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), "hercule-bundle-budget-"));
  folders.push(folder);
  await mkdir(join(folder, "assets"));
  await writeFile(
    join(folder, "index.html"),
    `<!doctype html>
<html>
  <head>
    <script type="module" crossorigin src="${prefix}assets/entry.js"></script>
    <link rel="modulepreload" crossorigin href="${prefix}assets/vendor.js">
  </head>
</html>
`,
  );
  await writeFile(join(folder, "assets/entry.js"), entry);
  await writeFile(join(folder, "assets/vendor.js"), "export const vendor = 1;");
  await writeFile(join(folder, "assets/route.js"), "export const route = 1;");
  return folder;
};

const checkBudget = (folder: string) =>
  run("bun", ["run", join(root, "scripts/check-bundle-budget.ts"), folder], { cwd: root });

/** Resolves to the error output the check failed with, or fails the test. */
const readBudgetFailure = async (folder: string): Promise<string> => {
  const refusal = await checkBudget(folder).then(
    () => undefined,
    (thrown: { readonly stderr: string }) => thrown,
  );
  if (refusal === undefined) throw new Error("check-bundle-budget accepted the build");
  return refusal.stderr;
};

describe("check-bundle-budget", () => {
  // The web app's index.html names its files from the server's root. The
  // desktop renderer's may use either form, since `app://hercule/` serves the
  // build folder from its root too.
  it.each([
    ["absolute", "/"],
    ["relative", "./"],
  ])(
    "measures the entry and its preloads when index.html names them with %s paths",
    async (_, prefix) => {
      const { stdout } = await checkBudget(await createBuild(prefix));

      expect(stdout).toContain("across 2 chunks, of 3 built");
    },
  );

  it("fails a build whose first paint is over the budget", async () => {
    // Random bytes barely compress: 300 kB of them, written as base64, still
    // gzip to about 300 kB, over the 250 kB budget.
    const entry = `export const noise = "${randomBytes(300 * 1024).toString("base64")}";`;

    const stderr = await readBudgetFailure(await createBuild("./", entry));

    expect(stderr).toContain("over budget");
  });

  it("fails a development build", async () => {
    const entry = 'import { jsxDEV } from "react/jsx-dev-runtime";\nexport const entry = jsxDEV;';

    const stderr = await readBudgetFailure(await createBuild("./", entry));

    expect(stderr).toContain('assets/entry.js contains "jsx-dev-runtime"');
  });

  it("fails when the build folder does not exist", async () => {
    const stderr = await readBudgetFailure(join(tmpdir(), "hercule-no-such-build"));

    expect(stderr).toContain("there is no build in");
  });
});
