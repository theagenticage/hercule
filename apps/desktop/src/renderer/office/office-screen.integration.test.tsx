/**
 * Tests the Office screen in the running app: its keys, its dossier card,
 * its thread drawer, and the `session` search param that names the thread
 * the drawer shows. The tests check that:
 *
 * - Tab on the Office selects the colleague who has waited longest;
 * - Tab on one of the card's controls moves the focus and keeps the selection;
 * - selecting a colleague reads its thread, so the drawer opens on it at once;
 * - Enter and Open thread open the drawer, and the param follows;
 * - the param opens the drawer, and Escape steps back from the drawer to the
 *   card, then from the card to nothing;
 * - the drawer's header has no side pane toggle, because the drawer has no
 *   side pane.
 *
 * jsdom draws no WebGL, so a stub that draws nothing stands in for the 3D
 * scene. Everything around the scene is the code that ships.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@hercule/contract";
import { queryKeys } from "@hercule/client-core";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  THREAD_FIXTURES,
} from "../app/testing";
import { readOffice } from "./office-store";

vi.mock("./office-scene", () => ({
  mountOfficeScene: () => ({ setWorld: () => undefined, dispose: () => undefined }),
}));

/** Returns the sidebar fixture's thread with id `id`. */
const findFixtureThread = (id: string): Session =>
  SIDEBAR_FIXTURE.threads.find((thread) => thread.id === id)!;

const runbook = findFixtureThread(FIXTURE_THREAD_IDS.runbook);

/**
 * "Fix flaky webhook tests", waiting on its own command approval since after
 * the runbook started waiting. Its desk comes before the runbook's, so the
 * queue's order and the desks' order differ.
 */
const flakyAsking: Session = {
  ...findFixtureThread(FIXTURE_THREAD_IDS.flaky),
  openRequests: [{ ...runbook.openRequests[0]!, requestId: "req-2", itemId: "tool-2" }],
  lastActivityAt: "2026-09-10T09:06:00.000Z",
};

/**
 * Starts the app signed in at `path`, with the sidebar fixture's threads and
 * `flakyAsking` in place of the working flaky thread, so two colleagues wait.
 * The waiting runbook's thread answers its reads, for the drawer.
 */
const openOffice = async (path = "/office") => {
  stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      threads: SIDEBAR_FIXTURE.threads.map((thread) =>
        thread.id === flakyAsking.id ? flakyAsking : thread,
      ),
    }),
    ...buildThreadHandlers(THREAD_FIXTURES.waiting),
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  await screen.findByRole("group", { name: "Who is doing what" });
  return { user: userEvent.setup(), ...app };
};

/** Returns the dossier card of the colleague named `name`. */
const findCard = (name: string): HTMLElement => screen.getByRole("dialog", { name });

/** Returns the thread drawer. */
const findDrawer = (): HTMLElement => screen.getByRole("complementary", { name: "Thread" });

describe("Tab on the Office", () => {
  it("selects the colleague who has waited longest, and leaves the focus where it was", async () => {
    const { user } = await openOffice();

    await user.tab();

    expect(readOffice().selectedId).toBe(runbook.id);
    expect(findCard(runbook.title).dataset.open).toBe("true");
    expect(document.activeElement).toBe(document.body);

    await user.tab();

    expect(readOffice().selectedId).toBe(flakyAsking.id);
  });

  it("moves the focus inside the card, and keeps the selection", async () => {
    const { user } = await openOffice();
    await user.tab();
    const card = findCard(runbook.title);
    const close = within(card).getByRole("button", { name: "Close" });
    close.focus();

    await user.tab();

    expect(document.activeElement).not.toBe(close);
    expect(card.contains(document.activeElement)).toBe(true);
    expect(readOffice().selectedId).toBe(runbook.id);
  });
});

describe("the thread drawer", () => {
  it("has the selected colleague's thread read before it opens", async () => {
    const { user, context } = await openOffice();

    await user.tab();

    await waitFor(() => {
      expect(context.queryClient.getQueryData(queryKeys.transcript(runbook.id))).toEqual(
        THREAD_FIXTURES.waiting.transcript,
      );
    });
    expect(context.queryClient.getQueryData(queryKeys.session(runbook.id))).toBeDefined();
    expect(context.queryClient.getQueryData(queryKeys.inputs(runbook.id))).toBeDefined();
  });

  it("opens on Enter, and the session param names its thread", async () => {
    const { user, router } = await openOffice();
    await user.tab();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ session: runbook.id });
    });
    expect(findDrawer().dataset.open).toBe("true");
    expect(findCard(runbook.title).dataset.open).toBe("false");
  });

  it("opens from the card's Open thread", async () => {
    const { user, router } = await openOffice();
    await user.tab();

    await user.click(screen.getByRole("button", { name: /Open thread/ }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ session: runbook.id });
    });
    expect(findDrawer().dataset.open).toBe("true");
  });

  it("opens on the thread the session param names, and Escape steps back one level at a time", async () => {
    const { user, router } = await openOffice(`/office?session=${runbook.id}`);
    expect(findDrawer().dataset.open).toBe("true");
    (document.activeElement as HTMLElement | null)?.blur();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(findDrawer().dataset.open).toBe("false");
    expect(findCard(runbook.title).dataset.open).toBe("true");

    await user.keyboard("{Escape}");

    expect(readOffice().selectedId).toBeNull();
    expect(findCard(runbook.title).dataset.open).toBe("false");
  });

  it("draws no side pane toggle in the drawer's header, because the drawer has no side pane", async () => {
    await openOffice(`/office?session=${runbook.id}`);

    const drawer = findDrawer();
    expect(
      await within(drawer).findByRole("navigation", { name: "Threads in this workspace" }),
    ).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: /side pane/ })).toBeNull();
  });
});
