#!/usr/bin/env bun
/**
 * Mode isolation, enforced (spec 15 section 3, ADR 0018).
 *
 * The runner entrypoint's module graph MUST NOT include any controller
 * package: no DB engine, no plugin host, no web bundle. Isolation is a
 * property of the import graph per entrypoint, not of the file on disk, so
 * this reads the graph Bun actually links: `--sourcemap=external` emits a map
 * whose `sources` array is the post-tree-shake module list. Bun has no
 * `--metafile`.
 *
 * The rule sees specifiers, so a specifier assembled at runtime
 * (`await import("bun" + ":sqlite")`) is invisible to it. Nothing in the
 * codebase does that, and no scan short of running the code could catch it.
 *
 * Usage: `bun run scripts/dep-lint.ts [entrypoint]`. The optional entrypoint
 * is what `scripts/dep-lint.test.ts` points at its fixtures.
 */
import { rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entrypoint = process.argv[2] ?? "apps/runner/src/index.ts";

/**
 * Each rule names what it forbids and why; the message is the CI output.
 * Patterns are matched against repository-relative paths and bare specifiers,
 * so a first-party plugin is `plugins/...` while a dependency that happens to
 * ship a `plugins/` directory is under `node_modules/` and does not match.
 */
const FORBIDDEN = [
  { what: "the DB engine", pattern: /@effect[/+]sql|^bun:sqlite$/ },
  {
    what: "the plugin host",
    pattern: /^apps\/controller\/|@hydra[/+]controller|^plugins\//,
  },
  {
    what: "the web bundle",
    pattern: /^apps\/web\/|^packages\/ui\/|@hydra[/+]ui|(^|\/)react(-dom)?([/@]|$)|\.(html|css)$/,
  },
] as const;

const outdir = `${root}node_modules/.cache/dep-lint`;
await rm(outdir, { recursive: true, force: true });

const built = await Bun.build({
  entrypoints: [resolve(root, entrypoint)],
  target: "bun",
  sourcemap: "external",
  outdir,
});

if (!built.success) {
  console.error(`dep-lint: could not build ${entrypoint}`);
  for (const log of built.logs) console.error(" ", log.message);
  process.exit(1);
}

const map = built.outputs.find((o) => o.path.endsWith(".map"));
if (!map) {
  console.error("dep-lint: bun emitted no sourcemap; cannot read the module graph");
  process.exit(1);
}

const { sources } = (await Bun.file(map.path).json()) as { sources: string[] };
const mapDir = dirname(map.path);
const linked = sources.map((source) => relative(root, resolve(mapDir, source)));

/**
 * A specifier the bundler leaves external, `bun:sqlite` above all, never lands
 * in `sources`, and Bun deletes a bare `import "bun:sqlite"` outright. So read
 * the imports of our own linked sources, parsed rather than pattern-matched:
 * `scanImports` sees through comments and string literals, and drops
 * `import type`, which creates no runtime edge and so is no violation.
 */
const written = (
  await Promise.all(
    linked
      .filter((source) => !source.startsWith("node_modules/"))
      .map(async (source) => {
        const path = resolve(root, source);
        const text = await Bun.file(path)
          .text()
          .catch(() => "");
        const transpiler = new Bun.Transpiler({ loader: path.endsWith("x") ? "tsx" : "ts" });
        return transpiler.scanImports(text).map((record) => record.path);
      }),
  )
).flat();

/**
 * Secondary: third-party sources are not scanned above, since their own dead
 * branches are not this repo's violations. The emitted bundle still carries
 * whatever external they import, so scan it for every specifier form.
 */
const IMPORT_FORMS = /(?:\b(?:from|import)\s*\(?|require\s*\()\s*["']([^"']+)["']/g;
const js = built.outputs.find((o) => o.kind === "entry-point");
const bundled = js ? [...(await js.text()).matchAll(IMPORT_FORMS)].map((m) => m[1]!) : [];

const graph = [...new Set([...linked, ...written, ...bundled])].sort();

const violations = FORBIDDEN.flatMap(({ what, pattern }) => {
  const hits = graph.filter((source) => pattern.test(source));
  return hits.length === 0 ? [] : [{ what, hits }];
});

if (violations.length > 0) {
  console.error(`dep-lint: ${entrypoint} links what the runner must not link.`);
  console.error("The runner entrypoint's module graph must contain no controller package:");
  console.error("no DB engine, no plugin host, no web bundle (spec 15 section 3, ADR 0018).\n");
  for (const { what, hits } of violations) {
    console.error(`  ${what}:`);
    for (const hit of hits) console.error(`    ${hit}`);
  }
  process.exit(1);
}

console.log(`dep-lint: ${entrypoint} is clean (${graph.length} modules in the graph).`);
