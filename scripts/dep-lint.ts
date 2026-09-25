#!/usr/bin/env bun
/**
 * Enforces mode isolation (spec 15 section 3, ADR 0018).
 *
 * The runner entrypoint's module graph MUST NOT include any controller
 * package: no DB engine, no plugin host, no web bundle. Isolation is a
 * property of the import graph per entrypoint, not of the file on disk, so
 * this script reads the graph Bun actually links: `--sourcemap=external` emits
 * a map whose `sources` array is the module list after tree shaking. Bun has no
 * `--metafile`.
 *
 * The rule reads specifiers, so it cannot see a specifier built at runtime
 * (`await import("bun" + ":sqlite")`). Nothing in the codebase does that, and
 * no scan short of running the code could catch it.
 *
 * A second graph rule is about the controller rather than the runner: its
 * domains form a DAG, with no allowlist of edges. `src/<domain>/index.ts` is
 * the boundary a domain is imported through. A cycle between two domains is
 * more than a design smell: a constant in one that calls a function exported
 * by the other is evaluated before that function exists, so which domain is
 * imported first decides whether the process starts. That is a
 * `ReferenceError` no test finds until an import order changes, which is why
 * it is a lint rather than a review note.
 *
 * A domain may import another, to read or to write, as long as the graph
 * stays acyclic. `src/daemon/`, the controller daemon, is the layer above the
 * domains: it holds the wire to runners, the execution behind the ports
 * domains declare, the drivers and boot, and the ports that break a cycle
 * between two domains. Only `http/` imports it; no domain may.
 * Inside it, the same two rules hold one level down: its folders form a DAG,
 * and one folder reaches another only through that folder's `index.ts`.
 *
 * One rule is about the workspace, not an import graph: the Agent SDK's eight
 * per-platform CLI packages (one is 196 MB) are excluded at install, and the
 * shipped binary would include them if they were installed again. The pnpm
 * store is read directly, because pnpm links only direct dependencies into
 * `node_modules`.
 *
 * Usage: `bun run scripts/dep-lint.ts [entrypoint]`. `scripts/dep-lint.test.ts`
 * uses the optional entrypoint to point the script at its fixtures.
 */
import { readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entrypoint = process.argv[2] ?? "apps/runner/src/index.ts";

/**
 * Each rule describes what it forbids in `what`, which the CI output prints.
 * Patterns are matched against repository-relative paths and bare specifiers,
 * so a first-party plugin is `plugins/...` while a dependency that happens to
 * ship a `plugins/` directory is under `node_modules/` and does not match.
 */
const FORBIDDEN = [
  { what: "the DB engine", pattern: /@effect[/+]sql|^bun:sqlite$/ },
  {
    what: "the plugin host",
    pattern: /^apps\/controller\/|@hercule[/+]controller|^plugins\//,
  },
  {
    what: "the web bundle",
    pattern: /^apps\/web\/|^packages\/ui\/|@hercule[/+]ui|(^|\/)react(-dom)?([/@]|$)|\.(html|css)$/,
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
 * A specifier the bundler leaves external, above all `bun:sqlite`, never
 * appears in `sources`, and Bun removes a bare `import "bun:sqlite"`
 * entirely. So the script also reads the imports of our own linked sources,
 * parsed rather than pattern-matched: `scanImports` ignores comments and
 * string literals, and drops `import type`, which creates no runtime edge and
 * so is not a violation.
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
 * A second check: third-party sources are not scanned above, because their
 * own dead branches are not this repository's violations. The emitted bundle
 * still contains every external they import, so it is scanned for every
 * specifier form.
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
 * file in a domain is that domain, at any depth, and an import that resolves
 * to `src/<other>` is an edge from this domain to that one. `db/` and `config/` are infrastructure every
 * domain may import, and the check does not treat them as sources of edges.
 * `daemon/` is a node like any other here. No separate rule stops a domain
 * from importing it; such an import is caught only when it closes a cycle.
 */
const controllerSrc = `${root}apps/controller/src`;

/**
 * Lists the folders directly inside `dir`. Returns an empty list when `dir`
 * does not exist: `scripts/dep-lint.test.ts` tests the store rules by copying
 * this script into a root of its own, and a rule about a missing directory
 * has nothing to check.
 */
const listFolders = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
  return entries === undefined
    ? []
    : entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

/**
 * Checks whether a file is shipped code: a `.ts` file that is not a test or a
 * test harness. Tests and harnesses are left out on purpose: vitest loads them
 * one file at a time, and driving one domain through another's harness is
 * what a colocated integration test is for. This rule is about the order in
 * which the controller loads its own modules at boot.
 */
const isShipped = (name: string): boolean =>
  name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "testing.ts";

const listShippedFiles = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile() && isShipped(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name));

const domains = await listFolders(controllerSrc);

/**
 * Returns the domain an import in `file` reaches, when the specifier resolves
 * to `src/<domain>`: the domain's index, which is the boundary other domains
 * import it through, and the module whose evaluation order matters here. A
 * deep `<domain>/<file>` reaches one module and never loads that index, so it
 * is not an edge between the two domains.
 *
 * The specifier is resolved against the importing file rather than read as
 * text, because a file one folder down, such as `daemon/sessions/placement.ts`,
 * reaches the sessions domain as `../../sessions`, while its own `../sessions`
 * is a folder inside the controller daemon and no domain at all.
 */
const findReachedDomain = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const reached = relative(controllerSrc, resolve(dirname(file), specifier));
  return domains.includes(reached) ? reached : undefined;
};

const edges = new Map<string, Set<string>>();
for (const domain of domains) {
  const out = new Set<string>();
  for (const file of await listShippedFiles(resolve(controllerSrc, domain))) {
    const text = await Bun.file(file).text();
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    // `scanImports` drops `import type`, which creates no runtime edge: a type
    // that crosses a domain boundary cannot be evaluated too early.
    for (const record of transpiler.scanImports(text)) {
      const other = findReachedDomain(file, record.path);
      if (other !== undefined && other !== domain) out.add(other);
    }
  }
  edges.set(domain, out);
}

/**
 * Returns the first cycle a depth-first search of `edges` finds, as the path
 * around it, or `undefined` when there is none.
 */
const findCycle = (
  nodes: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<string> | undefined => {
  const open = new Set<string>();
  const done = new Set<string>();
  const path: Array<string> = [];
  const walk = (node: string): ReadonlyArray<string> | undefined => {
    if (open.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (done.has(node)) return undefined;
    open.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = walk(next);
      if (found !== undefined) return found;
    }
    path.pop();
    open.delete(node);
    done.add(node);
    return undefined;
  };
  for (const node of nodes) {
    const found = walk(node);
    if (found !== undefined) return found;
  }
  return undefined;
};

const cycle = domains.length === 0 ? undefined : findCycle(domains, edges);
if (cycle !== undefined) {
  console.error("dep-lint: the controller's domains import each other in a cycle:");
  console.error(`    ${cycle.join(" -> ")}`);
  console.error(
    "A domain is imported through its index, and a cycle makes a constant in one " +
      "evaluate before the other has defined what it calls: whichever domain is " +
      "imported first decides whether the process starts. Move the shared piece " +
      "into the domain that owns it, or pass it in from the controller daemon, which may import both.",
  );
  process.exit(1);
}

if (domains.length > 0) {
  console.log(`dep-lint: the controller's ${String(domains.length)} domains form a DAG.`);
}

/**
 * The controller daemon's own graph. The domain graph above treats `daemon/`
 * as one node, so it cannot see how the daemon's folders use each other. Here
 * each folder of `daemon/` is a node, and so is each file at its top level.
 * The top level is not one node, because `index.ts` imports every folder and
 * every folder imports `absorbing.ts`: one node for both would be a cycle by
 * construction.
 *
 * Two rules hold (ADR 0033, amendment of 2026-09-24):
 *
 * - the nodes form a DAG, for the same reason the domains do;
 * - a file reaches another folder only through that folder's `index.ts`,
 *   which is the folder's boundary.
 *
 * Like the domain graph, this one reads runtime imports only: `scanImports`
 * drops `import type`.
 */
const daemonSrc = resolve(controllerSrc, "daemon");

const daemonFolders = await listFolders(daemonSrc);

/**
 * Returns the node of the controller daemon that a path inside `daemon/`
 * belongs to: `<folder>/` for anything in a folder, or `<name>.ts` for a file
 * at the top level. The path is a file, or an import specifier resolved
 * against its file, which has no extension.
 */
const findDaemonNode = (path: string): string => {
  const [first = ""] = relative(daemonSrc, path).split(sep);
  return daemonFolders.includes(first) ? `${first}/` : `${first.replace(/\.ts$/, "")}.ts`;
};

const daemonEdges = new Map<string, Set<string>>();
const deepImports: Array<string> = [];
for (const file of daemonFolders.length === 0 ? [] : await listShippedFiles(daemonSrc)) {
  const from = findDaemonNode(file);
  const out = daemonEdges.get(from) ?? new Set<string>();
  daemonEdges.set(from, out);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const record of transpiler.scanImports(await Bun.file(file).text())) {
    if (!record.path.startsWith(".")) continue;
    const reached = resolve(dirname(file), record.path);
    const inside = relative(daemonSrc, reached);
    if (inside.startsWith("..")) continue;
    const to = findDaemonNode(reached);
    if (to === from) continue;
    out.add(to);
    const folder = to.slice(0, -1);
    if (to.endsWith("/") && inside !== folder && inside !== join(folder, "index")) {
      deepImports.push(`${relative(daemonSrc, file)} imports "${record.path}"`);
    }
  }
}

const daemonCycle = findCycle([...daemonEdges.keys()], daemonEdges);
if (daemonCycle !== undefined) {
  console.error("dep-lint: the controller daemon's folders import each other in a cycle:");
  console.error(`    ${daemonCycle.join(" -> ")}`);
  console.error(
    "A folder of the controller daemon is imported through its index, so a cycle between " +
      "two folders has the same load-order hazard as one between domains. Move the shared " +
      "piece into the folder that owns it, or into a top-level file both may import.",
  );
  process.exit(1);
}

if (deepImports.length > 0) {
  console.error("dep-lint: a file of the controller daemon reaches past another folder's index:");
  for (const deep of deepImports) console.error(`    ${deep}`);
  console.error(
    "A folder's index.ts is its boundary. Import the folder itself, such as " +
      '"../sessions", and export what is needed from its index.ts.',
  );
  process.exit(1);
}

if (daemonFolders.length > 0) {
  console.log(
    `dep-lint: the controller daemon's ${String(daemonFolders.length)} folders form a DAG ` +
      "and are imported through their index.",
  );
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
      "else's CLI is being compiled into the binary Hercule ships:",
  );
  for (const name of platformPackages) console.error(`    ${name}`);
  console.error("They are excluded by `pnpm.ignoredOptionalDependencies` in package.json.");
  process.exit(1);
}

console.log(`dep-lint: ${SDK} is installed with no per-platform CLI package beside it.`);
