/**
 * Tests Settings > Providers in the packaged app, signed in to a real
 * controller (spec 17 §Settings, Providers):
 *
 * - the Accounts section draws one card for each Provider Account, with the
 *   account's name, the identity line under it, and either a pip for each
 *   machine or "Every machine";
 * - Sign in on a machine opens the sign-in dialog with the page the runner's
 *   login printed, and Cancel leaves the account as it was;
 * - the Name field renames an account, on its card at once and after a reload;
 * - Delete of an account something still uses shows the controller's refusal
 *   and offers only Cancel.
 *
 * The accounts are the three a fresh controller creates, with an identity
 * and a plan written into the database while the controller is stopped
 * (see `writeProviderAccounts`), and a second Anthropic account, "Work",
 * written there too: nothing in the API can make either yet. The machine is
 * a scripted runner. It answers a sign-in with a page that nothing serves
 * and never accepts a code, so no vendor's login runs.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  writeProviderAccounts,
  type ProviderAccountFixture,
} from "../../apps/desktop/scripts/provider-account-fixtures";
import type { ProviderAccount } from "../../packages/contract/src/index";
import { arrangeFleet, openSignedIn, type ArrangedFleet } from "./harness";

const ANTHROPIC = "anthropic/anthropic";
const SUBSCRIPTION = "subscription-per-machine";
const CLAUDE_CODE = "claude-code/claude-code";

/**
 * The identity and plan of the account a fresh controller creates for
 * Anthropic, and a second Anthropic account, "Work".
 */
const FIXTURES: ReadonlyArray<ProviderAccountFixture> = [
  {
    providerId: ANTHROPIC,
    kind: SUBSCRIPTION,
    identity: "rogier@example.com",
    planLabel: "Max",
    defaultHarnessId: CLAUDE_CODE,
  },
  {
    providerId: ANTHROPIC,
    kind: SUBSCRIPTION,
    label: "Work",
    identity: "rogier@acme.test",
    planLabel: "Team",
    defaultHarnessId: CLAUDE_CODE,
  },
];

/**
 * Starts a controller with the accounts of `FIXTURES` and a scripted machine
 * called "moss", which every account is probed on and found signed in. The
 * accounts are written first, because restarting the controller disconnects
 * every runner.
 */
async function arrangeAccounts() {
  const arranged = await arrangeFleet();
  await arranged.restartController(() => {
    writeProviderAccounts(arranged.home, FIXTURES);
  });
  const moss = await arranged.fleet.enlistRunner("moss");
  return { ...arranged, moss };
}

/** Opens Settings from the sidebar's foot, then Providers from the Settings list. */
async function openProviders(page: Page): Promise<void> {
  await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByText("Providers", { exact: true })
    .click();
  await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Providers");
  await page.locator(".pa-card").first().waitFor();
}

/** Returns the names on the cards, in the order drawn. */
function readCardNames(page: Page): Promise<string[]> {
  return page.locator(".pa-card b").allTextContents();
}

/** Returns the card named `name`. */
function findCard(page: Page, name: string): Locator {
  return page.getByTitle(`Open ${name}`, { exact: true });
}

/** Returns every Provider Account, read through the API. */
function readAccounts(arranged: ArrangedFleet): Promise<ReadonlyArray<ProviderAccount>> {
  return arranged.client.providerAccount.query();
}

/** Returns the account called `name`, such as "Anthropic · Work", read through the API. */
async function findAccount(
  arranged: ArrangedFleet,
  label: string | null,
): Promise<ProviderAccount> {
  const found = (await readAccounts(arranged)).find(
    (account) => account.providerId === ANTHROPIC && account.label === label,
  );
  if (found === undefined) throw new Error(`the controller has no Anthropic account ${label}`);
  return found;
}

/** Opens the sheet of the card named `name` and returns the sheet. */
async function openSheet(page: Page, name: string): Promise<Locator> {
  await findCard(page, name).click();
  const sheet = page.getByRole("dialog", { name, exact: true });
  await sheet.waitFor();
  return sheet;
}

