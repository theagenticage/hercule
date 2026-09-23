import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier/flat";

/** Imports banned everywhere, each one encoding a spec or ADR rule. */
const bannedEverywhere = [
  {
    name: "zod",
    message: "Effect Schema is the only schema language in Hercule (ADR 0031).",
  },
  {
    name: "cluster",
    message: "cluster.fork() is broken under `bun build --compile` (spec 15 section 11).",
  },
  {
    name: "node:cluster",
    message: "cluster.fork() is broken under `bun build --compile` (spec 15 section 11).",
  },
];

/**
 * `fork()` is broken under `bun build --compile` (spec 15 section 11), and no
 * import form of it can be banned reliably: a default import reaches it as
 * `cp.fork`. So the module itself is banned, and one file is allowed to use it.
 */
const childProcessMessage =
  "Use spawnHercule() from @hercule/hercule; fork() is broken under `bun build --compile` (spec 15 section 11).";

const bannedChildProcess = ["child_process", "node:child_process"].map((name) => ({
  name,
  message: childProcessMessage,
}));

/** `no-restricted-imports` sees static imports only; these are the other two forms. */
const bannedChildProcessCalls = [
  {
    selector: "ImportExpression[source.value=/^(node:)?child_process$/]",
    message: childProcessMessage,
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?child_process$/]",
    message: childProcessMessage,
  },
];

/** What the browser packages may not import, on top of the bans everywhere. */
const noEffectMessage =
  "The React codebase writes no Effect code; go through @hercule/contract or @hercule/client-core (spec 14).";

const bannedInTheBrowser = [
  ...bannedEverywhere,
  ...bannedChildProcess,
  { name: "effect", message: noEffectMessage },
];

const effectPattern = { group: ["effect/*"], message: noEffectMessage };

/**
 * A `-` file is local to its own folder, so `./-name` is the only way to reach
 * one: the patterns cover every specifier that climbs out of a folder or
 * descends into one to get at it.
 */
const routeLocalPattern = {
  group: ["../**/-*", "./*/**/-*", "**/routes/-*", "**/routes/**/-*"],
  message:
    "A `-` route file is local to its own folder and is imported only as `./-name`. Shared presentation goes in apps/web/src/screens/, generic presentation in @hercule/ui.",
};

/** The shell is the frame; a screen imports presentation, not the frame. */
const shellPattern = {
  group: ["**/shell", "**/shell/*"],
  message:
    "Screens import presentation from @hercule/ui or apps/web/src/screens/, never from the shell.",
};

/** The folder of the workflow editor, the one module that holds its libraries. */
const workflowEditor = "apps/web/src/screens/workflow-editor";

/**
 * The selectors of a dynamic `import()` whose source matches a regular
 * expression: a source written as a string, and a source written as a
 * template literal, whose text before its first `${}` is matched.
 * `no-restricted-imports` sees static imports only, so a fence refuses
 * `import()` with these. A regular expression here writes a slash as `\x2F`,
 * because the selector syntax ends a regular expression at a slash.
 */
const buildImportCalls = (source, message) => [
  { selector: `ImportExpression[source.value=${source}]`, message },
  { selector: `ImportExpression[source.quasis.0.value.raw=${source}]`, message },
];

/**
 * Each library of the workflow editor sits behind a facade of the editor's
 * own, so that it can be replaced there without a change anywhere else. A
 * fence refuses the library's packages everywhere but in its facade, in a
 * static import and in a dynamic `import()` alike.
 */
const fenceLibrary = (scopes, message) => ({
  pattern: { group: scopes.map((scope) => `${scope}/*`), message },
  calls: buildImportCalls(`/^(${scopes.join("|")})\\x2F/`, message),
});
const codeMirrorFence = fenceLibrary(
  ["@codemirror", "@lezer"],
  `The editor library is imported only in ${workflowEditor}/text-editor/, so that it can be replaced there alone. Use the TextEditor of that folder.`,
);
const reactFlowFence = fenceLibrary(
  ["@xyflow"],
  `The graph library is imported only in ${workflowEditor}/graph-view/, so that it can be replaced there alone. Use the GraphView of that folder.`,
);
const dagreFence = fenceLibrary(
  ["@dagrejs"],
  `The layout engine is imported only in ${workflowEditor}/graph-view/layout.ts, so that it can be replaced there alone. Use computeGraphLayout from that file.`,
);
const editorLibraryFences = [codeMirrorFence, reactFlowFence, dagreFence];
const editorLibraryPatterns = editorLibraryFences.map((fence) => fence.pattern);
const editorLibraryCalls = editorLibraryFences.flatMap((fence) => fence.calls);

