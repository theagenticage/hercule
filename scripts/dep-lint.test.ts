import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

const UI = JSON.stringify(join(root, "packages/ui/src/index.ts"));
const PROTOCOL = JSON.stringify(join(root, "packages/protocol/src/index.ts"));
const UI_FONT = JSON.stringify(join(root, "packages/ui/src/fonts/onest-latin.woff2"));

/**
 * The rules are only useful if the tests prove they fail when they should.
 * Each fixture is an entrypoint that imports one forbidden thing with one
 * import form; each layer has a clean fixture as the control. Fixtures are
 * keyed by their path in the fixture folder.
 */
const FIXTURES = {
  "clean.ts": `export function run(argv: readonly string[]): void {
  console.log(argv.join(" "));
}`,
  "db-static.ts": `import { Database } from "bun:sqlite";
export const run = (): void => console.log(Database);`,
  "db-bare.ts": `import "bun:sqlite";
export const run = (): void => console.log("runner");`,
  "db-dynamic.ts": `export async function run(): Promise<void> {
  const { Database } = await import("bun:sqlite");
  console.log(Database);
}`,
  // Mentioning a forbidden module in a comment does not break the rule, and a
  // type-only import is not a runtime edge. Both must pass.
  "type-only.ts": `// The runner must never import "bun:sqlite" or require("bun:sqlite").
import type { Database } from "bun:sqlite";
export const run = (db?: Database): void => console.log(typeof db);`,
  "plugin-host.ts": `import { run as controller } from ${JSON.stringify(join(root, "apps/controller/src/index.ts"))};
export const run = (): void => controller([]);`,
  "web.ts": `import { Logo } from ${UI};
export const run = (): void => console.log(typeof Logo);`,

  // The desktop app's layers. The fixtures import packages by name, as the
  // real layers do; `beforeAll` links each one in beside them.
  "desktop-ui.ts": `import { Logo } from ${UI};
export const start = (): void => console.log(typeof Logo);`,
  "main-clean.ts": `import { app } from "electron";
import { join } from "node:path";
export const start = (): void => console.log(app.getPath("userData"), join("a", "b"));`,
  "main-react.ts": `import { createElement } from "react";
export const start = (): void => console.log(createElement("div"));`,
  "main-home.ts": `import { VERSION } from "@hercule/home/version";
export const start = (): void => console.log(VERSION);`,
  // The preload fixtures sit in a folder of their own, as the real preload
  // does, so that the IPC contract beside it is not the preload's own code.
  // The contract links effect at runtime, which the preload must never link.
  "ipc/contract.ts": `import { Schema } from "effect";
export type Reply<Response> = { readonly response: Response };
export const Message = Schema.String;`,
  // `import type` is erased along with the import.
  "preload/clean.ts": `import { contextBridge, ipcRenderer } from "electron";
import type { Reply } from "../ipc/contract";
const read = (): Promise<Reply<string>> => ipcRenderer.invoke("controller.read");
contextBridge.exposeInMainWorld("hercule", { read });`,
  // Vite keeps an import whose names are all marked `type` inline, because
  // the repository compiles with verbatimModuleSyntax.
  "preload/inline-type.ts": `import { contextBridge, ipcRenderer } from "electron";
import { type Reply } from "../ipc/contract";
const read = (): Promise<Reply<string>> => ipcRenderer.invoke("controller.read");
contextBridge.exposeInMainWorld("hercule", { read });`,
  "preload/effect.ts": `import { contextBridge } from "electron";
import { Schema } from "effect";
contextBridge.exposeInMainWorld("hercule", { decode: Schema.decodeUnknownSync(Schema.String) });`,
  // Vite's `?url` suffix is dropped and the file itself is resolved.
  "renderer-clean.tsx": `import "./renderer.css";
import bricolage from "./fonts/bricolage.woff2?url";
export const Frame = () => <link rel="preload" href={bricolage} as="font" />;`,
  // A path from the root is served from the page's public folder, so it is
  // no import of the renderer's.
  "renderer.css": `@font-face {
  font-family: "Bricolage Grotesque";
  src:
    url("fonts/bricolage.woff2") format("woff2"),
    url("/fonts/served.woff2") format("woff2");
}`,
  "fonts/bricolage.woff2": "wOF2",
  "renderer-electron.tsx": `import { ipcRenderer } from "electron";
export const read = () => ipcRenderer.invoke("controller.read");`,
  "renderer-node-prefixed.tsx": `import { readFileSync } from "node:fs";
export const read = () => readFileSync("/etc/hosts", "utf8");`,
  "renderer-node-bare.tsx": `import path from "path";
export const read = () => path.join("a", "b");`,
  // The contract reuses schemas of @hercule/protocol, so this graph reaches it.
  "renderer-contract.tsx": `import { api } from "@hercule/contract";
export const read = () => api;`,
  "renderer-protocol.tsx": `import * as protocol from "@hercule/protocol";
export const read = () => protocol;`,
  // The contract reaches @hercule/protocol first, and the re-export reaches
  // it again: the second import is the layer's own and still refused.
  "renderer-protocol-reexport.tsx": `export { api } from "@hercule/contract";
export * as protocol from "@hercule/protocol";`,
  "renderer-protocol-path.tsx": `import * as protocol from ${PROTOCOL};
export const read = () => protocol;`,
  "renderer-ui-import.tsx": `import "./ui-import.css";`,
  "ui-import.css": `@import "@hercule/ui/styles.css";`,
  "renderer-ui-font.tsx": `import "./ui-font.css";`,
  "ui-font.css": `@font-face {
  font-family: "Onest";
  src: url(${UI_FONT}) format("woff2");
}`,
} as const;

