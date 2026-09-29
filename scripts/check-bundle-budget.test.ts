import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

/**
 * Writes main's build the way Vite lays one out, and returns the path of its
 * startup file: `index.js` of `startupBytes` bytes, beside a 400 kB chunk in
 * `assets/` that main imports lazily.
 */
const createMainBuild = async (startupBytes: number): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), "hercule-main-budget-"));
  folders.push(folder);
  await mkdir(join(folder, "assets"));
  await writeFile(join(folder, "index.js"), "x".repeat(startupBytes));
  await writeFile(join(folder, "assets/controller-check.js"), "x".repeat(400 * 1024));
  return join(folder, "index.js");
};

const checkMainStartup = (file: string) =>
  run("bun", ["run", join(root, "scripts/check-bundle-budget.ts"), "--main-startup", file], {
    cwd: root,
  });

/** Resolves to the error output the check of main's startup file failed with, or fails the test. */
const readMainStartupFailure = async (file: string): Promise<string> => {
  const refusal = await checkMainStartup(file).then(
    () => undefined,
    (thrown: { readonly stderr: string }) => thrown,
  );
  if (refusal === undefined) throw new Error("check-bundle-budget accepted main's startup file");
  return refusal.stderr;
};

describe("check-bundle-budget --main-startup", () => {
  it("passes a startup file within the budget, whatever the lazy chunks beside it weigh", async () => {
    const { stdout } = await checkMainStartup(await createMainBuild(150 * 1024));

    expect(stdout).toContain("is 150.0 kB minified; the budget is 160.0 kB.");
  });

  it("fails a startup file over the budget, and names the file, its size and the spec", async () => {
    const file = await createMainBuild(170 * 1024);

    const stderr = await readMainStartupFailure(file);

    expect(stderr).toContain(
      `${relative(root, file)} is 170.0 kB minified, over main's startup budget of 160.0 kB`,
    );
    expect(stderr).toContain(`Spec 17 §Performance owns the number, in the "Main's startup" row`);
  });

  it("fails when the startup file does not exist", async () => {
    const stderr = await readMainStartupFailure(join(tmpdir(), "hercule-no-such-main/index.js"));

    expect(stderr).toContain("there is no startup file at");
  });
});