/** The workflow editor is one module: the rest of the app reaches it through its index only. */
const workflowEditorFenceMessage =
  "The workflow editor is reached through its folder's index only, so its insides can change without a change anywhere else. Import from the folder.";
const workflowEditorFencePattern = {
  group: ["**/workflow-editor/*"],
  message: workflowEditorFenceMessage,
};
const workflowEditorFenceCalls = buildImportCalls(
  "/workflow-editor\\x2F/",
  workflowEditorFenceMessage,
);

/**
 * The web app reads a workflow's YAML only through @hercule/client-core, so a
 * text is parsed once, and the same way the controller parses it.
 */
const yamlMessage =
  "Read a workflow's text with readWorkflowSource from @hercule/client-core, which parses it once and as the controller does.";
const yamlPath = { name: "yaml", message: yamlMessage };
const yamlPattern = { group: ["yaml/*"], message: yamlMessage };
const yamlCalls = buildImportCalls("/^yaml(\\x2F|$)/", yamlMessage);

/**
 * The imports a browser file may not make. `allowed` is the fence of the one
 * library that a facade of the workflow editor may import, and `more` are
 * patterns that only some files are held to.
 */
const browserImports = ({ allowed, more = [] } = {}) => [
  "error",
  {
    paths: [...bannedInTheBrowser, yamlPath],
    patterns: [
      effectPattern,
      routeLocalPattern,
      workflowEditorFencePattern,
      yamlPattern,
      ...editorLibraryFences.filter((fence) => fence !== allowed).map((fence) => fence.pattern),
      ...more,
    ],
  },
];

/** The dynamic imports and calls a browser file may not make, beside `browserImports`. */
const browserSyntax = ({ allowed } = {}) => [
  "error",
  ...bannedChildProcessCalls,
  ...workflowEditorFenceCalls,
  ...yamlCalls,
  ...editorLibraryFences.filter((fence) => fence !== allowed).flatMap((fence) => fence.calls),
];

export default tseslint.config(
  {
    // The generated files are build output that happens to be TypeScript.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      // Agent worktrees are whole copies of this repository.
      ".claude/**",
      // A plan folder is one ticket's local working state, never part of the tree.
      "docs/plans/**",
      "packages/home/src/version.ts",
      "apps/controller/src/http/bundle.ts",
      "apps/web/src/routeTree.gen.ts",
      "apps/runner/src/providers/codex/generated/**",
      "/hercule",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [...bannedEverywhere, ...bannedChildProcess], patterns: editorLibraryPatterns },
      ],
      "no-restricted-syntax": ["error", ...bannedChildProcessCalls, ...editorLibraryCalls],
    },
  },
  {
    // The pre-paint theme script is plain browser JavaScript that no build
    // touches, so it is linted as what it is rather than ignored.
    files: ["apps/web/public/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    extends: [reactHooks.configs.flat["recommended-latest"]],
    rules: {
      // Spec 14: the compiler-aware react-hooks rules are CI-blocking.
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/incompatible-library": "error",
      "react-hooks/unsupported-syntax": "error",
      "no-restricted-imports": browserImports(),
      "no-restricted-syntax": browserSyntax(),
    },
  },
  {
    // A screen composes presentation; it does not reach into the frame around
    // it. Only the two layout routes below mount the shell.
    files: ["apps/web/src/routes/**/*.tsx"],
    rules: {
      "no-restricted-imports": browserImports({ more: [shellPattern] }),
    },
  },
  {
    files: ["apps/web/src/routes/_shell.tsx", "apps/web/src/routes/_shell/settings.tsx"],
    rules: {
      "no-restricted-imports": browserImports(),
    },
  },
  {
    files: [`${workflowEditor}/text-editor/**/*.{ts,tsx}`],
    rules: {
      "no-restricted-imports": browserImports({ allowed: codeMirrorFence }),
      "no-restricted-syntax": browserSyntax({ allowed: codeMirrorFence }),
    },
  },
  {
    files: [`${workflowEditor}/graph-view/**/*.{ts,tsx}`],
    rules: {
      "no-restricted-imports": browserImports({ allowed: reactFlowFence }),
      "no-restricted-syntax": browserSyntax({ allowed: reactFlowFence }),
    },
  },
  {
    files: [`${workflowEditor}/graph-view/layout.ts`],
    rules: {
      "no-restricted-imports": browserImports({ allowed: dagreFence }),
      "no-restricted-syntax": browserSyntax({ allowed: dagreFence }),
    },
  },
  {
    // `spawn()` is the sanctioned way to start another role, and build scripts
    // are tooling that never ships inside the binary.
    files: ["packages/hercule/src/spawn.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: bannedEverywhere, patterns: editorLibraryPatterns },
      ],
      "no-restricted-syntax": ["error", ...editorLibraryCalls],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