let dir: string;

const roots: Array<string> = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hercule-dep-lint-"));
  for (const [name, body] of Object.entries(FIXTURES)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), `${body}\n`);
  }
  // The fixtures sit outside the workspace, so a package they import by name
  // resolves only through a node_modules folder of their own.
  await mkdir(join(dir, "node_modules/@hercule"), { recursive: true });
  await symlink(join(root, "apps/web/node_modules/react"), join(dir, "node_modules/react"));
  await symlink(join(root, "node_modules/effect"), join(dir, "node_modules/effect"));
  for (const name of ["contract", "protocol", "home", "ui"]) {
    await symlink(join(root, "packages", name), join(dir, "node_modules/@hercule", name));
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const one of roots.splice(0)) await rm(one, { recursive: true, force: true });
});

/** Runs dep-lint with one layer's rule pointed at a fixture. */
const runDepLint = (layer: string, fixture: string, script = join(root, "scripts/dep-lint.ts")) =>
  run("bun", ["run", script, layer, join(dir, fixture)], { cwd: root });

/** Resolves to the failure dep-lint exited with, or fails the test. */
async function readDepLintFailure(
  layer: string,
  fixture: string,
): Promise<{ code?: number; stderr?: string }> {
  const error = await runDepLint(layer, fixture).then(
    () => undefined,
    (e: { code?: number; stderr?: string }) => e,
  );
  if (error === undefined) throw new Error(`dep-lint accepted the ${fixture} fixture`);
  return error;
}

describe("dep-lint", () => {
  it("passes an entrypoint that links nothing forbidden", async () => {
    const { stdout } = await runDepLint("runner", "clean.ts");
    expect(stdout).toContain("is clean");
  });

  it("passes an entrypoint that only names the DB engine in a comment or a type", async () => {
    const { stdout } = await runDepLint("runner", "type-only.ts");
    expect(stdout).toContain("is clean");
  });

  it.each(["db-static.ts", "db-bare.ts", "db-dynamic.ts"])(
    "fails on the DB engine reached by %s",
    async (fixture) => {
      const error = await readDepLintFailure("runner", fixture);
      expect(error.code).toBe(1);
      expect(error.stderr).toContain("the DB engine");
    },
  );

  it("fails on the plugin host", async () => {
    const error = await readDepLintFailure("runner", "plugin-host.ts");
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("the plugin host");
  });

  it("fails on the web bundle", async () => {
    const error = await readDepLintFailure("runner", "web.ts");
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("the web bundle");
  });

  it("fails when an entrypoint of a rule does not exist", async () => {
    const script = await createScriptRoot(`${SDK}@0.3.263`);

    const refusal = await run("bun", ["run", script], { cwd: root }).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );

    expect(refusal, "dep-lint accepted a workspace with no entrypoints").toBeDefined();
    expect(refusal!.stderr).toContain(
      "the runner entrypoint apps/runner/src/index.ts does not exist",
    );
    expect(refusal!.stderr).toContain(
      "the desktop renderer entrypoint apps/desktop/src/renderer/main.tsx does not exist",
    );
  });
});

