/**
 * Tests Settings > Connections' table: one row per Connection with its
 * health, the account line, the row's ⋯ menu, Delete with its
 * confirmation, a dialog whose Connection is removed elsewhere, Add a
 * Connection's list of types, the note shown with no Connection, and the
 * rows that lead here from the Settings list and the Hercule face.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GITHUB_CONNECTION_TYPE, type Connection, type PluginDetail } from "@hercule/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_GITHUB_CONNECTION,
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Handler,
} from "../../../../app/testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

// The sidebar's thread list draws only the rows that fit its height.
beforeEach(() => {
  stubElementSize(272, 800);
});

// The section opened last is kept in memory for as long as the app runs,
// which in a test file is every test.
afterEach(forgetLastSettingsSection);

/**
 * Builds an installed, active plugin named `displayName` that declares
 * `contributions`.
 */
const buildPlugin = (
  id: string,
  displayName: string,
  contributions: PluginDetail["contributions"],
): PluginDetail => ({
  id,
  displayName,
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions,
  intake: { eventKinds: [], signalKinds: [] },
});

/** The GitHub plugin, declaring its Connection type with a device flow and a pasted token. */
const GITHUB = buildPlugin("github", "GitHub", [
  {
    extensionPoint: "connection-type",
    id: GITHUB_CONNECTION_TYPE,
    definition: {
      type: GITHUB_CONNECTION_TYPE,
      displayName: "GitHub",
      setup: [
        { kind: "device" },
        { kind: "credentials", fields: [{ name: "token", label: "Token" }] },
      ],
    },
  },
]);

/** A plugin named unlike its type, whose type is set up with an API key. */
const PAPER_TRAIL = buildPlugin("paper-trail", "Paper Trail", [
  {
    extensionPoint: "connection-type",
    id: "paper-trail/paper",
    definition: {
      type: "paper-trail/paper",
      displayName: "Paper",
      setup: [{ kind: "credentials", fields: [{ name: "key", label: "API key" }] }],
    },
  },
]);

/** Builds a GitHub Connection labelled `label`, with `overrides` on top. */
const buildConnection = (
  id: string,
  label: string,
  overrides: Partial<Connection> = {},
): Connection => ({
  ...FIXTURE_GITHUB_CONNECTION,
  id: `01a06d02-7700-7000-8000-0000000000${id}`,
  type: GITHUB_CONNECTION_TYPE,
  label,
  displayName: label,
  ...overrides,
});

const HEALTHY = buildConnection("01", "rogier");
const SIGN_IN = buildConnection("02", "work", {
  status: "needs-reauth",
  displayName: "rogier-acme",
});
const PAUSED = buildConnection("03", "old", { status: "disabled" });
const FAILING = buildConnection("04", "bot", {
  status: "error",
  statusDetail: "GitHub refused the token: it was revoked",
});
/** A Connection whose plugin is no longer installed. */
const ORPHAN = buildConnection("05", "widgets", { type: "acme/widgets" });

/**
 * Opens Settings > Connections with `connections`, the GitHub and Paper
 * Trail plugins, and `handlers` on top.
 */
const openConnections = async ({
  connections = [HEALTHY, SIGN_IN, PAUSED, FAILING, ORPHAN],
  plugins = [GITHUB, PAPER_TRAIL],
  handlers = {},
}: {
  readonly connections?: ReadonlyArray<Connection>;
  readonly plugins?: ReadonlyArray<PluginDetail>;
  readonly handlers?: Readonly<Record<string, Handler>>;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, plugins: [...plugins] }),
    "GET /api/v1/connections": { body: { items: connections } },
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path: "/settings/connections" });
  await screen.findByRole("heading", { level: 1, name: "Connections" });
  return { calls, ...app };
};

/** Returns the row whose name reads `name`, such as "GitHub · rogier". */
const getRow = (name: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>(".connection-list .conn")].find(
    (row) => row.querySelector(".nm > b")?.textContent === name,
  )!;

/**
 * Presses the button `button` and returns the menu it opens, checking that
 * the menu is named as the button is. jsdom has no popover API, so the
 * accessibility tree leaves the menu out, and it is found by the button's
 * `popovertarget` instead.
 */
const openMenu = async (button: HTMLElement): Promise<HTMLElement> => {
  await userEvent.click(button);
  const menu = document.getElementById(button.getAttribute("popovertarget")!)!;
  expect(menu.getAttribute("role")).toBe("menu");
  expect(menu.getAttribute("aria-label")).toBe(
    button.getAttribute("aria-label") ?? button.textContent,
  );
  return menu;
};

/** Returns the menu of the row named `name`, after its ⋯ button is pressed. */
const openRowMenu = (name: string): Promise<HTMLElement> =>
  openMenu(screen.getByRole("button", { name: `More for ${name}` }));

/** Presses the item `name` of the menu `menu`, which jsdom counts as hidden. */
const chooseItem = async (menu: HTMLElement, name: string): Promise<void> => {
  await userEvent.click(within(menu).getByRole("menuitem", { name, hidden: true }), {
    pointerEventsCheck: 0,
  });
};

