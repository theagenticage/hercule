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
 * A second graph rule is about the controller rather than the runner: its
 * domains form a DAG. `src/<domain>/index.ts` is the boundary a domain is
 * imported through, and a cycle between two of them is not only a design smell
 * - a constant in one that calls a function exported by the other is evaluated
 * before that function exists, so which domain is imported first decides
 * whether the process starts. That is a `ReferenceError` no test finds until
 * an import order changes, which is why it is a lint rather than a review note.
 *
 * One rule is about the workspace, not an import graph: the Agent SDK's eight
 * per-platform CLI packages (one is 196 MB) are excluded at install, and the
 * shipped binary would carry them if they came back. The pnpm store is read
 * directly, because pnpm links only direct dependencies into `node_modules`.
 *
 * Usage: `bun run scripts/dep-lint.ts [entrypoint]`. The optional entrypoint
 * is what `scripts/dep-lint.test.ts` points at its fixtures.
 */
import { readdir, rm } from "node:fs/promises";
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
  console.error("no DB engine, no plugin host, no web bundle.\n");
  for (const { what, hits } of violations) {
    console.error(`  ${what}:`);
    for (const hit of hits) console.error(`    ${hit}`);
  }
  process.exit(1);
}

console.log(`dep-lint: ${entrypoint} is clean (${graph.length} modules in the graph).`);

/**
 * The controller's domains, as a graph over the folders under `src/`: every
 * file in a domain is that domain, and an import of `../<other>` is an edge
 * from this domain to that one. `db/` and `config/` are infrastructure every
 * domain may reach and are not folded into the check as sources of edges.
 */
const controllerSrc = `${root}apps/controller/src`;

/**
 * Empty where there is no controller to read: `scripts/dep-lint.test.ts` proves
 * the store rules by copying this script into a root of its own, and a rule
 * about a directory that is not there has nothing to say.
 */
const domainsOf = async (): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(controllerSrc, { withFileTypes: true }).catch(() => undefined);
  return entries === undefined
    ? []
    : entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

/**
 * Every shipped `.ts` under a directory. A test and the harness beside it are
 * left out on purpose: they are loaded by vitest, one file at a time, and a
 * suite that drives one domain through another's harness is what a colocated
 * integration test is for. What this rule is about is the order the controller
 * links its own modules in at boot.
 */
const shipped = (name: string): boolean =>
  name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "testing.ts";

const filesUnder = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile() && shipped(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name));

const domains = await domainsOf();

/**
 * `../<domain>` exactly: the domain's index, which is the boundary another
 * domain imports it through and the module whose evaluation order this is
 * about. A deep `../<domain>/<file>` reaches one module and never loads that
 * index, so it is not an edge between the two domains.
 */
const reached = (specifier: string): string | undefined => {
  const match = /^\.\.\/([^/]+)$/.exec(specifier);
  const named = match?.[1];
  return named !== undefined && domains.includes(named) ? named : undefined;
};

const edges = new Map<string, Set<string>>();
for (const domain of domains) {
  const out = new Set<string>();
  for (const file of await filesUnder(resolve(controllerSrc, domain))) {
    const text = await Bun.file(file).text();
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    // `scanImports` drops `import type`, which creates no runtime edge: a type
    // that crosses a domain boundary cannot be evaluated too early.
    for (const record of transpiler.scanImports(text)) {
      const other = reached(record.path);
      if (other !== undefined && other !== domain) out.add(other);
    }
  }
  edges.set(domain, out);
}

/** The first cycle a depth-first walk closes, as the path that closed it. */
const cycleIn = (): ReadonlyArray<string> | undefined => {
  const open = new Set<string>();
  const done = new Set<string>();
  const path: Array<string> = [];
  const walk = (domain: string): ReadonlyArray<string> | undefined => {
    if (open.has(domain)) return [...path.slice(path.indexOf(domain)), domain];
    if (done.has(domain)) return undefined;
    open.add(domain);
    path.push(domain);
    for (const next of edges.get(domain) ?? []) {
      const found = walk(next);
      if (found !== undefined) return found;
    }
    path.pop();
    open.delete(domain);
    done.add(domain);
    return undefined;
  };
  for (const domain of domains) {
    const found = walk(domain);
    if (found !== undefined) return found;
  }
  return undefined;
};

const cycle = domains.length === 0 ? undefined : cycleIn();
if (cycle !== undefined) {
  console.error("dep-lint: the controller's domains import each other in a cycle:");
  console.error(`    ${cycle.join(" -> ")}`);
  console.error(
    "A domain is imported through its index, and a cycle makes a constant in one " +
      "evaluate before the other has defined what it calls: whichever domain is " +
      "imported first decides whether the process starts. Move the shared piece " +
      "into the domain that owns it, or hand it over where both are already held.",
  );
  process.exit(1);
}

if (domains.length > 0) {
  console.log(`dep-lint: the controller's ${String(domains.length)} domains form a DAG.`);
}

const SDK = "@anthropic-ai/claude-agent-sdk";

/** How pnpm names a store directory: the package with its `/` written as `+`. */
const storeName = SDK.replace("/", "+");

const store = await readdir(`${root}node_modules/.pnpm`).catch(() => undefined);
if (store === undefined) {
  console.error("dep-lint: node_modules/.pnpm is not there; run `pnpm install`.");
  process.exit(1);
}

if (!store.some((name) => name.startsWith(`${storeName}@`))) {
  console.error(`dep-lint: ${SDK} is not installed; run \`pnpm install\`.`);
  process.exit(1);
}

const platformPackages = store.filter((name) => name.startsWith(`${storeName}-`));
if (platformPackages.length > 0) {
  console.error(
    `dep-lint: a per-platform CLI package of ${SDK} is installed, so 196 MB of somebody ` +
      "else's CLI is being compiled into the binary Hydra ships:",
  );
  for (const name of platformPackages) console.error(`    ${name}`);
  console.error("They are excluded by `pnpm.ignoredOptionalDependencies` in package.json.");
  process.exit(1);
}

console.log(`dep-lint: ${SDK} is installed with no per-platform CLI package beside it.`);
