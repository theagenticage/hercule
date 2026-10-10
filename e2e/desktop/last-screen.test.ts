/**
 * Tests that the packaged app, signed in to a real controller, reopens the
 * last screen the user had open when it quit (spec 17, §Native behaviour,
 * **The last screen reopens at launch**):
 *
 * - the Office, then Settings, then a quit reopens the Office, because
 *   Settings is never stored as the last screen.
 *
 * Reopening a thread is tested in `thread.test.ts`.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { readSettings } from "../../apps/desktop/scripts/packaged-app";
import { arrangeFleet, launchForTest, openSignedIn } from "./harness";

describe("the last screen", () => {
  it("reopens the Office at launch when the user opened Settings from the Office and quit", async () => {
    const { url } = await arrangeFleet();
    const first = await openSignedIn(url);
    // The page saves the token without waiting for main, so the test waits
    // for the file: without a token the relaunch would not be signed in.
    await expect.poll(() => readSettings(first.userDataDir)["token"]).toBeTypeOf("string");
    await first.page.getByRole("link", { name: "Office ⌘⇧O" }).click();
    await first.page.locator(".office").waitFor();
    await first.page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
    await first.page.getByRole("navigation", { name: "Settings" }).waitFor();
    await first.close();

    const { page } = await launchForTest(first.userDataDir);

    await page.locator(".office").waitFor();
    expect(await page.getByRole("link", { name: "Office ⌘⇧O" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(await page.getByRole("navigation", { name: "Settings" }).count()).toBe(0);
  });
});
