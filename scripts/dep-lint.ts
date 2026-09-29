#!/usr/bin/env bun
/**
 * Enforces what each entrypoint may link: the runner's mode isolation (spec
 * 15 section 3, ADR 0018), and the import rules of the desktop app's three
 * layers (spec 17, Package). `ENTRYPOINT_RULES` below lists every rule.
 *
 * The runner entrypoint's module graph MUST NOT include any controller
 * package: no DB engine, no plugin host, no web bundle. Each layer of the
 * desktop app links no first-party code but its own and, where allowed,
 * @hercule/contract and @hercule/client-core; each layer also has a list of
 * things it must not link.
 *
 * Isolation is a property of the import graph per entrypoint, not of the file
 * on disk. So this script builds each entrypoint with Bun and reads the
 * build's metafile: every file the build resolved, stylesheets and fonts
 * included, and every import between them. A rule is decided on the files an
 * import resolves to, never on how the import is spelled: a package name, a
 * relative path and an absolute path that reach one file are one edge.
 *
 * Some imports never reach the graph:
 *
 * - a specifier built at runtime, such as `await import("bun" + ":sqlite")`;
 * - Bun's `import.meta.require`, which the metafile does not record;
 * - Vite's `import.meta.glob`, and `new URL(path, import.meta.url)` in the
 *   renderer, which Vite turns into imports while it builds. eslint refuses
 *   both in the desktop app.
 *
 * Nothing in the codebase does the first two, and no scan short of running
 * the code could catch them.
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
 * Usage: `bun run scripts/dep-lint.ts [<layer> <entrypoint>]`. With no
 * arguments, every rule is checked against its own entrypoint. With a layer,
 * such as `"desktop renderer"`, only that layer's rule is checked, and it is
 * checked against the given file instead. `scripts/dep-lint.test.ts` uses
 * this to point a rule at its fixtures.
 */
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));

/** One thing an entrypoint must not link. */
interface Forbidden {
  /** What the pattern stands for, as the error message names it. */
  readonly what: string;
  /**
   * Matched against a file's path from the repository root, and against an
   * external import as it is written, such as `bun:sqlite`. A first-party
   * plugin is `plugins/...`, while a dependency that happens to ship a
   * `plugins/` directory is under `node_modules/` and does not match.
   */
  readonly pattern: RegExp;
}

/**
 * The first-party code a layer may reach. First-party code is every file
 * outside a `node_modules` folder: this repository's source, or a test
 * fixture.
 */
interface FirstPartyAllowlist {
  /** The layer's own folders, relative to the folder of its entrypoint. */
  readonly own: ReadonlyArray<string>;
  /**
   * The workspace packages the layer may import, by their folder name under
   * `packages/`. What such a package imports in turn is allowed too, because
   * it is the package's dependency and not the layer's. The same file
   * reached from the layer by any other path is not.
   */
  readonly packages: ReadonlyArray<string>;
}

/** The rule one entrypoint's module graph must follow. */
interface EntrypointRule {
  /** The layer the entrypoint starts. The error message and the command line name the rule by it. */
  readonly layer: string;
  /** The entrypoint's path from the repository root. */
  readonly entrypoint: string;
  /**
   * Where the layer runs. Bun resolves each dependency's export conditions
   * for this target, so the graph read here is the one the layer runs.
   */
  readonly target: "bun" | "browser" | "node";
  /**
   * The bundler that builds the layer for real. The check always builds with
   * Bun; for a layer that Vite builds, `readImportsLikeVite` makes Bun read
   * the imports that Vite would link.
   */
  readonly bundler: "bun" | "vite";
  /** Why the layer must not link what the rule refuses. The error message prints it above the violations. */
  readonly reason: string;
  /**
   * When set, the only first-party code the layer may reach. `forbidden` is
   * then matched against third-party files and external imports only.
   */
  readonly firstParty?: FirstPartyAllowlist;
  /** Matched against every module the layer reaches that `firstParty` does not decide on. */
  readonly forbidden: ReadonlyArray<Forbidden>;
}

/** Why no layer of the desktop app links first-party code but what its rule allows. */
const DESKTOP_PACKAGES_REASON =
  "The desktop app links no first-party code but each layer's own files and, where the layer\n" +
  "allows them, @hercule/contract and @hercule/client-core (spec 17, Package). What\n" +
  "@hercule/protocol and @hercule/plugin-host define is imported through @hercule/contract,\n" +
  "which re-exports what a client needs; neither one belongs in apps/desktop/package.json.";

