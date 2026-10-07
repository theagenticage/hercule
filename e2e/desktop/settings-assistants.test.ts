/**
 * Tests Settings > Assistants in the packaged app, signed in to a real
 * controller (spec 17 §Settings, Assistants). One test walks the section as
 * a user does, and checks each save through the API:
 *
 * - New assistant creates an assistant and picks its tab;
 * - the Name field saves when it loses focus, and the tab shows the new name;
 * - a name as long as the contract allows ends in an ellipsis on its tab, and
 *   nothing in the section scrolls sideways;
 * - the heartbeat's switch turns it off, and the interval saves a new
 *   schedule;
 * - a disallowed tool is added from Add and removed with its ×;
 * - Delete… asks in a dialog first, and the assistant is gone once the dialog
 *   confirms.
 *
 * A new assistant's heartbeat is on and beats every hour. The test turns it
 * off before anything else changes, so no heartbeat starts a session while
 * it runs. No runner can take a session anyway: the harness retires the
 * controller's own runner.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { Assistant } from "../../packages/contract/src/index";
import type { HerculeClient } from "../../packages/client-core/src/index";
import { arrangeFleet, openSignedIn } from "./harness";

/** Returns the assistant with id `id`, read through the API, or undefined once it is deleted. */
async function readAssistantById(
  client: HerculeClient,
  id: string,
): Promise<Assistant | undefined> {
  const { items } = await client.assistant.query({ query: { limit: 50 } });
  return items.find((assistant) => assistant.id === id);
}

/** Returns the ids of every assistant, read through the API. */
async function readAssistantIds(client: HerculeClient): Promise<string[]> {
  const { items } = await client.assistant.query({ query: { limit: 50 } });
  return items.map((assistant) => assistant.id);
}

/** Returns the name on the tab marked as the picked assistant. */
function readPickedTab(page: Page): Promise<string | null> {
  return page
    .getByRole("navigation", { name: "Choose an assistant" })
    .locator('[aria-current="page"]')
    .textContent();
}

describe("Settings > Assistants", () => {
  it("creates an assistant, saves each change, and deletes it once the dialog confirms", async () => {
    const { url, client } = await arrangeFleet();
    const before = await readAssistantIds(client);
    const { page } = await openSignedIn(url);
    await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByText("Assistants").click();
    await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Assistants");

    // New assistant.
    await page.getByRole("button", { name: "New assistant" }).click();
    await expect.poll(async () => (await readAssistantIds(client)).length).toBe(before.length + 1);
    const id = (await readAssistantIds(client)).find((each) => !before.includes(each))!;
    const read = async () => (await readAssistantById(client, id))!;
    expect((await read()).heartbeat.enabled).toBe(true);

    // The heartbeat's switch, first, so no beat starts a session mid-test.
    const heartbeatSwitch = page.getByRole("switch", { name: "Heartbeat" });
    await heartbeatSwitch.click();
    await expect.poll(async () => (await read()).heartbeat.enabled).toBe(false);
    await expect.poll(() => heartbeatSwitch.getAttribute("aria-checked")).toBe("false");

    // The name saves when its field loses focus, not while it is typed.
    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("Ada");
    await page.waitForTimeout(300);
    expect((await read()).name).toBe("Hercule");
    await name.press("Tab");
    await expect.poll(async () => (await read()).name).toBe("Ada");
    await expect.poll(() => readPickedTab(page)).toBe("Ada");

    // The longest name, one word, fits its tab and the section.
    const longName = "A".repeat(128);
    await name.fill(longName);
    await name.press("Tab");
    await expect.poll(() => readPickedTab(page)).toBe(longName);
    const tabs = page.getByRole("navigation", { name: "Choose an assistant" });
    const tab = tabs.locator('[aria-current="page"]');
    const tabsBox = (await tabs.boundingBox())!;
    const tabBox = (await tab.boundingBox())!;
    expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(tabsBox.x + tabsBox.width);
    expect(await tab.getAttribute("title")).toBe(longName);
    const body = page.locator(".set-body");
    expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await name.fill("Ada");
    await name.press("Tab");
    await expect.poll(() => readPickedTab(page)).toBe("Ada");

    // The interval.
    await page.getByRole("combobox", { name: "Interval" }).selectOption("2");
    await expect.poll(async () => (await read()).heartbeat.schedule).toBe("0 7-23/2 * * *");

    // A disallowed tool, added and removed. A new assistant starts with edit.
    expect((await read()).disallowedTools).toEqual(["edit"]);
    await page.getByRole("combobox", { name: "Add a disallowed tool" }).selectOption("shell");
    await expect.poll(async () => (await read()).disallowedTools).toEqual(["edit", "shell"]);
    await page.getByRole("button", { name: "Remove shell" }).click();
    await expect.poll(async () => (await read()).disallowedTools).toEqual(["edit"]);

    // Delete…, cancelled first: nothing is deleted until the dialog confirms.
    await page.locator(".set-row .btn--danger", { hasText: "Delete…" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Ada?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await readAssistantById(client, id)).toBeDefined();

    await page.locator(".set-row .btn--danger", { hasText: "Delete…" }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => readAssistantById(client, id)).toBeUndefined();
    await dialog.waitFor({ state: "detached" });
    await expect.poll(() => readPickedTab(page)).toBe("Hercule");
  });
});
