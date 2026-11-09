/**
 * Tests what Settings > Providers does to the accounts, in the packaged app,
 * signed in to a real controller (spec 17 §Settings, Providers). The accounts
 * are the ones `settings-providers.test.ts` describes, written into the
 * database while the controller is stopped, with a scripted runner as the
 * machine:
 *
 * - Delete of an account something still uses shows the controller's refusal
 *   and offers only Cancel;
 * - Add an account refuses a key the provider refuses, shows why, and keeps
 *   the typed key, and Discard deletes an account whose sign-in was never
 *   finished.
 *
 * The test that adds a key account starts its controller against a stand-in
 * for Z.ai's API (see `startHttpsStandIn`), which refuses every key with 401,
 * so it neither needs the network nor waits for Z.ai. It cannot see a key
 * accepted: a test has no key the provider accepts.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { openSignedIn } from "./harness";
import { startHttpsStandIn } from "../https-stand-in";
import {
  arrangeAccounts,
  openProviders,
  readCardNames,
  readAccounts,
  findAccount,
  openSheet,
} from "./settings-providers-helpers";

describe("Settings > Providers, changing the accounts", () => {
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

  it("refuses a key the provider refuses, shows why, and keeps the typed key", async () => {
    // Z.ai answers a key it does not know with 401 and its own words.
    const standIn = await startHttpsStandIn({
      host: "api.z.ai",
      answer: () => ({ status: 401, json: { error: { message: "Invalid API key" } } }),
    });
    onTestFinished(standIn.stop);
    const arranged = await arrangeAccounts(standIn.controllerEnv);
    const { page } = await openSignedIn(arranged.url);
    await openProviders(page);

    await page.getByRole("button", { name: "Add an account", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add an account", exact: true })
      .getByRole("button", { name: "Z.ai" })
      .click();
    const sheet = page.getByRole("dialog", { name: "Add Z.ai", exact: true });
    await sheet.getByLabel("API key", { exact: true }).fill("e2e-key-the-provider-refuses");
    // Z.ai has an account already, so the key is followed by a name.
    await sheet.getByRole("button", { name: "Continue", exact: true }).click();
    await sheet.getByRole("textbox", { name: "Name", exact: true }).fill("Second");
    await sheet.getByRole("button", { name: "Done", exact: true }).click();

    // The message is the provider's own words. The sheet stays and nothing is stored.
    const refusal = sheet.getByRole("alert");
    await refusal.waitFor();
    expect((await refusal.textContent())?.trim()).toBe("Invalid API key");
    expect(
      standIn.requests.map(({ method, path, headers }) => [method, path, headers["authorization"]]),
    ).toEqual([["GET", "/api/coding/paas/v4/models", "Bearer e2e-key-the-provider-refuses"]]);
    expect(
      (await readAccounts(arranged)).filter((account) => account.providerId === "zai/zai"),
    ).toHaveLength(1);
    await sheet.getByRole("button", { name: "Back", exact: true }).click();
    expect(await sheet.getByLabel("API key", { exact: true }).inputValue()).toBe(
      "e2e-key-the-provider-refuses",
    );
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    expect(await readCardNames(page)).toEqual(["Anthropic", "OpenAI", "Z.ai", "Anthropic · Work"]);
  });

  it("discards the account it made when the sign-in is left unfinished", async () => {
    const arranged = await arrangeAccounts();
    const { page } = await openSignedIn(arranged.url);
    await openProviders(page);
    const readHome = async () =>
      (await readAccounts(arranged)).find((account) => account.label === "Home");

    await page.getByRole("button", { name: "Add an account", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add an account", exact: true })
      .getByRole("button", { name: "Anthropic" })
      .click();
    const sheet = page.getByRole("dialog", { name: "Add Anthropic", exact: true });
    await sheet
      .getByText("Claude subscription, signed in on each machine", { exact: true })
      .click();
    await sheet.getByRole("button", { name: "Continue", exact: true }).click();
    // Anthropic has accounts already, so the new one is named before it signs in.
    await sheet.getByRole("textbox", { name: "Name", exact: true }).fill("Home");
    await sheet.getByRole("button", { name: "Continue", exact: true }).click();

    // The account exists now, and the sheet no longer offers Back.
    await expect.poll(readHome).toBeDefined();
    await sheet.getByRole("button", { name: "Discard", exact: true }).waitFor();
    expect(await sheet.getByRole("button", { name: "Back", exact: true }).count()).toBe(0);
    await sheet.getByRole("button", { name: "Sign in", exact: true }).click();
    const login = page.getByRole("dialog", {
      name: "Sign in to Anthropic · Home on moss",
      exact: true,
    });
    await login.getByRole("button", { name: "Open sign-in page", exact: true }).waitFor();
    // Esc closes the sign-in dialog and leaves the sheet, with its account unsigned.
    await page.keyboard.press("Escape");
    await login.waitFor({ state: "detached" });

    await sheet.getByRole("button", { name: "Discard", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    await expect.poll(readHome).toBeUndefined();
    expect(await readCardNames(page)).toEqual(["Anthropic", "OpenAI", "Z.ai", "Anthropic · Work"]);
  });
});
