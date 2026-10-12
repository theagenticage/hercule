/**
 * Tests Settings > Connections in the packaged app, signed in to a real
 * controller (spec 17 §Settings, Connections, and §Testing):
 *
 * - the table draws each Connection as "<type> · <label>" with its health:
 *   "healthy", "needs sign-in", "disabled", or an `error`'s status detail,
 *   drawn as a failure. A type no plugin in the binary declares is drawn by
 *   its id, and its Reconnect is disabled;
 * - Configure renames a Connection, and Delete removes one after asking;
 * - Add a Connection > GitHub, with a pasted token GitHub refuses, shows the
 *   refusal under the "Personal access token" field and creates nothing.
 *
 * No Connection type in the binary can be created offline: GitHub checks a
 * pasted token against api.github.com, and Sentry against sentry.io. So the
 * table's rows are written into the scratch database while the controller
 * is stopped (see `replaceConnections`), and the setup test pastes a fake
 * token, which GitHub refuses when the machine is online and which fails to
 * reach GitHub when it is not. Both end in the same refusal under the field.
 *
 * With `HERCULE_E2E_GITHUB_TOKEN` set to a real token, one more test creates
 * a GitHub Connection from it and sees its row healthy. Without it, that test
 * is skipped.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { HerculeClient } from "../../packages/client-core/src/index";
import type { Connection } from "../../packages/contract/src/index";
import {
  replaceConnections,
  type ConnectionFixture,
} from "../../apps/desktop/scripts/connection-fixtures";
import { arrangeFleet, openSignedIn } from "./harness";

/**
 * The Connections the table test writes, in the order the table lists them.
 * The two of the type `acme/widgets`, which no plugin in the binary
 * declares, keep their `connected` and `error` statuses, because the
 * controller polls only Connections of a type it knows.
 */
const ROWS = [
  { id: "019a1234-5678-7000-8000-000000000011", label: "work", status: "needs-reauth" },
  {
    id: "019a1234-5678-7000-8000-000000000012",
    label: "acme",
    status: "disabled",
    type: "sentry/sentry",
  },
  {
    id: "019a1234-5678-7000-8000-000000000013",
    label: "team",
    status: "connected",
    type: "acme/widgets",
  },
  {
    id: "019a1234-5678-7000-8000-000000000014",
    label: "ops",
    status: "error",
    statusDetail: "The feed failed 5 times in a row: 502 Bad Gateway",
    type: "acme/widgets",
  },
] as const satisfies ReadonlyArray<ConnectionFixture>;

/** The token the refusal test pastes. GitHub issues no token of this shape. */
const FAKE_TOKEN = "ghp_000000000000000000000000000000000000";

/** A real GitHub token, for the opt-in test that creates a Connection. */
const githubToken = process.env["HERCULE_E2E_GITHUB_TOKEN"];

/** Returns every Connection, read through the API. */
async function readConnections(client: HerculeClient): Promise<readonly Connection[]> {
  return (await client.connection.query({ query: { limit: 50 } })).items;
}

/** Opens Settings from the sidebar's foot, then Connections from the Settings list. */
async function openConnections(page: Page): Promise<void> {
  await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByText("Connections", { exact: true })
    .click();
  await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Connections");
}

/** Returns the names of the table's rows, "<type> · <label>", in the order drawn. */
function readRowNames(page: Page): Promise<string[]> {
  return page.locator(".connection-list .conn .nm > b").allTextContents();
}

/** Returns the table's row named `name`. */
function findRow(page: Page, name: string): Locator {
  return page
    .locator(".connection-list .conn")
    .filter({ has: page.locator(".nm > b").getByText(name, { exact: true }) });
}

/** Opens the ⋯ menu of the row named `name` and returns the menu. */
async function openRowMenu(page: Page, name: string): Promise<Locator> {
  await page.getByRole("button", { name: `More for ${name}`, exact: true }).click();
  const menu = page.getByRole("menu", { name: `More for ${name}`, exact: true });
  await menu.waitFor();
  return menu;
}

