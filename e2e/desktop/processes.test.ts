/**
 * Tests how many processes the desktop app runs. Spec 17 (§Performance,
 * §Measuring) budgets four, and makes CI check the count because, unlike
 * memory and wakeups, it does not depend on the machine.
 *
 * Run `pnpm build:desktop` first.
 */
import { describe, expect, it } from "vitest";
import { launchForTest } from "./harness";

describe("the app's processes", () => {
  it("are the four of the budget: main, the GPU process, the network service and the renderer", async () => {
    const { app } = await launchForTest();

    // Each process is listed by its type, with the service it runs when it
    // has one.
    const listProcesses = () =>
      app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .map((metric) =>
            metric.name === undefined ? metric.type : `${metric.type} (${metric.name})`,
          )
          .sort(),
      );
    await expect
      .poll(listProcesses)
      .toEqual(["Browser", "GPU", "Tab", "Utility (Network Service)"]);
  });
});
