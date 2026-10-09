import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { AssistantRow, SessionPose } from "@hercule/client-core";
import { AssistantsSection } from "./assistants-section";

afterEach(cleanup);

/** Returns the row of an assistant named and identified `name`, in `pose`, with no session. */
const buildRow = (name: string, pose: SessionPose): AssistantRow => ({
  id: name.toLowerCase(),
  name,
  pose,
  session: null,
});

/**
 * Renders the section for `rows` at `path`. The rows are links to an
 * assistant's screen, so the section renders inside a router that has that
 * route, drawn empty.
 */
const renderSection = async (
  rows: readonly AssistantRow[],
  path = "/",
): Promise<{ readonly container: HTMLElement }> => {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AssistantsSection rows={rows} officeOpen={false} />
        <Outlet />
      </>
    ),
  });
  const assistantRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/assistants/$assistantId",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([assistantRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
};

describe("AssistantsSection", () => {
  it.each<[SessionPose, string]>([
    ["idle", "idle"],
    ["working", "working"],
    ["waiting", "waiting on you"],
    ["asleep", "asleep"],
    ["away", "can't be reached"],
  ])(
    "draws an assistant that is %s with a still face, its name and the pose's word",
    async (pose, word) => {
      await renderSection([buildRow("Ada", pose)]);

      const row = screen.getByRole("link", { name: `Ada, ${word}` });
      expect(row.getAttribute("href")).toBe("/assistants/ada");
      expect(row.querySelector(".cr--animated")).toBeNull();
      expect(row.querySelector(".side-name")?.textContent).toBe("Ada");
      const end = row.querySelector(".side-presence")!;
      expect(end.textContent).toBe(word);
      expect(end.classList.contains("you-ink")).toBe(pose === "waiting");
    },
  );

  it("lists every assistant, in the order given, under its heading", async () => {
    await renderSection([buildRow("Ada", "idle"), buildRow("Milo", "working")]);

    const section = screen.getByRole("navigation", { name: "Assistants" });
    expect(within(section).getByRole("heading").textContent).toBe("Assistants");
    expect(
      within(section)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Adaidle", "Miloworking"]);
  });

  it("marks the row of the assistant whose screen is open as selected", async () => {
    await renderSection([buildRow("Ada", "idle"), buildRow("Milo", "idle")], "/assistants/milo");

    const milo = screen.getByRole("link", { name: "Milo, idle" });
    expect(milo.classList.contains("is-on")).toBe(true);
    expect(milo.getAttribute("aria-current")).toBe("page");
    const ada = screen.getByRole("link", { name: "Ada, idle" });
    expect(ada.classList.contains("is-on")).toBe(false);
    expect(ada.getAttribute("aria-current")).toBeNull();
  });

  it("draws nothing when there are no assistants", async () => {
    const { container } = await renderSection([]);

    expect(container.querySelector(".side-sec--who")).toBeNull();
  });
});
