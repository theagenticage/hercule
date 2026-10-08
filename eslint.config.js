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
 * `cp.fork`. So the module itself is banned. Role code starts another process
 * only through `packages/hercule/src/spawn.ts`, the one role file allowed to
 * import it. Tooling and test harnesses that never ship inside the binary are
 * exempt; the exemption block below lists them.
 */
const childProcessMessage =
  "Use spawnOwnBinary() from @hercule/hercule; fork() is broken under `bun build --compile` (spec 15 section 11).";

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
    "A `-` route file is local to its own folder and is imported only as `./-name`. Shared presentation goes in the app's screens/ folder, generic presentation in @hercule/ui.",
};

/** The shell is the frame; a screen imports presentation, not the frame. */
const shellPattern = {
  group: ["**/shell", "**/shell/*"],
  message:
    "Screens import presentation from @hercule/ui or the app's screens/ folder, never from the shell. Only a layout route mounts the shell.",
};

/** The folder of the workflow editor, the one module that holds its libraries. */
const workflowEditor = "apps/web/src/screens/workflow-editor";

/**
 * The selectors of a dynamic `import()` whose source matches a regular
 * expression: a source written as a string, and a source written as a
 * template literal, whose text before its first `${}` is matched.
 * `no-restricted-imports` sees static imports only, so a fence also rejects
 * an `import()` that matches these selectors. A regular expression here writes a slash as `\x2F`,
 * because the selector syntax ends a regular expression at a slash.
 */
const buildImportCalls = (source, message) => [
  { selector: `ImportExpression[source.value=${source}]`, message },
  { selector: `ImportExpression[source.quasis.0.value.raw=${source}]`, message },
];

/**
 * Each library of the workflow editor sits behind a facade of the editor's
 * own, so that it can be replaced there without a change anywhere else. A
 * fence rejects an import of the library's packages everywhere but in its facade, in a
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
  "Parse a workflow's text with parseWorkflowSourceWithRanges from @hercule/client-core, which parses it once and as the controller does.";
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

/**
 * The dynamic imports and calls a browser file may not make, beside
 * `browserImports`. `allowed` and `more` work as they do there.
 */
const browserSyntax = ({ allowed, more = [] } = {}) => [
  "error",
  ...bannedChildProcessCalls,
  ...workflowEditorFenceCalls,
  ...yamlCalls,
  ...editorLibraryFences.filter((fence) => fence !== allowed).flatMap((fence) => fence.calls),
  ...more,
];

/**
 * Vite turns these two forms into imports while it builds, so the imports
 * appear in no file's text, and neither eslint nor dep-lint can check what
 * they reach. The desktop app, whose layers dep-lint holds to a list of what
 * each may link, uses neither.
 */
const viteGlobSyntax = {
  selector: "MemberExpression[object.type='MetaProperty'][property.name=/^glob/]",
  message:
    "Vite turns `import.meta.glob` into one import per matching file, which neither eslint nor dep-lint can see, so the desktop app does not use it. Import each file by name.",
};
const viteAssetUrlSyntax = {
  selector:
    "NewExpression[callee.name='URL'][arguments.1.object.type='MetaProperty'][arguments.1.property.name='url']",
  message:
    "Vite turns `new URL(path, import.meta.url)` into an import of that file, which neither eslint nor dep-lint can see, so the desktop renderer does not use it. Import the file with a `?url` suffix instead.",
};

/**
 * The desktop renderer's specimen sheets are a development tool for
 * `pnpm compare:bureau`, served by the dev server alone. A renderer file
 * outside them that imported them would put them in the release app.
 */
const specimensMessage =
  "The specimen sheets are a development tool that never ships, so no renderer file outside specimens/ imports them. Import the component the sheet draws instead.";
const specimensPattern = { group: ["**/specimens", "**/specimens/*"], message: specimensMessage };
/**
 * The desktop renderer's icons folder lists every icon for the specimen
 * sheet and the tests. App code imports each icon from its own module: an
 * icon reached through the list ships with the first screen, even when only a
 * dialog loaded later draws it.
 */
