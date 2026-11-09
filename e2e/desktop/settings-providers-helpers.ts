/**
 * What the Settings > Providers end-to-end files share
 * (`settings-providers.test.ts` and `settings-providers-changes.test.ts`): the
 * accounts a controller starts with, and opening and reading the page.
 */
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import {
  writeProviderAccounts,
  type ProviderAccountFixture,
} from "../../apps/desktop/scripts/provider-account-fixtures";
import type { ProviderAccount } from "../../packages/contract/src/index";
import { arrangeFleet, type ArrangedFleet } from "./harness";

export const ANTHROPIC = "anthropic/anthropic";
const SUBSCRIPTION = "subscription-per-machine";
const CLAUDE_CODE = "claude-code/claude-code";

/**
 * One account at each provider, with an identity and a plan for Anthropic's,
 * and a second Anthropic account, "Work".
 */
export const FIXTURES: ReadonlyArray<ProviderAccountFixture> = [
  {
    providerId: ANTHROPIC,
    kind: SUBSCRIPTION,
    identity: "rogier@example.com",
    planLabel: "Max",
    defaultHarnessId: CLAUDE_CODE,
  },
  {
    providerId: "openai/openai",
    kind: SUBSCRIPTION,
    defaultHarnessId: "codex/codex",
  },
  {
    providerId: "zai/zai",
    kind: "api-key",
    defaultHarnessId: "pi/pi",
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
 * every runner. `controllerEnv` is added to the controller's environment.
 */
export async function arrangeAccounts(controllerEnv?: Readonly<Record<string, string>>) {
  const arranged = await arrangeFleet(
    controllerEnv === undefined ? {} : { ownRunnerEnv: controllerEnv },
  );
  await arranged.restartController(() => {
    writeProviderAccounts(arranged.home, FIXTURES);
  });
  const moss = await arranged.fleet.enlistRunner("moss");
  return { ...arranged, moss };
}

/** Opens Settings from the sidebar's foot, then Providers from the Settings list. */
export async function openProviders(page: Page): Promise<void> {
  await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByText("Providers", { exact: true })
    .click();
  await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Providers");
  await page.locator(".pa-card").first().waitFor();
}

/** Returns the names on the cards, in the order drawn. */
export function readCardNames(page: Page): Promise<string[]> {
  return page.locator(".pa-card b").allTextContents();
}

/** Returns the card named `name`. */
export function findCard(page: Page, name: string): Locator {
  return page.getByTitle(`Open ${name}`, { exact: true });
}

/** Returns every Provider Account, read through the API. */
export function readAccounts(arranged: ArrangedFleet): Promise<ReadonlyArray<ProviderAccount>> {
  return arranged.client.providerAccount.query();
}

/** Returns the account called `name`, such as "Anthropic · Work", read through the API. */
export async function findAccount(
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
export async function openSheet(page: Page, name: string): Promise<Locator> {
  await findCard(page, name).click();
  const sheet = page.getByRole("dialog", { name, exact: true });
  await sheet.waitFor();
  return sheet;
}
