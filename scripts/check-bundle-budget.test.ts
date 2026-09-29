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

/**
 * Adds to the build in `folder` what a router that splits routes leaves:
 * `assets/screen.js`, split from `src/routes/screen.tsx`, which imports
 * `assets/shared.js`, and `assets/other.js`, split from another route. Writes
 * the Vite manifest that names them, unless `withManifest` is false, and the
 * source file of the first route. Returns that source file's path.
 */
const addSplitRoutes = async (folder: string, { withManifest = true } = {}): Promise<string> => {
  await writeFile(join(folder, "assets/screen.js"), "export const screen = 1;");
  await writeFile(join(folder, "assets/shared.js"), "export const shared = 1;");
  await writeFile(join(folder, "assets/other.js"), "export const other = 1;");
  if (withManifest) {
    await mkdir(join(folder, ".vite"));
    await writeFile(
      join(folder, ".vite/manifest.json"),
      JSON.stringify({
        "index.html": { file: "assets/entry.js", isEntry: true, imports: ["_vendor.js"] },
        "_vendor.js": { file: "assets/vendor.js" },
        "routes/screen.tsx?tsr-split=component": {
          file: "assets/screen.js",
          isDynamicEntry: true,
          imports: ["_shared.js", "_vendor.js"],
        },
        "_shared.js": { file: "assets/shared.js" },
        "routes/other.tsx?tsr-split=component": { file: "assets/other.js", isDynamicEntry: true },
      }),
    );
  }
  const routeFile = join(folder, "src/routes/screen.tsx");
  await mkdir(join(folder, "src/routes"), { recursive: true });
  await writeFile(routeFile, "export const Route = {};");
  return routeFile;
};

const checkBudget = (folder: string, ...options: ReadonlyArray<string>) =>
  run("bun", ["run", join(root, "scripts/check-bundle-budget.ts"), folder, ...options], {
    cwd: root,
  });

/** Resolves to the error output the check failed with, or fails the test. */
const readBudgetFailure = async (
  folder: string,
  ...options: ReadonlyArray<string>
): Promise<string> => {
  const refusal = await checkBudget(folder, ...options).then(
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

describe("check-bundle-budget --route", () => {
  it("also counts the chunks a named route was split into, and the chunks they import", async () => {
    const folder = await createBuild("./");
    const routeFile = await addSplitRoutes(folder);

    const { stdout } = await checkBudget(folder, "--route", routeFile);

    // The entry and its preload, the route's chunk and the chunk it imports:
    // not the other route's chunk, nor `assets/route.js`, which no route names.
    expect(stdout).toContain("across 4 chunks, of 6 built");
    expect(stdout).toMatch(/assets\/screen\.js +\S+ kB +route/);
    expect(stdout).toMatch(/assets\/shared\.js +\S+ kB +route/);
  });

  it("fails when a route file does not exist, rather than count nothing for it", async () => {
    const folder = await createBuild("./");
    await addSplitRoutes(folder);

    const stderr = await readBudgetFailure(folder, "--route", join(folder, "src/routes/typo.tsx"));

    expect(stderr).toContain("there is no route file at");
  });

  it("fails when a route is named and the build has no manifest", async () => {
    const folder = await createBuild("./");
    const routeFile = await addSplitRoutes(folder, { withManifest: false });

    const stderr = await readBudgetFailure(folder, "--route", routeFile);

    expect(stderr).toContain("has no Vite manifest");
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
