/**
 * Tests Settings > Providers in the packaged app, signed in to a real
 * controller (spec 17 §Settings, Providers). `settings-providers-changes.test.ts`
 * tests what the page does to the accounts:
 *
 * - the Accounts section draws one card for each Provider Account, with the
 *   account's name, under it a line for who is signed in and a line for the
 *   plan (or the kind's title alone), and at the right end of the last line
 *   where the account works, which the card describes in words as its
 *   accessible name;
 * - Sign in on a machine opens the sign-in dialog with the page the runner's
 *   login printed, and Cancel leaves the account as it was;
 * - the Name field renames an account, on its card at once and after a reload.
 *
 * The accounts are written into the database while the controller is
 * stopped (see `writeProviderAccounts`): one at each provider, with the
 * identity and plan of Anthropic's, and a second Anthropic account, "Work".
 * A fresh controller has no account, and the API cannot set an identity or a
 * plan. The machine is a scripted runner. It answers a sign-in with a page
 * that nothing serves and never accepts a code, so no vendor's login runs.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { openSignedIn } from "./harness";
import {
  arrangeAccounts,
  openProviders,
  readCardNames,
  findCard,
  findAccount,
  openSheet,
} from "./settings-providers-helpers";

/**
 * Returns the lines of identity on the card named `name`: who is signed in
 * then the plan, or the kind's title alone. The words of where the account
 * works, which end the last line, are left out.
 */
function readIdentityLines(page: Page, name: string): Promise<string[]> {
  return findCard(page, name)
    .locator(".pa-card-line")
    .evaluateAll((lines) =>
      lines.map((line) => (line.querySelector(".pa-card-last-text") ?? line).textContent ?? ""),
    );
}

/** Returns the words that describe where the account on the card named `name` works. */
function readReach(page: Page, name: string): Promise<string | null> {
  return findCard(page, name).getByRole("img").getAttribute("aria-label");
}

describe("Settings > Providers", () => {
  it("draws a card for each account, with its identity and where it works", async () => {
    const arranged = await arrangeAccounts();
    const { page } = await openSignedIn(arranged.url);
    await openProviders(page);

    // The accounts are written a millisecond apart, in the order of `FIXTURES`.
    expect(await readCardNames(page)).toEqual(["Anthropic", "OpenAI", "Z.ai", "Anthropic · Work"]);

    // Who is signed in and the plan each have a line.
    expect(await readIdentityLines(page, "Anthropic")).toEqual(["rogier@example.com", "Max"]);
    expect(await readIdentityLines(page, "Anthropic · Work")).toEqual(["rogier@acme.test", "Team"]);
    // An account nobody is known to be signed in as shows its kind's title.
    expect(await readIdentityLines(page, "OpenAI")).toEqual([
      "ChatGPT subscription, signed in on each machine",
    ]);
    expect(await readIdentityLines(page, "Z.ai")).toEqual(["API key"]);

    // An account that signs in on each machine says on how many machines it is
    // ready and which; a key works on every machine.
    expect(await readReach(page, "Anthropic")).toBe("Ready on 1 of 1 machine. moss: ready");
    expect(await readReach(page, "Z.ai")).toBe("Shared credential: works on every machine");
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
      .poll(() => readReach(page, "Anthropic"))
      .toBe("Ready on 0 of 1 machine. moss: not ready");

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
    expect(await readReach(page, "Anthropic")).toBe("Ready on 0 of 1 machine. moss: not ready");
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
});
