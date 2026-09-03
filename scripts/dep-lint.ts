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
 */
import { rm } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const entrypoint = "apps/runner/src/index.ts";

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
  entrypoints: [`${root}${entrypoint}`],
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
 * A builtin like `bun:sqlite` is external, so it never lands in `sources`.
 * The bundled output still carries its import specifier, so scan both.
 */
const js = built.outputs.find((o) => o.kind === "entry-point");
const specifiers = js ? [...(await js.text()).matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]!) : [];

const graph = [...new Set([...sources, ...specifiers])].sort();

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
