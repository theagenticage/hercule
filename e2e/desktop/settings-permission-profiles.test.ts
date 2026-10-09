/**
 * Tests Settings > Permission profiles in the packaged app, signed in to a
 * real controller (spec 17 §Settings, Permission profiles). One test walks
 * the section as a user does, and checks each save through the API:
 *
 * - the list shows the profiles shipped with Hercule, shipped ones first;
 * - New profile creates a profile and opens its page;
 * - pressing a grant's verb saves the grant, and it is still pressed, and
 *   counted, when the page is opened again from the list;
 * - the Name field saves a new name, and the header follows it;
 * - Delete… asks in a dialog first, and lands on the list without the
 *   profile once the dialog confirms;
 * - a shipped profile's page has no Delete, only the line that says why.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { Profile } from "../../packages/contract/src/index";
import type { HerculeClient } from "../../packages/client-core/src/index";
import { arrangeFleet, openSignedIn } from "./harness";

/** Returns every profile, read through the API. */
async function readProfiles(client: HerculeClient): Promise<readonly Profile[]> {
  const { items } = await client.profile.query({ query: { limit: 50 } });
  return items;
}

/** Returns the profile named `name`, read through the API, or undefined when there is none. */
async function readProfileByName(
  client: HerculeClient,
  name: string,
): Promise<Profile | undefined> {
  return (await readProfiles(client)).find((profile) => profile.name === name);
}

/** Returns the names of the list's rows, in the order drawn. */
function readListedNames(page: Page): Promise<string[]> {
  return page.locator(".profile-row .profile-name b").allTextContents();
}

/** Waits until the header's title is `title`. */
async function waitForTitle(page: Page, title: string): Promise<void> {
  await expect
    .poll(() => page.locator(".bar .title").textContent(), {
      message: `the header did not show ${title}`,
    })
    .toBe(title);
}

/** Returns the Tasks family's Read button on a profile's page. */
function findTasksReadButton(page: Page) {
  return page.getByRole("group", { name: "Tasks" }).getByRole("button", { name: "Read" });
}

describe("Settings > Permission profiles", () => {
  it("lists the shipped profiles, creates one, saves its grant and name, deletes it through the dialog, and shows no Delete on a shipped one", async () => {
    const { url, client } = await arrangeFleet();
    const { page } = await openSignedIn(url);
    await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
    const settings = page.getByRole("navigation", { name: "Settings" });
    await settings.getByText("Permission profiles", { exact: true }).click();
    await waitForTitle(page, "Permission profiles");
    expect(await settings.locator('[aria-current="page"]').textContent()).toBe(
      "Permission profiles",
    );

    // The shipped profiles, with nothing of the user's own yet.
    await expect.poll(() => readListedNames(page)).toEqual(["assistant", "unrestricted", "worker"]);
    expect(await page.locator(".profile-row .profile-name span").allTextContents()).toEqual([
      "Shipped with Hercule",
      "Shipped with Hercule",
      "Shipped with Hercule",
    ]);

    // New profile creates one with no grants and opens its page.
    await page.getByRole("button", { name: "New profile" }).click();
    await waitForTitle(page, "New profile");
    const created = (await readProfileByName(client, "New profile"))!;
    expect(created.grants).toEqual([]);
    expect(created.shipped).toBe(false);
    const grantsHeading = page.getByRole("heading", { level: 2, name: /^Grants/ });
    expect(await grantsHeading.textContent()).toBe("Grants0 of 42");

    // A grant saves when its verb is pressed.
    const read = findTasksReadButton(page);
    expect(await read.getAttribute("aria-pressed")).toBe("false");
    await read.click();
    await expect
      .poll(async () => (await readProfileByName(client, "New profile"))!.grants)
      .toEqual(["task.read"]);
    await expect.poll(() => read.getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => grantsHeading.textContent()).toBe("Grants1 of 42");

    // Back on the list, the count follows. Opening the page again reads the
    // saved profile: the verb is still pressed.
    await page.locator(".bar").getByRole("link", { name: "Permission profiles" }).click();
    await waitForTitle(page, "Permission profiles");
    const row = page.getByRole("link", { name: /New profile/ });
    await expect.poll(() => row.locator(".profile-held").textContent()).toContain("1 of 42");
    await row.click();
    await waitForTitle(page, "New profile");
    await expect.poll(() => findTasksReadButton(page).getAttribute("aria-pressed")).toBe("true");
    expect(await grantsHeading.textContent()).toBe("Grants1 of 42");

    // The name saves on Enter, and the header follows it.
    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("Triage");
    await name.press("Enter");
    await expect.poll(async () => (await readProfileByName(client, "Triage"))?.id).toBe(created.id);
    await waitForTitle(page, "Triage");
    expect(await readProfileByName(client, "New profile")).toBeUndefined();

    // Delete…, cancelled first: nothing is deleted until the dialog confirms.
    await page.getByRole("button", { name: "Delete profile" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Triage?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await readProfileByName(client, "Triage")).toBeDefined();

    await page.getByRole("button", { name: "Delete profile" }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => readProfileByName(client, "Triage")).toBeUndefined();
    await waitForTitle(page, "Permission profiles");
    await expect.poll(() => readListedNames(page)).toEqual(["assistant", "unrestricted", "worker"]);

    // A shipped profile has no Delete, only the line that says why.
    await page.getByRole("link", { name: /^worker/ }).click();
    await waitForTitle(page, "worker");
    await page.getByRole("heading", { level: 2, name: "Delete worker" }).waitFor();
    expect(await page.getByRole("button", { name: "Delete profile" }).count()).toBe(0);
    expect(await page.locator(".profile-fixed").textContent()).toBe(
      "worker is shipped with Hercule, so it cannot be deleted. Edit its grants instead.",
    );
  });
});