/** The workspace packages a client of the public API may import (spec 17, Package). */
const CLIENT_PACKAGES = ["contract", "client-core"];

/**
 * Matches a built-in module of the runtime, with or without the `node:`
 * prefix, and with a subpath such as `fs/promises`. The list comes from Bun,
 * which runs this script, so it also holds Bun's own `bun:` modules.
 */
const RUNTIME_BUILT_IN = new RegExp(`^(node:.*|(${builtinModules.join("|")})(/.*)?)$`);

const ENTRYPOINT_RULES: ReadonlyArray<EntrypointRule> = [
  {
    layer: "runner",
    entrypoint: "apps/runner/src/index.ts",
    target: "bun",
    bundler: "bun",
    reason:
      "The runner entrypoint's module graph must contain no controller package:\n" +
      "no DB engine, no plugin host, no web bundle.",
    forbidden: [
      { what: "the DB engine", pattern: /@effect[/+]sql|^bun:sqlite$/ },
      {
        what: "the plugin host",
        pattern: /^apps\/controller\/|@hercule[/+]controller|^plugins\//,
      },
      {
        what: "the web bundle",
        pattern:
          /^apps\/web\/|^packages\/ui\/|@hercule[/+]ui|(^|\/)react(-dom)?([/@]|$)|\.(html|css)$/,
      },
    ],
  },
  {
    layer: "desktop main",
    entrypoint: "apps/desktop/src/main/index.ts",
    target: "node",
    bundler: "vite",
    reason:
      "Desktop main runs in Electron's browser process and draws nothing, so it never imports React.\n" +
      DESKTOP_PACKAGES_REASON,
    // Main decodes every IPC message, so the IPC contract's folder is main's own.
    firstParty: { own: [".", "../ipc"], packages: CLIENT_PACKAGES },
    forbidden: [{ what: "React", pattern: /(^|\/)react(-dom)?([/@]|$)/ }],
  },
  {
    layer: "desktop preload",
    entrypoint: "apps/desktop/src/preload/index.ts",
    target: "node",
    bundler: "vite",
    reason:
      "The desktop preload is the bridge and nothing else, so at runtime it links its own files\n" +
      "and electron alone. Types are free, such as the IPC contract's, when they are imported\n" +
      "with `import type`.\n" +
      DESKTOP_PACKAGES_REASON,
    firstParty: { own: ["."], packages: [] },
    forbidden: [{ what: "anything but electron", pattern: /^(?!electron$)/ }],
  },
  {
    layer: "desktop renderer",
    entrypoint: "apps/desktop/src/renderer/main.tsx",
    target: "browser",
    bundler: "vite",
    reason:
      "The desktop renderer is a sandboxed web page, so it never imports electron or a Node built-in.\n" +
      DESKTOP_PACKAGES_REASON,
    firstParty: { own: ["."], packages: CLIENT_PACKAGES },
    forbidden: [
      { what: "electron", pattern: /^electron(\/|$)/ },
      { what: "a Node or Bun built-in", pattern: RUNTIME_BUILT_IN },
    ],
  },
];

const [onlyLayer, onlyEntrypoint] = process.argv.slice(2);
const rules =
  onlyLayer === undefined
    ? ENTRYPOINT_RULES
    : ENTRYPOINT_RULES.filter((rule) => rule.layer === onlyLayer);

if (rules.length === 0 || (onlyLayer !== undefined && onlyEntrypoint === undefined)) {
  console.error(
    "dep-lint: usage: bun run scripts/dep-lint.ts [<layer> <entrypoint>], where <layer> is one of " +
      `${ENTRYPOINT_RULES.map((rule) => `"${rule.layer}"`).join(", ")}.`,
  );
  process.exit(1);
}

/**
 * Makes Bun read a layer's imports the way Vite does when it builds the
 * layer, so that the graph holds what Vite would link:
 *
 * - An import whose names are all types, such as `import { type X } from
 *   "./x"`, stays as an import of `./x`, as it does in Vite, because the
 *   repository compiles with `verbatimModuleSyntax` (tsconfig.base.json). Bun
 *   would drop such an import, so TypeScript removes the types here instead,
 *   with that setting. Only `import type` removes the import as well.
 * - A query such as Vite's `?url` or `?raw` is dropped, and the file is
 *   resolved without it, so the file is in the graph whatever Vite makes of it.
 * - An absolute path in a stylesheet, such as `url(/fonts/a.woff2)`, names a
 *   file the page's server serves from its public folder. It stays external,
 *   unless a file exists at that path on disk, which Vite would inline.
 */
