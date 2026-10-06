/**
 * Tests the screen the router shows when a route fails, in the running app:
 * inside the shell when a screen under it fails, in the whole window when the
 * shell's own reads fail, and Try again in both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route as ThreadRoute } from "../routes/_connected/_shell/threads/$sessionId/index";
import {
  buildErrorBody,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  THREAD_FIXTURES,
  type Answer,
  type Handler,
} from "../app/testing";

beforeEach(() => {
  // React and the router report every error a route throws on the console.
  // Here each one is thrown on purpose.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// The tests below swap the thread route's component for one that throws, so
// each test puts the route's own component back afterwards.
const threadComponent = ThreadRoute.options.component;

afterEach(() => {
  if (threadComponent === undefined) Reflect.deleteProperty(ThreadRoute.options, "component");
  else ThreadRoute.update({ component: threadComponent });
  vi.restoreAllMocks();
});

/**
 * Starts the app signed in at `path`, with the sidebar fixture, the reads of
 * the runbook thread, and `handlers` on top.
 */
const startSignedIn = async (handlers: Readonly<Record<string, Handler>> = {}, path = "/") => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    ...buildThreadHandlers(THREAD_FIXTURES.waiting),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  return { calls, ...(await renderApp(fake, { path })) };
};

/** The answer to a read the controller fails with a server error. */
const SERVER_ERROR: Answer = {
  status: 500,
  body: buildErrorBody("internal", "The database is locked."),
};

describe("a screen inside the shell that throws", () => {
  it("fills the main pane with the failure, and leaves the sidebar standing", async () => {
    ThreadRoute.update({
      component: () => {
        throw new Error("The thread screen broke.");
      },
    });

    await startSignedIn({}, `/threads/${FIXTURE_THREAD_IDS.runbook}`);

    const main = screen.getByRole("main");
    expect(
      within(main).getByRole("heading", { level: 1, name: "This screen did not load" }),
    ).toBeTruthy();
    expect(
      within(main).getByText(
        "Something went wrong rendering it. The rest of Hercule is still here.",
      ),
    ).toBeTruthy();
    expect(within(main).getByRole("alert").textContent).toBe("The thread screen broke.");
    expect(within(main).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Threads" })).toBeTruthy();
    // The full-window form's foot is not drawn inside the shell.
    expect(screen.queryByText(`Controller at ${CONTROLLER_URL}`)).toBeNull();
  });

  it("renders the screen again on Try again", async () => {
    let broken = true;
    ThreadRoute.update({
      component: () => {
        if (broken) throw new Error("The thread screen broke.");
        return <p>The thread screen</p>;
      },
    });
    await startSignedIn({}, `/threads/${FIXTURE_THREAD_IDS.runbook}`);
    expect(screen.getByRole("alert")).toBeTruthy();

    broken = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("The thread screen")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the shell's reads failing", () => {
  it("fills the window with the failure, and names the controller", async () => {
    await startSignedIn({ "GET /api/v1/projects": SERVER_ERROR });

    expect(
      screen.getByRole("heading", { level: 2, name: "This screen did not load" }),
    ).toBeTruthy();
    // Nothing is left standing, so the lead drops its second sentence.
    expect(screen.getByText("Something went wrong rendering it.")).toBeTruthy();
    expect(screen.queryByText(/The rest of Hercule is still here/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("The database is locked.");
    expect(screen.getByText(`Controller at ${CONTROLLER_URL}`)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Threads" })).toBeNull();
  });

  it("reads again on Try again, and shows the shell once the reads succeed", async () => {
    // The first read of the projects fails. The second is held until the
    // test has seen the button say that it is trying.
    let projectReads = 0;
    const secondRead = holdAnswer();
    const { calls } = await startSignedIn({
      "GET /api/v1/projects": () => {
        projectReads += 1;
        return projectReads === 1 ? SERVER_ERROR : secondRead.handler();
      },
    });
    expect(screen.getByRole("alert")).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    const trying = await screen.findByRole("button", { name: "Trying again…" });
    expect(trying.getAttribute("aria-disabled")).toBe("true");

    secondRead.answer({ body: { items: SIDEBAR_FIXTURE.projects } });
    expect(await screen.findByRole("navigation", { name: "Threads" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.filter((call) => call.path === "/api/v1/projects")).toHaveLength(2);
  });

  it("leads to the connect screen on Change", async () => {
    const { router } = await startSignedIn({ "GET /api/v1/projects": SERVER_ERROR });

    await userEvent.setup().click(screen.getByRole("button", { name: "Change" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/connect");
    });
  });
});
