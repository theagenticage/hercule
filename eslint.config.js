import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier/flat";

/** Imports banned everywhere, each one encoding a spec or ADR rule. */
const bannedEverywhere = [
  {
    name: "zod",
    message: "Effect Schema is the only schema language in Hydra (ADR 0031).",
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
  "Use spawnHydra() from @hydra/hydra; fork() is broken under `bun build --compile` (spec 15 section 11).";

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
  "The React codebase writes no Effect code; go through @hydra/contract or @hydra/client-core (spec 14).";

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
    "A `-` route file is local to its own folder and is imported only as `./-name`. Shared presentation goes in apps/web/src/screens/, generic presentation in @hydra/ui.",
};

/** The shell is the frame; a screen imports presentation, not the frame. */
const shellPattern = {
  group: ["**/shell", "**/shell/*"],
  message:
    "Screens import presentation from @hydra/ui or apps/web/src/screens/, never from the shell.",
};

export default tseslint.config(
  {
    // The generated files are build output that happens to be TypeScript.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/home/src/version.ts",
      "apps/controller/src/http/bundle.ts",
      "apps/web/src/routeTree.gen.ts",
      "/hydra",
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
      "no-restricted-imports": ["error", { paths: [...bannedEverywhere, ...bannedChildProcess] }],
      "no-restricted-syntax": ["error", ...bannedChildProcessCalls],
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
      "no-restricted-imports": [
        "error",
        { paths: bannedInTheBrowser, patterns: [effectPattern, routeLocalPattern] },
      ],
    },
  },
  {
    // A screen composes presentation; it does not reach into the frame around
    // it. Only the two layout routes below mount the shell.
    files: ["apps/web/src/routes/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: bannedInTheBrowser, patterns: [effectPattern, routeLocalPattern, shellPattern] },
      ],
    },
  },
  {
    files: ["apps/web/src/routes/_shell.tsx", "apps/web/src/routes/_shell/settings.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: bannedInTheBrowser, patterns: [effectPattern, routeLocalPattern] },
      ],
    },
  },
  {
    // `spawn()` is the sanctioned way to start another role, and build scripts
    // are tooling that never ships inside the binary.
    files: ["packages/hydra/src/spawn.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: bannedEverywhere }],
      "no-restricted-syntax": "off",
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
