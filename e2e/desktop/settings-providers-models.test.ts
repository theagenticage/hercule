/**
 * Tests Settings > Providers > Models and the composer menu it feeds, in the
 * packaged app, signed in to a real controller (spec 17 §Settings, Providers,
 * and §Design system, **The thread**; spec 06 §17):
 *
 * - the Models section draws the account's models in the order the Default
 *   Selection gave them, with the provider's default marked;
 * - "Take out of the menu" on a row removes the model from the profile, on
 *   the page at once and in the controller;
 * - the model menu of a new thread then shows exactly the trimmed menu.
 *
 * The machine is a scripted runner, "moss". Its probe of the Anthropic account
 * lists two models, "Scripted" and "Scripted Large", and the first catalog read
 * puts both into the profile "Main".
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  chooseMenuItem,
  keepWindowOnTop,
  openSignedIn,
  startIdentityServerForTest,
  type ArrangedFleet,
} from "./harness";

const MAIN_PROFILE = "Main";

/** Opens Settings from the sidebar's foot, then Providers from the Settings list. */
async function openProviders(page: Page): Promise<void> {
  await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByText("Providers", { exact: true })
    .click();
  await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Providers");
}

/** Returns the model names the controller holds in the profile "Main", in menu order. */
async function readProfileModels(arranged: ArrangedFleet): Promise<(string | undefined)[]> {
  const profiles = await arranged.client.modelProfile.query();
  const main = profiles.find((profile) => profile.name === MAIN_PROFILE);
  return main?.accounts.flatMap((section) => section.entries.map((entry) => entry.model)) ?? [];
}

/** Opens a Draft Thread in the project "notes" from File > New Thread, and ⌘1. */
async function openDraft(
  app: Parameters<typeof chooseMenuItem>[0],
  page: Page,
  projectName: string,
): Promise<void> {
  await chooseMenuItem(app, "File", "New Thread");
  await page.getByRole("dialog", { name: "New thread in" }).waitFor();
  await page.keyboard.press("Meta+1");
  await page
    .getByRole("heading", { name: `What should the agent do in ${projectName}?` })
    .waitFor();
}

describe("Settings > Providers > Models", () => {
  it("takes a model out of the menu, and the composer's menu shows exactly what is left", async () => {
    const arranged = await arrangeFleet();
    const { url, fleet, client } = arranged;
    let localRunnerId = "";
    const identityPort = await startIdentityServerForTest(() => localRunnerId);
    const moss = await fleet.enlistRunner("moss", { identityPort });
    localRunnerId = moss.runnerId;
    await fleet.createProject("notes");
    // The first catalog read of the account fills the profile with both models.
    await expect
      .poll(() => readProfileModels(arranged), { timeout: 15_000 })
      .toEqual(["scripted", "scripted-large"]);

    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openProviders(page);

    const models = page.getByRole("region", { name: "Anthropic", exact: true });
    const rowNames = () => models.locator(".pm-rows li b").allTextContents();
    await expect.poll(rowNames).toEqual(["Scripted", "Scripted Large"]);
    // The provider's own default model is the profile's default entry.
    expect(await models.locator(".pm-rows li").first().locator(".pm-default").count()).toBe(1);
    expect(await models.locator(".pm-rows li").nth(1).locator(".pm-default").count()).toBe(0);

    // The composer offers both before the trim.
    await openDraft(app, page, "notes");
    const pill = page.locator(".composer-row button.pick--pill");
    const menu = page.getByRole("dialog", { name: "Model", exact: true });
    await pill.click();
    await menu.waitFor();
    expect(await menu.locator(".q-h").allTextContents()).toEqual(["Anthropic"]);
    expect(await menu.locator("button.line b").allTextContents()).toEqual([
      "Scripted",
      "Scripted Large",
    ]);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });

    // Back to the Models page, where "Scripted Large" is taken out.
    await openProviders(page);
    await models.getByRole("button", { name: "More for Scripted Large", exact: true }).click();
    await page
      .getByRole("menu", { name: "More for Scripted Large", exact: true })
      .getByRole("menuitem", { name: "Take out of the menu", exact: true })
      .click();
    await expect.poll(rowNames).toEqual(["Scripted"]);
    await expect.poll(() => readProfileModels(arranged)).toEqual(["scripted"]);
    // Taking a model out also dismisses it, so the profile does not announce it as new.
    const [main] = await client.modelProfile.query();
    expect(main?.dismissedNewModels.map(({ model }) => model)).toEqual(["scripted-large"]);
    expect(main?.defaultEntry?.model).toBe("scripted");

    // The new thread's menu shows the trimmed menu.
    await openDraft(app, page, "notes");
    await pill.click();
    await menu.waitFor();
    expect(await menu.locator(".q-h").allTextContents()).toEqual(["Anthropic"]);
    expect(await menu.locator("button.line b").allTextContents()).toEqual(["Scripted"]);
    expect(await menu.getByText("Scripted Large").count()).toBe(0);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
  });
});
