import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["{apps/controller,apps/runner,packages/*}/src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "react",
          environment: "jsdom",
          include: ["{apps/web,packages/ui}/src/**/*.test.tsx"],
        },
      },
    ],
  },
});
