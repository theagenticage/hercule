/**
 * Tests the workflow list in the packaged app, signed in to a real
 * controller that holds no workflows yet (spec 17 §Workflows): Go ›
 * Workflows opens the list, with its filters and search in the floating
 * header, and the list says it is empty.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { arrangeFleet, chooseMenuItem, openSignedIn } from "./harness";

describe("Workflows", () => {
  it("opens from Go › Workflows, with its filters and search, and says when there are no workflows", async () => {
    const arranged = await arrangeFleet();
    const { app, page } = await openSignedIn(arranged.url);

    await chooseMenuItem(app, "Go", "Workflows");

    const filters = page.getByRole("navigation", { name: "Filter workflows" });
    await filters.getByRole("heading", { level: 1, name: "Workflows" }).waitFor();
    expect(await filters.getByRole("button").allTextContents()).toEqual([
      "All 0",
      "Needs you 0",
      "Failing 0",
      "Running 0",
      "Off 0",
    ]);
    expect(await filters.getByRole("button", { name: "All 0" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await expect.poll(() => page.getByText("No workflows yet").isVisible()).toBe(true);

    await page.keyboard.press("Meta+f");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null))
      .toBe("Search workflows");
  });
});
