/**
 * Tests the project picker as the sidebar's New thread opens it: its rows,
 * the keys that move between them and pick one, and the ways it closes.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
} from "../../app/testing";

const [WEBSHOP, OPS] = SIDEBAR_FIXTURE.projects;

/** Where the tests start: a thread, so a draft that opens is the picker's doing. */
const THREAD_PATH = `/threads/${FIXTURE_THREAD_IDS.flaky}`;

/**
 * Opens the app signed in at a thread, presses New thread, and returns the
 * picker's dialog and its rows with the app.
 */
const openPicker = async () => {
  stubApi(buildSidebarHandlers(SIDEBAR_FIXTURE));
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: THREAD_PATH },
  );
  await userEvent.click(await screen.findByRole("button", { name: "New thread ⌘N" }));
  const dialog = await screen.findByRole<HTMLDialogElement>("dialog", { name: "New thread in" });
  const rows = within(dialog).getAllByRole("button");
  return { dialog, rows, ...app };
};

describe("the project picker", () => {
  it("lists each project with what it holds and its shortcut, with the focus on the first", async () => {
    const { rows } = await openPicker();

    expect(rows.map((row) => row.textContent)).toEqual([
      "webshop" + "1 repo · webshop · 3 threads · 1 workspace" + "⌘1",
      "ops" + "2 repos · ops-infra, ops-runbooks · 1 thread · 0 workspaces" + "⌘2",
    ]);
    expect(document.activeElement).toBe(rows[0]);
  });

  it("moves the focus with ↓ and ↑, going round at either end", async () => {
    const { rows } = await openPicker();

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[0]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows[1]);
  });

  it("opens a Draft Thread in the focused project with ⏎, and closes", async () => {
    const { router } = await openPicker();

    await userEvent.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => {
      expect(router.state.location.href).toBe(`/?project=${OPS!.id}`);
    });
    expect(screen.queryByRole("dialog", { name: "New thread in" })).toBeNull();
  });

  it("opens a Draft Thread in the nth project with ⌘n, and ignores a number with no project", async () => {
    const { dialog, router } = await openPicker();

    await userEvent.keyboard("{Meta>}3{/Meta}");
    expect(dialog.open).toBe(true);
    expect(router.state.location.pathname).toBe(THREAD_PATH);

    await userEvent.keyboard("{Meta>}1{/Meta}");
    await waitFor(() => {
      expect(router.state.location.href).toBe(`/?project=${WEBSHOP!.id}`);
    });
    expect(screen.queryByRole("dialog", { name: "New thread in" })).toBeNull();
  });

  it("opens a Draft Thread in the project that is clicked", async () => {
    const { rows, router } = await openPicker();

    await userEvent.click(rows[1]!);

    await waitFor(() => {
      expect(router.state.location.href).toBe(`/?project=${OPS!.id}`);
    });
  });

  it("closes without opening a draft on Esc", async () => {
    const { router } = await openPicker();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New thread in" })).toBeNull();
    });
    expect(router.state.location.pathname).toBe(THREAD_PATH);
  });

  it("closes without opening a draft on a click on the scrim, and stays open on a click inside", async () => {
    const { dialog, router } = await openPicker();

    await userEvent.click(within(dialog).getByText("New thread in"));
    expect(dialog.open).toBe(true);

    // A click on the scrim lands on the dialog element itself.
    await userEvent.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New thread in" })).toBeNull();
    });
    expect(router.state.location.pathname).toBe(THREAD_PATH);
  });

  it("stays open when a press inside it is released on the scrim", async () => {
    const { dialog } = await openPicker();

    // The browser fires the click of such a drag, which selects text, on the
    // dialog element itself, as it fires a click on the scrim.
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: within(dialog).getByText("New thread in") },
      { target: dialog },
      { keys: "[/MouseLeft]" },
    ]);

    expect(dialog.open).toBe(true);
  });
});
