/**
 * Tests Settings' frame: the ways in, the section it opens, the header, the
 * Settings list with its inert rows and its Connections dot, and the way
 * back through the sidebar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_GITHUB_CONNECTION,
  FIXTURE_THREAD_IDS,
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
afterEach(() => {
  forgetLastSettingsSection();
  vi.restoreAllMocks();
});

const CONTROLLER = {
  id: "01a06d02-7800-7000-8000-000000000001",
  publicKey: "cHVibGljLWtleQ==",
  version: "0.1.0",
  defaultRunnerId: null,
  localRunnerId: null,
};

/** The rows of the Settings list that lead nowhere yet. */
const INERT_ROWS = [
  "Threads",
  "Connections",
  "Providers",
  "Machines",
  "Identities",
  "Permission profiles",
  "Secrets",
  "Bounds",
  "Plugins",
];

/** Starts the app signed in at `path`, with the sidebar fixture and `handlers` on top. */
const startApp = async ({
  path = `/threads/${FIXTURE_THREAD_IDS.flaky}`,
  handlers = {},
}: { readonly path?: string; readonly handlers?: Readonly<Record<string, Handler>> } = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/controller": { body: CONTROLLER },
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  return { calls, fake, ...app };
};

/** Returns the Settings list. */
const findSettingsList = (): Promise<HTMLElement> =>
  screen.findByRole("navigation", { name: "Settings" });

describe("the way into Settings", () => {
  it("opens Appearance from the foot's Settings button the first time, and shows the button as pressed", async () => {
    const { router } = await startApp();
    const button = screen.getByRole("link", { name: "Settings" });
    expect(button.classList.contains("is-on")).toBe(false);

    await userEvent.click(button);

    expect(await screen.findByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/appearance");
    expect(button.classList.contains("is-on")).toBe(true);
    const list = await findSettingsList();
    expect(within(list).getByRole("link", { name: "Appearance" }).classList.contains("is-on")).toBe(
      true,
    );
    // The sidebar stays beside Settings.
    expect(screen.getByRole("navigation", { name: "Threads" })).toBeTruthy();
  });

  it("opens Settings from the app menu, and closes the project picker", async () => {
    const { fake, router } = await startApp();
    fake.sendMenuCommand("newThread");
    await screen.findByRole("dialog", { name: "New thread in" });

    fake.sendMenuCommand("openSettings");

    expect(await screen.findByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/appearance");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the section opened last, and leaves Settings through a thread's row", async () => {
    const { fake, router } = await startApp({ path: "/settings" });
    await userEvent.click(within(await findSettingsList()).getByRole("link", { name: "System" }));
    await screen.findByRole("heading", { level: 1, name: "System" });

    await userEvent.click(screen.getByRole("link", { name: /Fix flaky webhook tests/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    });
    expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" }).classList.contains("is-on")).toBe(false);

    fake.sendMenuCommand("openSettings");
    expect(await screen.findByRole("heading", { level: 1, name: "System" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/system");
  });
});

describe("the Settings list", () => {
  it("draws the book's groups and rows, in the book's order", async () => {
    await startApp({ path: "/settings/profile" });
    const list = await findSettingsList();

    expect(
      within(list)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["You", "Crew", "Safety", "System"]);
    expect([...list.querySelectorAll(".nav-row")].map((row) => row.textContent)).toEqual([
      "Profile",
      "Appearance",
      "Threads",
      "Assistants",
      "Connections",
      "Providers",
      "Machines",
      "Identities",
      "Permission profiles",
      "Secrets",
      "Bounds",
      "Plugins",
      "System",
    ]);
  });

  it("draws the rows of sections not built yet as buttons that do nothing", async () => {
    const { calls, router, live } = await startApp({ path: "/settings/profile" });
    const list = await findSettingsList();
    await live.waitForFirstPushes();
    const sent = calls.length;

    for (const name of INERT_ROWS) {
      const row = within(list).getByRole("button", { name });
      expect(row.getAttribute("aria-disabled"), name).toBe("true");
      expect(row.getAttribute("title"), name).toBe("Not built yet");
      await userEvent.click(row);
    }
    expect(router.state.location.pathname).toBe("/settings/profile");
    expect(calls).toHaveLength(sent);
  });

  it.each(["error", "needs-reauth"] as const)(
    "marks the Connections row while a Connection's status is %s",
    async (status) => {
      await startApp({
        path: "/settings/profile",
        handlers: {
          "GET /api/v1/connections": {
            body: { items: [FIXTURE_GITHUB_CONNECTION, { ...FIXTURE_GITHUB_CONNECTION, status }] },
          },
        },
      });
      const list = await findSettingsList();

      const row = within(list).getByRole("button", { name: /Connections/ });
      expect(within(row).getByRole("img", { name: "A Connection needs attention" })).toBeTruthy();
    },
  );

  it.each(["connected", "disabled"] as const)(
    "draws no dot while every Connection is %s",
    async (status) => {
      await startApp({
        path: "/settings/profile",
        handlers: {
          "GET /api/v1/connections": {
            body: { items: [{ ...FIXTURE_GITHUB_CONNECTION, status }] },
          },
        },
      });
      const list = await findSettingsList();

      expect(within(list).queryByRole("img")).toBeNull();
    },
  );
});