/** Closes an open menu with Escape and waits until it is gone. */
async function closeMenu(page: Page, menu: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

/**
 * Opens Add a Connection > GitHub, switches the setup to a pasted token, and
 * submits `token`. Returns the setup dialog.
 */
async function submitGithubToken(page: Page, token: string): Promise<Locator> {
  await page.getByRole("button", { name: "Add a Connection", exact: true }).click();
  await page
    .getByRole("menu", { name: "Add a Connection" })
    .getByRole("menuitem", { name: /^GitHub/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect GitHub", exact: true });
  await dialog.getByRole("button", { name: "Paste a token instead", exact: true }).click();
  await dialog.getByLabel("Personal access token").fill(token);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  return dialog;
}

describe("Settings > Connections", () => {
  it("draws each Connection's health, renames one with Configure, and deletes one after asking", async () => {
    const arranged = await arrangeFleet();
    await arranged.restartController(() => {
      replaceConnections(arranged.home, ROWS);
    });
    const { client } = arranged;
    const { page } = await openSignedIn(arranged.url);
    await openConnections(page);

    await expect
      .poll(() => readRowNames(page))
      .toEqual(["GitHub · work", "Sentry · acme", "acme/widgets · team", "acme/widgets · ops"]);
    const health = page.locator(".connection-list .conn .health");
    expect(await health.allTextContents()).toEqual([
      "needs sign-in",
      "disabled",
      "healthy",
      "The feed failed 5 times in a row: 502 Bad Gateway",
    ]);
    // Only the `error` row is drawn as a failure.
    expect(await page.locator(".connection-list .conn.is-fail .nm > b").allTextContents()).toEqual([
      "acme/widgets · ops",
    ]);
    expect(await findRow(page, "acme/widgets · ops").locator(".dot--fail").count()).toBe(1);

    // Reconnect needs the type's setup, which only the binary holds.
    const githubMenu = await openRowMenu(page, "GitHub · work");
    expect(
      await githubMenu.getByRole("menuitem", { name: "Reconnect…" }).getAttribute("aria-disabled"),
    ).not.toBe("true");
    await closeMenu(page, githubMenu);
    const widgetsMenu = await openRowMenu(page, "acme/widgets · team");
    expect(
      await widgetsMenu.getByRole("menuitem", { name: "Reconnect…" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await closeMenu(page, widgetsMenu);

    // Configure saves a new name, and the row follows it.
    await (
      await openRowMenu(page, "GitHub · work")
    )
      .getByRole("menuitem", { name: "Configure…" })
      .click();
    const configure = page.getByRole("dialog", { name: "Configure GitHub · work", exact: true });
    await configure.getByRole("textbox", { name: "Name", exact: true }).fill("work laptop");
    await configure.getByRole("button", { name: "Save", exact: true }).click();
    await configure.waitFor({ state: "detached" });
    await expect
      .poll(async () => (await readConnections(client)).find((row) => row.id === ROWS[0].id)?.label)
      .toBe("work laptop");
    await expect.poll(() => readRowNames(page)).toContain("GitHub · work laptop");

    // Delete asks first; nothing is deleted until the dialog confirms.
    const deleteDialog = page.getByRole("dialog", {
      name: "Delete acme/widgets · team?",
      exact: true,
    });
    await (
      await openRowMenu(page, "acme/widgets · team")
    )
      .getByRole("menuitem", { name: "Delete…" })
      .click();
    await deleteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await deleteDialog.waitFor({ state: "detached" });
    expect((await readConnections(client)).map((row) => row.id)).toContain(ROWS[2].id);

    await (
      await openRowMenu(page, "acme/widgets · team")
    )
      .getByRole("menuitem", { name: "Delete…" })
      .click();
    await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await deleteDialog.waitFor({ state: "detached" });
    await expect
      .poll(async () => (await readConnections(client)).map((row) => row.id))
      .not.toContain(ROWS[2].id);
    await expect
      .poll(() => readRowNames(page))
      .toEqual(["GitHub · work laptop", "Sentry · acme", "acme/widgets · ops"]);
  });

  it("shows GitHub's refusal of a pasted token under the token field, and creates no Connection", async () => {
    const { url, client } = await arrangeFleet();
    const { page } = await openSignedIn(url);
    await openConnections(page);

    const dialog = await submitGithubToken(page, FAKE_TOKEN);
    const field = dialog
      .locator(".fl")
      .filter({ has: page.getByLabel("Personal access token", { exact: true }) });
    const error = field.getByRole("alert");
    await error.waitFor();
    // The words are GitHub's when it is reachable and the controller's when
    // it is not, so the test checks only that there are some.
    expect((await error.textContent())?.trim()).not.toBe("");
    expect(await readConnections(client)).toEqual([]);

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await readRowNames(page)).toEqual([]);
  });

  it.skipIf(githubToken === undefined)(
    "creates a GitHub Connection from a real pasted token, and shows it healthy",
    async () => {
      const { url, client } = await arrangeFleet();
      const { page } = await openSignedIn(url);
      await openConnections(page);

      const dialog = await submitGithubToken(page, githubToken!);
      await dialog.waitFor({ state: "detached" });
      const [created] = await readConnections(client);
      expect(created).toMatchObject({ type: "github/github", status: "connected" });
      const name = `GitHub · ${created!.label}`;
      await expect.poll(() => readRowNames(page)).toEqual([name]);
      expect(await findRow(page, name).locator(".health").textContent()).toBe("healthy");
    },
  );
});
