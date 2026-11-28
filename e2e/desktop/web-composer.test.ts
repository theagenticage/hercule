/**
 * Tests the web app's composer menu in a browser, against a real controller
 * (spec 14, "The composer is the thread's configuration"; spec 06 §17):
 *
 * - the model menu of a new thread shows the Model Profile's entries, one
 *   lane per Provider Account;
 * - after the profile is trimmed, the open page's menu shows exactly the
 *   trimmed menu, without a reload, and so does a page that is loaded again.
 *
 * The web app has no Providers page, so the profile is trimmed through the
 * public API, as `hercule model-profile update` does. The Models page of the
 * desktop app does the same through its row menu (see
 * `settings-providers-models.test.ts`).
 *
 * This is the only browser test of the web app. It sits beside the desktop
 * tests because it needs what they have: Playwright, which runs on Node, and
 * the scripted runner that reports two models. The browser is Playwright's
 * Chromium, started headless; run `pnpm exec playwright install chromium`
 * once if it is missing. Run `pnpm build:binary` first: the controller serves
 * the web app embedded in the binary.
 */
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { PASSWORD, USERNAME } from "../../scripts/controller-process";
import type { ModelProfile } from "../../packages/contract/src/index";
import { arrangeFleet, type ArrangedFleet } from "./harness";

const MAIN_PROFILE = "Main";

/** Starts a headless Chromium for the current test, and closes it when the test finishes. */
async function launchBrowser(): Promise<Browser> {
  const browser = await chromium.launch();
  onTestFinished(async () => {
    await browser.close();
  });
  return browser;
}

/** Signs in on the web app's login page and waits for the app's shell. */
async function signIn(page: Page, url: string): Promise<void> {
  await page.goto(`${url}/login`);
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((address) => !address.pathname.startsWith("/login"));
}

/**
 * Opens the model menu of the new thread screen and returns the names of its
 * rows, with the lane labels between them, in the order drawn. The menu is
 * closed again, so the next call opens it afresh.
 */
async function readModelMenu(page: Page, pill: RegExp): Promise<string[]> {
  await page.getByRole("button", { name: pill }).click();
  const menu = page.getByRole("dialog");
  await menu.waitFor();
  const rows = await menu.getByRole("button").allTextContents();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  return rows.map((row) => row.trim());
}

/** Waits until the profile "Main" holds the models the scripted machine reports, and returns it. */
async function waitForFilledProfile(arranged: ArrangedFleet): Promise<ModelProfile> {
  let found: ModelProfile | undefined;
  await expect
    .poll(
      async () => {
        const profiles = await arranged.client.modelProfile.query();
        found = profiles.find((profile) => profile.name === MAIN_PROFILE);
        return found?.accounts.flatMap((section) => section.entries.map((entry) => entry.model));
      },
      { message: "the catalog read never filled the profile" },
    )
    .toEqual(["scripted", "scripted-large"]);
  return found!;
}

describe("The web app's composer menu", () => {
  it("shows exactly the trimmed Model Profile, live and after a reload", async () => {
    const arranged = await arrangeFleet();
    // The web app sends a new user through its onboarding first; the timezone
    // is set by setup, and the assistant exists already.
    await arranged.client.settings.update({
      payload: { user: { "onboarding.completedSteps": ["timezone", "assistant"] } },
    });
    await arranged.fleet.enlistRunner("moss");
    const profile = await waitForFilledProfile(arranged);

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await signIn(page, arranged.url);
    await page.goto(`${arranged.url}/threads/new`);

    // The profile as the Default Selection filled it: both models, in one lane.
    // The pill's name ends with the caret it draws.
    const pill = /^Scripted ▾$/;
    expect(await readModelMenu(page, pill)).toEqual([
      expect.stringContaining("Scripted"),
      expect.stringContaining("Scripted Large"),
    ]);

    // Take "Scripted Large" out of the menu, as the Models page's row menu does:
    // the entry goes, and the model is dismissed so it is not announced as new.
    const section = profile.accounts[0]!;
    await arranged.client.modelProfile.update({
      params: { id: profile.id },
      payload: {
        expectedRevision: profile.revision,
        name: profile.name,
        accounts: [
          {
            providerAccountId: section.providerAccountId,
            harnessId: section.harnessId,
            entries: section.entries
              .filter((entry) => entry.model !== "scripted-large")
              .map(({ providerAccountId, model, harnessId }) => ({
                providerAccountId,
                model,
                harnessId,
              })),
          },
        ],
        defaultEntry: profile.defaultEntry,
        dismissedNewModels: [
          ...profile.dismissedNewModels,
          { providerAccountId: section.providerAccountId, model: "scripted-large" },
        ],
      },
    });

    // The open page follows the `provider` live topic: no reload.
    await expect
      .poll(() => readModelMenu(page, pill), { message: "the open page kept the old menu" })
      .toEqual([expect.stringContaining("Scripted")]);
    expect(await readModelMenu(page, pill)).not.toContainEqual(
      expect.stringContaining("Scripted Large"),
    );

    await page.reload();
    expect(await readModelMenu(page, pill)).toEqual([expect.stringContaining("Scripted")]);
    expect(await readModelMenu(page, pill)).not.toContainEqual(
      expect.stringContaining("Scripted Large"),
    );
  });
});
