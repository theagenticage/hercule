import { defineConfig } from "vitest/config";

/** The two React packages; everything else is a plain node project. */
const reactPackages = ["apps/web", "packages/ui"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/dist/**", ...reactPackages.map((p) => `${p}/**`)],
        },
      },
      {
        test: {
          name: "react",
          environment: "jsdom",
          // Testing Library registers its auto-cleanup only when a global
          // `afterEach` exists, so without this a second render in one file
          // sees the first one still mounted.
          globals: true,
          setupFiles: ["packages/ui/src/test-setup.ts"],
          include: reactPackages.map((p) => `${p}/src/**/*.test.{ts,tsx}`),
        },
      },
    ],
  },
});
