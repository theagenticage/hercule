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
const bannedChildProcess = ["child_process", "node:child_process"].map((name) => ({
  name,
  message:
    "Use spawnHydra() from @hydra/hydra; fork() is broken under `bun build --compile` (spec 15 section 11).",
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
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
