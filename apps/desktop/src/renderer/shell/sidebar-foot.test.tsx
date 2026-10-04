import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { SidebarFoot } from "./sidebar-foot";

afterEach(cleanup);

/**
 * Renders the foot with `waiting` threads waiting, and returns the element
 * that draws that count. The foot's Settings button is a link, so the foot
 * renders inside a router of one route.
 */
const renderWaitingCount = async (waiting: number): Promise<Element> => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <SidebarFoot working={1} waiting={waiting} idle={3} username="rogier" />,
    }),
    history: createMemoryHistory(),
  });
  await router.load();
  const { container } = render(<RouterProvider router={router} />);
  return container.querySelectorAll(".side-sum b")[1]!;
};

describe("SidebarFoot", () => {
  it("draws the waiting count in the attention hue when a thread is waiting", async () => {
    const count = await renderWaitingCount(2);

    expect(count.textContent).toBe("2");
    expect(count.classList.contains("you-ink")).toBe(true);
  });

  it("draws a waiting count of 0 like the other counts, because nothing needs the user", async () => {
    const count = await renderWaitingCount(0);

    expect(count.textContent).toBe("0");
    expect(count.classList.contains("you-ink")).toBe(false);
  });
});
