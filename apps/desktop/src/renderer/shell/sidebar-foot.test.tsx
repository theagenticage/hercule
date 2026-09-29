import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SidebarFoot } from "./sidebar-foot";

afterEach(cleanup);

/** Renders the foot with `waiting` threads waiting, and returns the element that draws that count. */
const renderWaitingCount = (waiting: number): Element => {
  const { container } = render(
    <SidebarFoot working={1} waiting={waiting} idle={3} username="rogier" />,
  );
  return container.querySelectorAll(".side-sum b")[1]!;
};

describe("SidebarFoot", () => {
  it("draws the waiting count in the attention hue when a thread is waiting", () => {
    const count = renderWaitingCount(2);

    expect(count.textContent).toBe("2");
    expect(count.classList.contains("you-ink")).toBe(true);
  });

  it("draws a waiting count of 0 like the other counts, because nothing needs the user", () => {
    const count = renderWaitingCount(0);

    expect(count.textContent).toBe("0");
    expect(count.classList.contains("you-ink")).toBe(false);
  });
});