describe("Settings > Providers", () => {
  it("draws a card for each account, with its identity and where it works", async () => {
    const arranged = await arrangeAccounts();
    const { page } = await openSignedIn(arranged.url);
    await openProviders(page);

    // The three accounts a fresh controller creates share one creation time,
    // so their order is not fixed. The account written afterwards is last.
    const names = await readCardNames(page);
    expect(names.slice(0, 3).sort()).toEqual(["Anthropic", "OpenAI", "Z.ai"]);
    expect(names[3]).toBe("Anthropic · Work");

    const identities = async (name: string) =>
      findCard(page, name).locator(".pa-card-identity").textContent();
    expect(await identities("Anthropic")).toBe("rogier@example.com · Max");
    expect(await identities("Anthropic · Work")).toBe("rogier@acme.test · Team");
    // An account nobody is known to be signed in as shows its kind's title.
    expect(await identities("OpenAI")).toBe("ChatGPT subscription, signed in on each machine");
    expect(await identities("Z.ai")).toBe("API key");

    // An account that signs in on each machine has a pip for each machine,
    // filled where it is signed in; a key works on every machine.
    expect(await findCard(page, "Anthropic").getByRole("img").getAttribute("aria-label")).toBe(
      "moss: ready",
    );
    expect(await findCard(page, "Z.ai").locator(".pa-card-reach").textContent()).toBe(
      "Every machine",
    );
    expect(await findCard(page, "Z.ai").getByRole("img").count()).toBe(0);
  });

  it("opens the sign-in on a machine, and Cancel leaves the account as it was", async () => {
    const arranged = await arrangeAccounts();
    const anthropic = await findAccount(arranged, null);
    // The machine's login is gone: the next probe finds it signed out.
    arranged.moss.setSignedIn(false);
    await arranged.client.runner.probe({
      params: { id: arranged.moss.runnerId },
      payload: { providerAccountId: anthropic.id },
    });
    const { page } = await openSignedIn(arranged.url);
    await openProviders(page);
    await expect
      .poll(() => findCard(page, "Anthropic").getByRole("img").getAttribute("aria-label"))
      .toBe("moss: not signed in");

    // What the controller stores for the account on moss, to compare after Cancel.
    const readSnapshot = async () =>
      (await findAccount(arranged, null)).snapshots.find(
        (snapshot) => snapshot.runnerId === arranged.moss.runnerId,
      );
    const before = await readSnapshot();
    expect(before?.auth.status).toBe("unauthenticated");

    const sheet = await openSheet(page, "Anthropic");
    const machine = sheet.locator(".pa-machine");
    expect(await machine.innerText()).toContain("Not signed in");
    await machine.getByRole("button", { name: "Sign in", exact: true }).click();

    // The sign-in starts as the dialog opens, and shows the page the runner's
    // login printed, then waits for the code that page shows.
    const login = page.getByRole("dialog", { name: "Sign in to Anthropic on moss", exact: true });
    await login.getByRole("button", { name: "Open sign-in page", exact: true }).waitFor();
    expect(await login.getByText("Paste the code it shows you.").count()).toBe(1);
    expect(await login.getByLabel("Code", { exact: true }).isVisible()).toBe(true);

    // Cancel ends the sign-in on the row, which offers it again. Esc then
    // closes the dialog and leaves the sheet open under it.
    await login.getByRole("button", { name: "Cancel", exact: true }).click();
    await login.getByLabel("Code", { exact: true }).waitFor({ state: "detached" });
    await login.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await login.waitFor({ state: "detached" });

    expect(await sheet.isVisible()).toBe(true);
    expect(await machine.innerText()).toContain("Not signed in");
    await sheet.getByRole("button", { name: "Done", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    expect(await findCard(page, "Anthropic").getByRole("img").getAttribute("aria-label")).toBe(
      "moss: not signed in",
    );
    expect(await readSnapshot()).toEqual(before);
  });

  it("renames an account, on its card at once and after a reload", async () => {
    const arranged = await arrangeAccounts();
    const { page } = await openSignedIn(arranged.url);
    await openProviders(page);

    const sheet = await openSheet(page, "Anthropic · Work");
    const field = sheet.getByRole("textbox", { name: "Name", exact: true });
    expect(await field.inputValue()).toBe("Work");
    await field.fill("Client");
    await field.press("Enter");

    await expect.poll(() => readCardNames(page)).toContain("Anthropic · Client");
    expect(await readCardNames(page)).not.toContain("Anthropic · Work");
    // The sheet is named after the account, so it follows the label as well.
    await page
      .getByRole("dialog", { name: "Anthropic · Client", exact: true })
      .getByRole("heading", { name: "Anthropic · Client", exact: true })
      .waitFor();
    expect((await findAccount(arranged, "Client")).label).toBe("Client");

    // The app never reopens on Settings, so it comes back to Providers by
    // the way the user goes.
    await page.reload();
    await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
    await openProviders(page);
    expect(await readCardNames(page)).toContain("Anthropic · Client");
    expect(await readCardNames(page)).not.toContain("Anthropic · Work");
  });

  it("shows the controller's refusal to delete an account that is still in use, with only Cancel", async () => {
    const arranged = await arrangeAccounts();
    const work = await findAccount(arranged, "Work");
    // The account is the default for new threads, which keeps it from being deleted.
    await arranged.client.settings.update({
      payload: { user: { "thread.providerAccountId": work.id } },
    });
    const { page } = await openSignedIn(arranged.url);
    await openProviders(page);

    const sheet = await openSheet(page, "Anthropic · Work");
    await sheet.getByRole("button", { name: "Delete…", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Delete Anthropic · Work?", exact: true });
    // Before the controller has refused, the dialog offers the choice.
    await confirm.getByRole("button", { name: "Keep it", exact: true }).waitFor();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();

    const refusal = confirm.getByRole("alert");
    await refusal.waitFor();
    expect(await refusal.textContent()).toBe(
      "Anthropic · Work is still in use, so it was not deleted. Change these first: the default account for new Threads of 1 user (thread.providerAccountId).",
    );
    expect(await confirm.getByRole("button").allTextContents()).toEqual(["Cancel"]);

    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    expect(await readCardNames(page)).toContain("Anthropic · Work");
    expect((await readAccounts(arranged)).map((account) => account.id)).toContain(work.id);
  });
});
