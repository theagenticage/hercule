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
 * Usage: `bun run scripts/dep-lint.ts [entrypoint]`. The optional entrypoint
 * is what `scripts/dep-lint.test.ts` points at its fixtures.
 */
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entrypoint = process.argv[2] ?? "apps/runner/src/index.ts";

/** Each rule names what it forbids and why; the message is the CI output. */
const FORBIDDEN = [
  { what: "the DB engine", pattern: /@effect[/+]sql|(^|[/"'])bun:sqlite/ },
  { what: "the plugin host", pattern: /apps[/+]controller|@hydra[/+]controller|(^|\/)plugins\// },
  {
    what: "the web bundle",
    pattern: /apps[/+]web|@hydra[/+]ui|packages\/ui|(^|[/+])react(-dom)?[/@]|\.(html|css)$/,
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

/**
 * A specifier the bundler leaves external, `bun:sqlite` above all, never lands
 * in `sources`. Two scans close that hole between them.
 *
 * First: the emitted bundle still carries the import of anything external that
 * survives bundling, in every form that reaches a module.
 */
const IMPORT_FORMS = /(?:\b(?:from|import)\s*\(?|require\s*\()\s*["']([^"']+)["']/g;
const js = built.outputs.find((o) => o.kind === "entry-point");
const bundled = js ? [...(await js.text()).matchAll(IMPORT_FORMS)].map((m) => m[1]!) : [];

/**
 * Second: Bun drops a bare `import "bun:sqlite"` outright, so nothing of it
 * survives into the bundle. Read our own linked sources and take their
 * specifiers as written. Third-party sources are skipped: their own dead
 * branches are not this repo's violations, and their paths are already in the
 * graph below.
 */
const mapDir = dirname(map.path);
const written = (
  await Promise.all(
    sources
      .filter((source) => !source.includes("node_modules/"))
      .map(async (source) => {
        const text = await Bun.file(resolve(mapDir, source))
          .text()
          .catch(() => "");
        return [...text.matchAll(IMPORT_FORMS)].map((m) => m[1]!);
      }),
  )
).flat();

const graph = [...new Set([...sources, ...bundled, ...written])].sort();

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