const iconListPattern = {
  // A regular expression rather than a group: a group of `**/icons` would also
  // refuse every module inside the folder, as a `.gitignore` line does.
  regex: "(^|/)icons(/index)?$",
  message:
    "Import each icon from its own module, such as `../icons/plus`. The icons folder's index lists every icon for the specimen sheet and the tests, and an icon reached through it ships with the first screen even when only a dialog loaded later draws it.",
};
const specimensCalls = buildImportCalls("/(^|\\x2F)specimens(\\x2F|$)/", specimensMessage);

/**
 * The desktop renderer draws with React elements only, never with a string
 * of markup, so no text can reach the page as HTML. The selectors refuse
 * every way the DOM offers to parse a string as HTML into the page:
 * - React's `dangerouslySetInnerHTML`;
 * - assigning `innerHTML` or `outerHTML`, by name or as `["innerHTML"]`;
 * - calling `insertAdjacentHTML`, `setHTMLUnsafe` or
 *   `createContextualFragment`, by name or as `["insertAdjacentHTML"]`;
 * - `document.write` and `document.writeln`.
 */
const markupMessage =
  "The desktop renderer never sets markup from a string, so no text can reach the page as HTML. Build the element with JSX.";
const markupProperties = "/^(innerHTML|outerHTML)$/";
const markupMethods = "/^(insertAdjacentHTML|setHTMLUnsafe|createContextualFragment)$/";
const markupSyntax = [
  "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  `AssignmentExpression[left.computed=false][left.property.name=${markupProperties}]`,
  `AssignmentExpression[left.computed=true][left.property.value=${markupProperties}]`,
  `CallExpression[callee.computed=false][callee.property.name=${markupMethods}]`,
  `CallExpression[callee.computed=true][callee.property.value=${markupMethods}]`,
  "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
].map((selector) => ({ selector, message: markupMessage }));
const desktopRendererSyntax = [viteGlobSyntax, viteAssetUrlSyntax, ...specimensCalls];

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
      // The Crew Bureau design book and the two folders its pages link to,
      // copied byte for byte from the design prototype (spec 17). Their
      // scripts are the book's and are never edited here.
      "docs/design/**",
      "packages/home/src/version.ts",
      "apps/controller/src/http/bundle.ts",
      "apps/web/src/routeTree.gen.ts",
      "apps/desktop/src/renderer/routeTree.gen.ts",
      "apps/desktop/out/**",
      "apps/runner/src/providers/codex/generated/**",
      "/hercule",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // Type-aware linting holds the backend's, the UI's and the web app's
      // TypeScript programs in memory at once, which needs more than 2 GB.
      // Node sizes its default heap from the machine's memory, so the lint
      // script sets the heap to 4 GB: without it, lint passes on a developer
      // machine and runs out of memory on a CI runner.
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
      // `import { type X } from "./x"` keeps an import of `./x` after the types
      // are removed, because the repository compiles with verbatimModuleSyntax.
      // `import type { X }` removes the import with them.
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    // The pre-paint theme scripts are plain browser JavaScript that no build
    // touches, so they are linted as what they are rather than ignored.
    files: ["apps/web/public/**/*.js", "apps/desktop/src/renderer/public/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      "apps/web/**/*.{ts,tsx}",
      "packages/ui/**/*.{ts,tsx}",
      "apps/desktop/src/renderer/**/*.{ts,tsx}",
    ],
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
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": browserImports({ more: [specimensPattern, iconListPattern] }),
      "no-restricted-syntax": browserSyntax({ more: [...desktopRendererSyntax, ...markupSyntax] }),
    },
  },
  {
    // The reference sheet, and the Appearance reference's redrawn faces, draw
    // the Bureau book's pieces, which the book's crew.js returns as strings
    // of markup.
    files: [
      "apps/desktop/src/renderer/specimens/reference.ts",
      "apps/desktop/src/renderer/specimens/settings-appearance-reference.ts",
    ],
    rules: {
      "no-restricted-syntax": browserSyntax({ more: desktopRendererSyntax }),
    },
  },
  {
    // The drag-region test reads every stylesheet the window loads, and a
    // glob keeps that list complete as stylesheets are added. No build of
    // the app includes a test, so the glob hides nothing from dep-lint.
    files: ["apps/desktop/src/renderer/app/router.integration.test.tsx"],
    rules: {
      "no-restricted-syntax": browserSyntax({
        more: [viteAssetUrlSyntax, ...specimensCalls, ...markupSyntax],
      }),
    },
  },
  {
    // A screen composes presentation; it does not reach into the frame around
    // it. Only the layout routes below mount the shell.
    files: ["apps/web/src/routes/**/*.tsx"],
    rules: {
      "no-restricted-imports": browserImports({ more: [shellPattern] }),
    },
  },
  {
    // The desktop app's screens keep the specimen ban beside the shell's,
    // because a rule's options here replace the ones above.
    files: ["apps/desktop/src/renderer/routes/**/*.tsx"],
    rules: {
      "no-restricted-imports": browserImports({
        more: [shellPattern, specimensPattern, iconListPattern],
      }),
    },
  },
  {
    files: ["apps/web/src/routes/_shell.tsx", "apps/web/src/routes/_shell/settings.tsx"],
    rules: {
      "no-restricted-imports": browserImports(),
    },
  },
  {
    // The desktop app's layout route mounts the shell, so it may import it,
    // but it keeps the specimen and icon-list bans.
    files: ["apps/desktop/src/renderer/routes/_connected/_shell.tsx"],
    rules: {
      "no-restricted-imports": browserImports({ more: [specimensPattern, iconListPattern] }),
    },
  },
  {
    // The specimen sheets draw every icon, and never ship.
    files: ["apps/desktop/src/renderer/specimens/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": browserImports({ more: [specimensPattern] }),
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
    // The desktop app's Node code: main, and the build tooling around it.
    files: [
      "apps/desktop/src/main/**/*.ts",
      "apps/desktop/scripts/**/*.ts",
      "apps/desktop/vite.*.config.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The desktop app's code outside the renderer. It keeps the rules every
    // file follows, because a rule's options here replace the ones above.
    files: ["apps/desktop/src/{main,preload,ipc}/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...bannedChildProcessCalls,
        ...editorLibraryCalls,
        viteGlobSyntax,
      ],
    },
  },
  {
    // The preload is only the bridge between the window and main: one function
    // per IPC channel, and nothing else (spec 17). It needs `electron` for that,
    // and the IPC contract's types to type each function. Anything more is
    // logic that belongs in main or the renderer.
    files: ["apps/desktop/src/preload/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!electron$|\\.\\./ipc(/|$))",
              message:
                "The preload imports only `electron` and types from ../ipc, because it holds nothing but the bridge (spec 17). Move this code to main or the renderer.",
            },
            {
              regex: "^\\.\\./ipc(/|$)",
              allowTypeImports: true,
              message:
                "The preload uses only the IPC contract's types (spec 17). Write `import type`.",
            },
          ],
        },
      ],
    },
  },
  {
    // `spawn()` is the sanctioned way to start another role. Build scripts,
    // and the test that runs install.sh, are tooling that never ships inside
    // the binary. The desktop end-to-end suite runs on Node, never inside the
    // binary, and starts a second copy of the packaged app itself, because
    // Playwright cannot start one that exits at once.
    files: [
      "packages/hercule/src/spawn.ts",
      "scripts/**/*.ts",
      "install.test.ts",
      "apps/desktop/scripts/**/*.ts",
      "e2e/desktop/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: bannedEverywhere, patterns: editorLibraryPatterns },
      ],
      "no-restricted-syntax": ["error", ...editorLibraryCalls],
    },
  },
  {
    // The desktop app's main process runs on Electron's Node, never inside the
    // compiled binary, so the binary's broken `fork()` cannot reach it.
    // `run-program.ts` is the one file in main that starts programs: the
    // installed Hercule binary, the user's login shell, and git.
    files: ["apps/desktop/src/main/run-program.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: bannedEverywhere, patterns: editorLibraryPatterns },
      ],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
