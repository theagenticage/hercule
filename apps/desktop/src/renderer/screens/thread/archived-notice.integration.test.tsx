/**
 * Tests the page of an archived Thread as the app opens it, such as from a
 * notification: the transcript, a line with a New thread button where the
 * composer would be, and no row for the thread in the sidebar.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
} from "../../app/testing";

const FINISHED = THREAD_FIXTURES.finished;

/** The finished thread after the user archived it. */
const ARCHIVED_THREAD = {
  ...FINISHED,
  session: {
    ...FINISHED.session,
    status: "exited",
    resumable: false,
    exitedAt: "2026-09-10T09:20:00.000Z",
    done: { at: "2026-09-10T09:21:00.000Z", by: "user" },
    archived: { at: "2026-09-10T09:22:00.000Z", by: "user" },
  },
} as const;

/** Opens the archived thread, which the sidebar's read leaves out, as it leaves out every archived one. */
const openArchivedThread = async () => {
  stubElementSize(800, 800);
  vi.stubEnv("TZ", "Europe/Amsterdam");
  stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      threads: SIDEBAR_FIXTURE.threads.filter((each) => each.id !== FINISHED.session.id),
    }),
    ...buildThreadHandlers(ARCHIVED_THREAD),
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: `/threads/${FINISHED.session.id}` },
  );
  await screen.findByText("This thread is archived. Start a new thread to carry on.");
  return app;
};

describe("the page of an archived thread", () => {
  it("draws a line with a New thread button in the composer's place", async () => {
    await openArchivedThread();

    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    const frame = document.querySelector(".composer-wrap .composer")!;
    expect(within(frame as HTMLElement).getByRole("link", { name: "New thread" })).toBeTruthy();
  });

  it("opens a Draft Thread in the thread's project, not its workspace, when New thread is pressed", async () => {
    const user = userEvent.setup();
    const { router } = await openArchivedThread();

    await user.click(screen.getByRole("link", { name: "New thread" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    // The workspace is not carried over: archiving it was final.
    expect(router.state.location.search).toEqual({ project: ARCHIVED_THREAD.session.projectId });
  });

  it("gives the open archived thread no row in the sidebar", async () => {
    await openArchivedThread();

    const nav = screen.getByRole("navigation", { name: "Threads" });
    expect(within(nav).queryByText(FINISHED.session.title)).toBeNull();
  });
});