describe("dep-lint on the desktop app's layers", () => {
  /** Returns the heading dep-lint prints above the imports of first-party code a layer may not link. */
  const describeRefusedFirstParty = (packages: string) =>
    `  first-party code other than its own files${packages}:\n`;
  const CLIENT_PACKAGES = ", @hercule/contract, @hercule/client-core";

  it.each(["desktop main", "desktop preload", "desktop renderer"])(
    "fails when the %s reaches @hercule/ui",
    async (layer) => {
      const error = await readDepLintFailure(layer, "desktop-ui.ts");
      expect(error.stderr).toContain(`links what the ${layer} must not link`);
      expect(error.stderr).toContain(`imports ${UI} (packages/ui/src/index.ts)\n`);
    },
  );

  it("passes a main that links electron and a Node built-in", async () => {
    const { stdout } = await runDepLint("desktop main", "main-clean.ts");
    expect(stdout).toContain("is clean");
  });

  it("fails when main reaches React", async () => {
    const error = await readDepLintFailure("desktop main", "main-react.ts");
    expect(error.stderr).toContain("  React:\n");
    expect(error.stderr).toContain('main-react.ts imports "react" (node_modules/.pnpm/react@');
  });

  it("fails when main reaches a workspace package other than the two it may", async () => {
    const error = await readDepLintFailure("desktop main", "main-home.ts");
    expect(error.stderr).toContain(describeRefusedFirstParty(CLIENT_PACKAGES));
    expect(error.stderr).toContain(
      'main-home.ts imports "@hercule/home/version" (packages/home/src/version.ts)\n',
    );
  });

  it("passes a preload that links electron and imports types with `import type`", async () => {
    const { stdout } = await runDepLint("desktop preload", "preload/clean.ts");
    expect(stdout).toContain("is clean");
  });

  it("fails when the preload imports types without `import type`", async () => {
    const error = await readDepLintFailure("desktop preload", "preload/inline-type.ts");
    expect(error.stderr).toContain(describeRefusedFirstParty(""));
    expect(error.stderr).toContain('preload/inline-type.ts imports "../ipc/contract" (');
  });

  it("fails when the preload links anything but electron, such as effect", async () => {
    const error = await readDepLintFailure("desktop preload", "preload/effect.ts");
    expect(error.stderr).toContain("  anything but electron:\n");
    expect(error.stderr).toContain(
      'preload/effect.ts imports "effect" (node_modules/.pnpm/effect@',
    );
  });

  it("passes a renderer that renders JSX and imports a stylesheet and a font", async () => {
    const { stdout } = await runDepLint("desktop renderer", "renderer-clean.tsx");
    expect(stdout).toContain("is clean");
  });

  it("fails when the renderer imports electron", async () => {
    const error = await readDepLintFailure("desktop renderer", "renderer-electron.tsx");
    expect(error.stderr).toContain("  electron:\n");
    expect(error.stderr).toContain('renderer-electron.tsx imports "electron"\n');
  });

  it("passes a renderer that reaches @hercule/protocol through @hercule/contract", async () => {
    const { stdout } = await runDepLint("desktop renderer", "renderer-contract.tsx");
    expect(stdout).toContain("is clean");
  });

  it.each([
    ["by name", "renderer-protocol.tsx", '"@hercule/protocol"'],
    ["in a re-export", "renderer-protocol-reexport.tsx", '"@hercule/protocol"'],
    ["by its path", "renderer-protocol-path.tsx", PROTOCOL],
  ])(
    "fails when the renderer imports @hercule/protocol itself, %s",
    async (_, fixture, written) => {
      const error = await readDepLintFailure("desktop renderer", fixture);
      expect(error.stderr).toContain(describeRefusedFirstParty(CLIENT_PACKAGES));
      expect(error.stderr).toContain(
        `${fixture} imports ${written} (packages/protocol/src/index.ts)\n`,
      );
    },
  );

  it("fails when the renderer's stylesheet imports one of @hercule/ui", async () => {
    const error = await readDepLintFailure("desktop renderer", "renderer-ui-import.tsx");
    expect(error.stderr).toContain(
      'ui-import.css imports "@hercule/ui/styles.css" (packages/ui/src/styles.css)\n',
    );
  });

  it("fails when the renderer's stylesheet points at a font of @hercule/ui", async () => {
    const error = await readDepLintFailure("desktop renderer", "renderer-ui-font.tsx");
    expect(error.stderr).toContain(
      `ui-font.css imports ${UI_FONT} (packages/ui/src/fonts/onest-latin.woff2)\n`,
    );
  });

  it.each(["renderer-node-prefixed.tsx", "renderer-node-bare.tsx"])(
    "fails when the renderer imports a Node built-in, as in %s",
    async (fixture) => {
      const error = await readDepLintFailure("desktop renderer", fixture);
      expect(error.stderr).toContain("  a Node or Bun built-in:\n");
    },
  );
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
  // The script imports TypeScript, which the copy's root has no copy of.
  await mkdir(join(one, "node_modules"));
  await symlink(join(root, "node_modules/typescript"), join(one, "node_modules/typescript"));
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

    const refusal = await runDepLint("runner", "clean.ts", script).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );

    expect(refusal, "dep-lint accepted a store with no SDK in it").toBeDefined();
    expect(refusal!.stderr).toContain("is not installed");
  });

  it("fail the check when one of them is in the store", async () => {
    const script = await createScriptRoot(`${SDK}@0.3.263`, `${SDK}-darwin-arm64@0.3.263`);

    const refusal = await runDepLint("runner", "clean.ts", script).then(
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
    const refusal = await runDepLint("runner", "clean.ts", await createDaemonRoot(files)).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );
    if (refusal === undefined) throw new Error("dep-lint accepted the controller daemon");
    return refusal.stderr;
  };

  it("pass when they import each other through their index without a cycle", async () => {
    const { stdout } = await runDepLint("runner", "clean.ts", await createDaemonRoot(CLEAN_DAEMON));

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

/**
 * Only `sessions/context.ts` imports the runner's `user-material/`, the module
 * that finds the user's own skills and instructions for a Thread. Each case
 * writes a small runner into a copy's root: the folder's files import each
 * other, the context resolver imports the folder, and a test, a harness and a
 * type-only import reach it too, which the rule allows.
 */
describe("the runner's user material", () => {
  const CLEAN_RUNNER = {
    "user-material/index.ts": 'export * from "./links";\n',
    "user-material/links.ts": "export type Link = string;\nexport const linkUserMaterial = 1;\n",
    "sessions/context.ts":
      'import { linkUserMaterial } from "../user-material";\nexport const ctx = linkUserMaterial;\n',
    "sessions/context.test.ts": 'import "../user-material/links";\n',
    "sessions/testing.ts": 'import "../user-material";\n',
    "providers/claude.ts":
      'import type { Link } from "../user-material";\nexport const link: Link = "";\n',
  };

  /** Writes a runner from `files` into a copy's root, and returns the copy's path. */
  const createRunnerRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const script = await createScriptRoot(`${SDK}@0.3.263`);
    const src = join(dirname(script), "../apps/runner/src");
    for (const [name, body] of Object.entries(files)) {
      await mkdir(dirname(join(src, name)), { recursive: true });
      await writeFile(join(src, name), body);
    }
    return script;
  };

  it("passes when only the context resolver imports it", async () => {
    const { stdout } = await runDepLint("runner", "clean.ts", await createRunnerRoot(CLEAN_RUNNER));

    expect(stdout).toContain("only sessions/context.ts imports the runner's user-material/");
  });

  // Each case is the file that imports the folder, its body, and the line
  // dep-lint reports it with.
  it.each([
    [
      "a provider imports the folder",
      "providers/claude.ts",
      'import "../user-material";\n',
      'providers/claude.ts imports "../user-material"',
    ],
    [
      "a file beside the context resolver re-exports a file in it",
      "sessions/index.ts",
      'export * from "../user-material/links";\n',
      'sessions/index.ts imports "../user-material/links"',
    ],
    [
      "a top-level file imports its index",
      "daemon.ts",
      'import "./user-material/index";\n',
      'daemon.ts imports "./user-material/index"',
    ],
    [
      "a provider imports it at runtime",
      "providers/codex.ts",
      'export const load = () => import("../user-material");\n',
      'providers/codex.ts imports "../user-material"',
    ],
  ])("fails when %s", async (_, file, body, reported) => {
    const script = await createRunnerRoot({ ...CLEAN_RUNNER, [file]: body });

    const refusal = await runDepLint("runner", "clean.ts", script).then(
      () => undefined,
      (thrown: { readonly stderr: string }) => thrown,
    );

    expect(refusal, `dep-lint accepted ${file} importing user-material/`).toBeDefined();
    expect(refusal!.stderr).toContain(`    ${reported}\n`);
    expect(refusal!.stderr).toContain("ADR 0032");
  });
});
