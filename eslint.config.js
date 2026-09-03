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

const bannedForkImports = [
  {
    name: "child_process",
    importNames: ["fork"],
    message: "Use spawnHydra() from @hydra/hydra; fork() is broken under --compile (spec 15 s11).",
  },
  {
    name: "node:child_process",
    importNames: ["fork"],
    message: "Use spawnHydra() from @hydra/hydra; fork() is broken under --compile (spec 15 s11).",
  },
];

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
      "no-restricted-imports": ["error", { paths: [...bannedEverywhere, ...bannedForkImports] }],
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
            ...bannedForkImports,
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
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