const readImportsLikeVite: BunPlugin = {
  name: "read imports like Vite",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, async ({ path }) => {
      const { outputText } = ts.transpileModule(await Bun.file(path).text(), {
        fileName: path,
        compilerOptions: {
          verbatimModuleSyntax: true,
          module: ts.ModuleKind.Preserve,
          target: ts.ScriptTarget.ESNext,
          jsx: ts.JsxEmit.Preserve,
        },
      });
      return { contents: outputText, loader: path.endsWith("x") ? "jsx" : "js" };
    });
    build.onResolve({ filter: /\?/ }, ({ path, importer }) => ({
      path: Bun.resolveSync(path.replace(/\?.*$/, ""), dirname(importer)),
    }));
    build.onResolve({ filter: /^\// }, ({ path, importer }) =>
      importer.endsWith(".css") && !existsSync(path) ? { path, external: true } : undefined,
    );
  },
};

/**
 * Keeps runtime built-ins external for the browser target. There Bun
 * replaces `path` or `events` with its own copy, and `node:fs` with an empty
 * object, so the import would vanish from the graph. The other targets keep
 * built-ins external already.
 */
const keepBuiltInsExternal: BunPlugin = {
  name: "keep built-ins external",
  setup(build) {
    build.onResolve({ filter: RUNTIME_BUILT_IN }, ({ path }) => ({ path, external: true }));
  },
};

// Each run builds into a folder of its own, so two runs at once, such as two
// test suites in one worktree, never delete each other's output.
const outdir = await mkdtemp(join(tmpdir(), "hercule-dep-lint-"));
process.on("exit", () => rmSync(outdir, { recursive: true, force: true }));

/**
 * One import in an entrypoint's graph. `from` is the absolute path of the
 * file the import is written in. `to` is the absolute path of the file it
 * resolves to, or, for an external import, the import as written.
 */
interface Edge {
  readonly from: string;
  readonly to: string;
  readonly external: boolean;
  /** The import as it is written in `from`. */
  readonly written: string;
}

/** Checks whether a file is third-party code, which is any file inside a `node_modules` folder. */
const isThirdParty = (file: string): boolean => file.split(sep).includes("node_modules");

/**
 * Returns the name a rule's pattern is matched against: a file's path from
 * the repository root, or an external import as written.
 */
const nameImportTarget = (edge: Edge): string =>
  edge.external ? edge.to : relative(root, edge.to);

/** Returns how the error message shows a file: from the repository root when it is inside it. */
const describeFile = (file: string): string =>
  relative(root, file).startsWith("..") ? file : relative(root, file);

/** Returns how the error message shows one import: the file, what it imports, and where that resolved. */
const describeEdge = (edge: Edge): string =>
  `${describeFile(edge.from)} imports "${edge.written}"` +
  (edge.external ? "" : ` (${describeFile(edge.to)})`);

/** The files a layer reaches, and the imports its rule refuses on the way. */
interface Trace {
  /** Every file the walk reached, starting with the entrypoint. */
  readonly reached: ReadonlySet<string>;
  /** Each import of the layer's own code into first-party code its rule does not allow. */
  readonly refused: ReadonlyArray<Edge>;
}

/**
 * Follows the imports from the entrypoint, and returns the files the layer
 * reaches and the imports its first-party allowlist refuses. With no
 * allowlist, every import is followed and none is refused.
 *
 * Only an import written in the layer's own code is held to the allowlist:
 * what an allowed package or a dependency imports in turn is its business,
 * not the layer's. So a file reached through @hercule/contract is allowed,
 * and the same file imported by the layer itself is refused. The walk does
 * not follow a refused import, because what lies past it would bury the one
 * import to fix.
 */
const traceEntrypoint = (
  entry: string,
  edges: ReadonlyArray<Edge>,
  allowlist: FirstPartyAllowlist | undefined,
): Trace => {
  const own = (allowlist?.own ?? []).map((folder) => join(resolve(dirname(entry), folder), sep));
  const packages = (allowlist?.packages ?? []).map((name) => join(root, "packages", name, sep));
  const isOwn = (file: string): boolean => own.some((folder) => file.startsWith(folder));
  const isAllowed = (file: string): boolean =>
    isThirdParty(file) || isOwn(file) || packages.some((folder) => file.startsWith(folder));

  const importsByFile = new Map<string, Array<Edge>>();
  for (const edge of edges) {
    const imports = importsByFile.get(edge.from) ?? [];
    imports.push(edge);
    importsByFile.set(edge.from, imports);
  }

  const refused: Array<Edge> = [];
  const reached = new Set([entry]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const edge of importsByFile.get(file) ?? []) {
      if (edge.external) continue;
      // Checked before `reached`: a file the layer may reach through an
      // allowed package is still refused when the layer imports it itself.
      if (allowlist !== undefined && isOwn(file) && !isAllowed(edge.to)) {
        refused.push(edge);
        continue;
      }
      if (reached.has(edge.to)) continue;
      reached.add(edge.to);
      queue.push(edge.to);
    }
  }
  return { reached, refused };
};

