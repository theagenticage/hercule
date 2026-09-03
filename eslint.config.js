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

/**
 * A tripwire, not a proof. A transaction never spans a wait on anything outside
 * the database (spec 04, Repository interfaces): SQLite has one writer, so a
 * transaction held across a runner round trip or an HTTP call blocks every
 * other write in the controller. No lint rule can see through an effect, so
 * this catches only the syntactically obvious case - a network call written
 * inside a `withTransaction` callback - and review catches the rest.
 */
const bannedInTransaction = [
  "callee.name='withTransaction'",
  "callee.property.name='withTransaction'",
].map((withTransaction) => ({
  selector: `CallExpression[${withTransaction}] CallExpression[callee.name='fetch']`,
  message:
    "A transaction never spans a wait outside the database (spec 04). Do the network call before or after the write set.",
}));

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "packages/hydra/src/version.ts", "/hydra"],
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
      "no-restricted-syntax": ["error", ...bannedChildProcessCalls, ...bannedInTransaction],
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
        {
          paths: [
            ...bannedEverywhere,
            ...bannedChildProcess,
            {
              name: "effect",
              message:
                "The React codebase writes no Effect code; go through @hydra/contract or @hydra/client-core (spec 14).",
            },
          ],
          patterns: [
            {
              group: ["effect/*"],
              message:
                "The React codebase writes no Effect code; go through @hydra/contract or @hydra/client-core (spec 14).",
            },
          ],
        },
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
