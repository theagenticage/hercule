/**
 * Checks the desktop renderer's first screen against the MCP server models:
 * the files it loads before anything else must not reach the code that joins
 * servers with their Connections, builds a line's buttons, reads offers or
 * edits a list. That code loads when a thread first needs it.
 *
 * `packages/client-core/src/mcp-servers/first-screen.test.ts` checks the
 * narrow entry the first screen should import. This test checks what the
 * renderer imports, so a first-screen file that switches to the broad
 * `@hercule/client-core/mcp-servers` entry fails here.
 *
 * It follows the value imports of the renderer's entry (`main.tsx`, which
 * `index.html` loads) and of the routes the desktop build counts as its first
 * screen (the `--route` list of `build:desktop:bundle` in the root
 * `package.json`) through the renderer and `@hercule/client-core`. A dynamic
 * `import()`, which loads later, is not followed. The generated route tree is
 * not followed either: it names every route, and the build splits each route's
 * code at build time, so only the routes the first screen renders are listed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const clientCoreSource = join(repository, "packages/client-core/src");
const mcpServersFolder = `${join(clientCoreSource, "mcp-servers")}/`;

/** The routes the first screen renders, as `build:desktop:bundle` names them. */
const rendererSource = join(repository, "apps/desktop/src/renderer");

/** The file `index.html` loads as the renderer's entry. */
const RENDERER_ENTRY = join(rendererSource, "main.tsx");

/** The generated route tree, which imports every route and is left to `FIRST_SCREEN_ROUTES`. */
const ROUTE_TREE = join(rendererSource, "routeTree.gen.ts");

const FIRST_SCREEN_ROUTES = [
  "__root.tsx",
  "_connected.tsx",
  "_connected/_shell.tsx",
  "_connected/_shell/index.tsx",
  "_connected/_shell/threads/$sessionId/route.tsx",
  "_connected/_shell/threads/$sessionId/index.tsx",
].map((route) => join(repository, "apps/desktop/src/renderer/routes", route));

/**
 * Returns the module paths `source` imports or re-exports as values. An
 * `import type`, an `export type`, and a clause whose every name is a `type`
 * name are erased at build time and pull nothing in.
 */
const findValueImports = (source: string): string[] =>
  [...source.matchAll(/^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"/gms)].flatMap(
    ([, typeOnly, clause, path]) => {
      if (typeOnly !== undefined) return [];
      const names = /^\{([^}]*)\}$/s.exec(clause!.trim())?.[1];
      const allTypes =
        names !== undefined &&
        names
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== "")
          .every((name) => name.startsWith("type "));
      return allTypes ? [] : [path!];
    },
  );

/** Returns the source file a module path names, or `undefined` for a file this test does not follow. */
const resolveSourceFile = (from: string, path: string): string | undefined => {
  let base: string;
  if (path.startsWith(".")) {
    base = resolve(dirname(from), path);
  } else if (path === "@hercule/client-core") {
    base = join(clientCoreSource, "index");
  } else if (path.startsWith("@hercule/client-core/")) {
    const exportsMap = JSON.parse(
      readFileSync(join(repository, "packages/client-core/package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    const target = exportsMap.exports[`.${path.slice("@hercule/client-core".length)}`];
    if (target === undefined) throw new Error(`client-core exports nothing at ${path}.`);
    base = join(repository, "packages/client-core", target).replace(/\.ts$/, "");
  } else {
    return undefined;
  }
  return [".ts", ".tsx", "/index.ts", "/index.tsx"]
    .map((suffix) => `${base}${suffix}`)
    .find((candidate) => existsSync(candidate));
};

/** Returns every source file the files `entries` reach through value imports, themselves included, except through the route tree. */
const collectReachedFiles = (entries: readonly string[]): Set<string> => {
  const reached = new Set<string>();
  const visit = (file: string): void => {
    if (reached.has(file) || file === ROUTE_TREE) return;
    reached.add(file);
    for (const path of findValueImports(readFileSync(file, "utf8"))) {
      const next = resolveSourceFile(file, path);
      if (next !== undefined) visit(next);
    }
  };
  entries.forEach(visit);
  return reached;
};

/** Returns the files of the MCP server models in `files`, by their name in that folder. */
const pickMcpServerModels = (files: ReadonlySet<string>): string[] =>
  [...files]
    .filter((file) => file.startsWith(mcpServersFolder))
    .map((file) => file.slice(mcpServersFolder.length))
    .toSorted();

describe("the desktop renderer's first screen and the MCP server models", () => {
  it("reaches only the files of the narrow first-screen entry", () => {
    // `draft-pick.ts` is a leaf that `threads/resolve-thread.ts` imports for the draft's list.
    const allowed = [
      "draft-pick.ts",
      ...pickMcpServerModels(collectReachedFiles([join(mcpServersFolder, "first-screen.ts")])),
    ];

    const reached = pickMcpServerModels(
      collectReachedFiles([RENDERER_ENTRY, ...FIRST_SCREEN_ROUTES]),
    );

    // The first screen does read the models: a walk that finds none follows nothing.
    expect(reached).toContain("first-screen.ts");
    expect(reached.filter((file) => !allowed.includes(file))).toEqual([]);
  });

  it("starts from the entry that index.html loads, and does not follow the route tree", () => {
    expect(readFileSync(join(rendererSource, "index.html"), "utf8")).toContain('src="/main.tsx"');
    const entryOnly = collectReachedFiles([RENDERER_ENTRY]);

    expect(entryOnly.has(join(rendererSource, "app/router.tsx"))).toBe(true);
    expect(entryOnly.has(ROUTE_TREE)).toBe(false);
  });
});