describe("Settings > Connections", () => {
  it("draws one row per Connection with its health, and the fail look only on an error", async () => {
    await openConnections();

    const rows = [...document.querySelectorAll<HTMLElement>(".connection-list .conn")];
    expect(rows.map((row) => row.querySelector(".nm > b")!.textContent)).toEqual([
      "GitHub · rogier",
      "GitHub · work",
      "GitHub · old",
      "GitHub · bot",
      // The type is no longer in the binary, so its id stands in for its name.
      "acme/widgets · widgets",
    ]);
    expect(rows.map((row) => row.querySelector(".health")!.textContent)).toEqual([
      "healthy",
      "needs sign-in",
      "disabled",
      "GitHub refused the token: it was revoked",
      "healthy",
    ]);
    expect(rows.filter((row) => row.classList.contains("is-fail"))).toEqual([
      getRow("GitHub · bot"),
    ]);
    const failing = getRow("GitHub · bot").querySelector(".health")!;
    expect(failing.classList.contains("health--fail")).toBe(true);
    expect(failing.querySelector(".dot--fail")).not.toBeNull();
    expect(failing.getAttribute("title")).toBe("GitHub refused the token: it was revoked");
    expect(
      document.querySelectorAll(".connection-list .health--fail, .connection-list .dot--fail"),
    ).toHaveLength(2);
  });

  it("shows the account under the name only when it is not the label", async () => {
    await openConnections();

    expect(getRow("GitHub · work").querySelector(".nm > span")!.textContent).toBe("rogier-acme");
    expect(getRow("GitHub · rogier").querySelector(".nm > span")).toBeNull();
  });

  it("offers Reconnect, Configure and Delete in a row's menu", async () => {
    await openConnections();

    const menu = await openRowMenu("GitHub · rogier");

    const items = within(menu).getAllByRole("menuitem", { hidden: true });
    expect(items.map((item) => item.textContent)).toEqual(["Reconnect…", "Configure…", "Delete…"]);
    expect(items.some((item) => item.hasAttribute("aria-disabled"))).toBe(false);
  });

  it("disables Reconnect, and says why, for a type that is no longer installed", async () => {
    await openConnections();

    const menu = await openRowMenu("acme/widgets · widgets");

    const reconnect = within(menu).getByRole("menuitem", { name: "Reconnect…", hidden: true });
    expect(reconnect.getAttribute("aria-disabled")).toBe("true");
    expect(reconnect.getAttribute("title")).toMatch(/plugin is not installed/);
    await chooseItem(menu, "Reconnect…");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deletes a Connection once the user confirms, and closes the dialog", async () => {
    let stored: Connection[] = [HEALTHY, SIGN_IN];
    const { calls } = await openConnections({
      connections: stored,
      handlers: {
        "GET /api/v1/connections": () => ({ body: { items: stored } }),
        [`DELETE /api/v1/connections/${SIGN_IN.id}`]: () => {
          stored = stored.filter((each) => each.id !== SIGN_IN.id);
          return { body: {} };
        },
      },
    });

    await chooseItem(await openRowMenu("GitHub · work"), "Delete…");
    const dialog = await screen.findByRole("dialog", { name: "Delete GitHub · work?" });
    expect(dialog.textContent).toContain(
      "Hercule forgets this Connection's credentials, but does not revoke them at GitHub.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/api/v1/connections/${SIGN_IN.id}`,
    ]);
    await waitFor(() => {
      expect(getRow("GitHub · work")).toBeUndefined();
    });
    expect(getRow("GitHub · rogier")).toBeDefined();
    // The user's own delete is not reported as a removal elsewhere.
    expect(document.querySelector(".set-note")).toBeNull();
  });

  it("counts a Connection already gone as deleted", async () => {
    let stored: Connection[] = [HEALTHY, SIGN_IN];
    await openConnections({
      connections: stored,
      handlers: {
        "GET /api/v1/connections": () => ({ body: { items: stored } }),
        // Removed elsewhere a moment before the user pressed Delete.
        [`DELETE /api/v1/connections/${HEALTHY.id}`]: () => {
          stored = [SIGN_IN];
          return { status: 404, body: buildErrorBody("not_found", "No such Connection.") };
        },
      },
    });

    await chooseItem(await openRowMenu("GitHub · rogier"), "Delete…");
    const dialog = await screen.findByRole("dialog", { name: "Delete GitHub · rogier?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(getRow("GitHub · rogier")).toBeUndefined();
    expect(document.querySelector(".set-note")).toBeNull();
  });

  it("keeps a dialog opened since when an earlier Delete answers late", async () => {
    let stored: Connection[] = [HEALTHY, SIGN_IN];
    const held = holdAnswer();
    await openConnections({
      connections: stored,
      handlers: {
        "GET /api/v1/connections": () => ({ body: { items: stored } }),
        [`DELETE /api/v1/connections/${SIGN_IN.id}`]: held.handler,
      },
    });
    await chooseItem(await openRowMenu("GitHub · work"), "Delete…");
    const deleting = await screen.findByRole("dialog", { name: "Delete GitHub · work?" });
    await userEvent.click(within(deleting).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(deleting).getByRole("button", { name: "Cancel" }));
    await chooseItem(await openRowMenu("GitHub · rogier"), "Configure…");
    await screen.findByRole("dialog", { name: "Configure GitHub · rogier" });

    stored = [HEALTHY];
    held.answer({ body: {} });

    await waitFor(() => {
      expect(getRow("GitHub · work")).toBeUndefined();
    });
    expect(screen.getByRole("dialog", { name: "Configure GitHub · rogier" })).toBeDefined();
  });

  it("closes a dialog whose Connection is removed elsewhere, and says why", async () => {
    let stored: Connection[] = [HEALTHY, SIGN_IN];
    const { context } = await openConnections({
      connections: stored,
      handlers: { "GET /api/v1/connections": () => ({ body: { items: stored } }) },
    });
    await chooseItem(await openRowMenu("GitHub · work"), "Delete…");
    await screen.findByRole("dialog", { name: "Delete GitHub · work?" });

    stored = [HEALTHY];
    await context.queryClient.invalidateQueries();

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("status").textContent).toBe(
      "GitHub · work was deleted elsewhere, so its dialog closed.",
    );

    // The line goes once the user opens another dialog.
    await chooseItem(await openRowMenu("GitHub · rogier"), "Delete…");
    await screen.findByRole("dialog", { name: "Delete GitHub · rogier?" });
    expect(document.querySelector(".set-note")).toBeNull();
  });

  it("names the type's id as the provider when the type is no longer installed", async () => {
    await openConnections();

    await chooseItem(await openRowMenu("acme/widgets · widgets"), "Delete…");

    const dialog = await screen.findByRole("dialog", { name: "Delete acme/widgets · widgets?" });
    expect(dialog.textContent).toContain("does not revoke them at acme/widgets.");
  });

  it("shows the controller's refusal in the dialog, which stays open", async () => {
    await openConnections({
      handlers: {
        [`DELETE /api/v1/connections/${HEALTHY.id}`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "A workflow still uses this Connection."),
        },
      },
    });

    await chooseItem(await openRowMenu("GitHub · rogier"), "Delete…");
    const dialog = await screen.findByRole("dialog", { name: "Delete GitHub · rogier?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const error = await within(dialog).findByRole("alert");
    expect(error.textContent).toBe("Could not delete: A workflow still uses this Connection.");
    expect(getRow("GitHub · rogier")).toBeDefined();
  });

  it("lists every Connection type in Add a Connection, with what its setup takes", async () => {
    await openConnections();

    const menu = await openMenu(screen.getByRole("button", { name: "Add a Connection" }));

    expect(
      within(menu)
        .getAllByRole("menuitem", { hidden: true })
        .map((item) => [
          item.querySelector("b")!.textContent,
          item.querySelector("b + span")!.textContent,
        ]),
    ).toEqual([
      ["GitHub", "sign in with GitHub or paste a token"],
      // The plugin is named unlike its type, so its name comes first.
      ["Paper", "Paper Trail · enter your API key"],
    ]);
  });

  it("cannot open Add a Connection when no plugin offers a type", async () => {
    await openConnections({ plugins: [] });

    const add = screen.getByRole("button", { name: "Add a Connection" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.getAttribute("title")).toBe("No installed plugin offers a Connection type.");
    expect(add.hasAttribute("popovertarget")).toBe(false);
  });

  it("shows a note in place of the table when there is no Connection", async () => {
    await openConnections({ connections: [] });

    const note = document.querySelector(".connection-list .set-empty")!;
    expect(note.querySelector("b")!.textContent).toBe("No Connections yet");
    expect(note.querySelector("span")!.textContent).toMatch(/Add one with Add a Connection\.$/);
    expect(document.querySelector(".connection-list .tbl-h")).toBeNull();
  });

  it("says no plugin offers a type when there is nothing to add", async () => {
    await openConnections({ connections: [], plugins: [] });

    expect(document.querySelector(".connection-list .set-empty span")!.textContent).toBe(
      "No installed plugin offers a Connection type, so there is nothing to add yet.",
    );
  });
});

describe("the ways into Settings > Connections", () => {
  /** Opens the app on Settings > Profile with one GitHub Connection. */
  const openProfile = async () => {
    stubApi({
      ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, plugins: [GITHUB] }),
      "GET /api/v1/connections": { body: { items: [HEALTHY] } },
    });
    const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
    const app = await renderApp(fake, { path: "/settings/profile" });
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    return app;
  };

  it("opens from the Settings list's Connections row", async () => {
    const { router } = await openProfile();
    const list = screen.getByRole("navigation", { name: "Settings" });

    await userEvent.click(within(list).getByRole("link", { name: "Connections" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Connections" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/connections");
  });

  it("opens from the Hercule face's Connections row", async () => {
    const { router } = await openProfile();
    await userEvent.click(
      within(screen.getByRole("tablist", { name: "Sidebar" })).getByRole("tab", {
        name: "Hercule",
      }),
    );
    const face = screen.getByRole("navigation", { name: "Hercule" });

    await userEvent.click(within(face).getByRole("link", { name: "Connections" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Connections" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/connections");
  });
});
