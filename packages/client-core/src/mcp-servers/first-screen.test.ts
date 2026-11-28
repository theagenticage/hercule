import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Returns the relative modules `source` imports or re-exports as values. An
 * `import type`, an `export type`, and a clause whose every name is a `type`
 * name are erased at build time and pull nothing in.
 */
const findValueImports = (source: string): string[] =>
  [...source.matchAll(/^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(\.[^"]*)"/gms)].flatMap(
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

/** Returns every file the file `entry` reaches through value imports, itself included. */
const collectReachedFiles = (entry: string): Set<string> => {
  const reached = new Set<string>();
  const visit = (file: string): void => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const path of findValueImports(readFileSync(file, "utf8"))) {
      visit(resolve(dirname(file), `${path}.ts`));
    }
  };
  visit(entry);
  return reached;
};

describe("findValueImports", () => {
  it("skips type-only imports and exports, and keeps the rest", () => {
    const source = [
      'import type { A } from "./a";',
      'import { type B, type C } from "./b";',
      'import { type D, e } from "./d";',
      'export { f } from "./f";',
      'export type { G } from "./g";',
      'import { h } from "@hercule/contract";',
    ].join("\n");

    expect(findValueImports(source)).toEqual(["./d", "./f"]);
  });
});

describe("the first screen's import of the MCP server models", () => {
  it("reaches only files that join no servers with Connections, build no line's buttons and edit no list", () => {
    const reached = [...collectReachedFiles(resolve(__dirname, "first-screen.ts"))]
      .map((file) => relative(__dirname, file))
      .toSorted();

    expect(reached).toEqual([
      "../errors.ts",
      "display-status.ts",
      "first-screen.ts",
      "mcp-line-presence.ts",
      "start-record.ts",
      "thread-servers-row.ts",
      "thread-servers.ts",
    ]);
  });
});