/**
 * Checks one entrypoint's module graph against its rule and prints the
 * result. Returns false when the entrypoint does not exist, does not build,
 * or links something the rule refuses.
 *
 * A missing entrypoint fails rather than passing: a rule whose file was
 * renamed would otherwise check nothing, and nobody would notice.
 */
const checkEntrypoint = async (rule: EntrypointRule, entrypoint: string): Promise<boolean> => {
  // The metafile names every file by its real path, and the entry is found
  // among them by that path.
  const entry = await realpath(resolve(root, entrypoint)).catch(() => undefined);
  if (entry === undefined) {
    console.error(
      `dep-lint: the ${rule.layer} entrypoint ${entrypoint} does not exist. A rule whose entrypoint ` +
        "is gone would check nothing, so it fails instead. Point the rule in scripts/dep-lint.ts " +
        "at the file that replaced it.",
    );
    return false;
  }

  const built = await Bun.build({
    entrypoints: [entry],
    target: rule.target,
    outdir: join(outdir, rule.layer),
    metafile: true,
    // Inside Electron, `electron` is the API built into the binary. The npm
    // package of that name only locates the binary and is never linked.
    external: ["electron"],
    plugins: [
      ...(rule.bundler === "vite" ? [readImportsLikeVite] : []),
      ...(rule.target === "browser" ? [keepBuiltInsExternal] : []),
    ],
    throw: false,
  });

  if (!built.success || built.metafile === undefined) {
    console.error(`dep-lint: could not build ${entrypoint}`);
    for (const log of built.logs) console.error(" ", log.message);
    return false;
  }

  // The metafile writes a file's path relative to the working directory, and
  // an external import as the import was written.
  const edges: ReadonlyArray<Edge> = Object.entries(built.metafile.inputs).flatMap(
    ([from, input]) =>
      input.imports.map((record) => ({
        from: resolve(from),
        to: record.external === true ? (record.original ?? record.path) : resolve(record.path),
        external: record.external === true,
        written: record.original ?? record.path,
      })),
  );

  const { firstParty } = rule;
  const { reached, refused } = traceEntrypoint(entry, edges, firstParty);
  // With an allowlist, first-party code is judged by the allowlist alone.
  const isJudgedByPatterns = (file: string): boolean =>
    firstParty === undefined || isThirdParty(file);
  const allowed = [
    "its own files",
    ...(firstParty?.packages ?? []).map((name) => `@hercule/${name}`),
  ];
  // An import is reported where it enters what a pattern forbids: from a
  // module the pattern does not match. What the forbidden module imports in
  // turn is its own business, and listing it would bury the one import to fix.
  const violations = [
    { what: `first-party code other than ${allowed.join(", ")}`, hits: refused },
    ...rule.forbidden.map(({ what, pattern }) => ({
      what,
      hits: edges.filter(
        (edge) =>
          reached.has(edge.from) &&
          (edge.external || isJudgedByPatterns(edge.to)) &&
          pattern.test(nameImportTarget(edge)) &&
          !(isJudgedByPatterns(edge.from) && pattern.test(relative(root, edge.from))),
      ),
    })),
  ].filter(({ hits }) => hits.length > 0);

  if (violations.length > 0) {
    console.error(`dep-lint: ${entrypoint} links what the ${rule.layer} must not link.`);
    console.error(`${rule.reason}\n`);
    for (const { what, hits } of violations) {
      console.error(`  ${what}:`);
      for (const hit of new Set(hits.map(describeEdge))) console.error(`    ${hit}`);
    }
    return false;
  }

  const modules = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  console.log(`dep-lint: ${entrypoint} is clean (${modules.size} modules in the graph).`);
  return true;
};

let entrypointsPass = true;
for (const rule of rules) {
  if (!(await checkEntrypoint(rule, onlyEntrypoint ?? rule.entrypoint))) entrypointsPass = false;
}
if (!entrypointsPass) process.exit(1);

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
