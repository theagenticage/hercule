/**
 * Tests the card that shows a workflow's name in full on a row of the open
 * card: it shows only for a name that is cut off, after the pointer rests on
 * the name or at once for the keyboard's focus, and it goes when either goes.
 * jsdom has no layout, so a test says which names are cut off by giving the
 * name's element a `scrollWidth` wider than its `clientWidth`.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { partitionOffers } from "@hercule/client-core/inbox";
import { buildWorkflowOffer } from "@hercule/client-core/inbox/testing";
import { OpenCardHandRows } from "./open-card-hand";

const LONG_NAME = "Request changes on a pull request";
const SHORT_NAME = "Agent review";
const kinds = ["github/review-requested"];

/** Renders the Hand to rows for the two workflows, and returns the name element of each. */
const renderRows = () => {
  render(
    <OpenCardHandRows
      offers={partitionOffers([
        buildWorkflowOffer(LONG_NAME, kinds),
        buildWorkflowOffer(SHORT_NAME, kinds),
      ])}
      openKinds={kinds}
      actingConnections={[]}
      chosenConnectionId={undefined}
      onChooseConnection={vi.fn()}
      onHand={vi.fn()}
    />,
  );
  const nameOf = (text: string): HTMLElement =>
    screen.getByText(text, { selector: ".open-card-name" });
  // The long name is cut off at 100px of its 200px; the short one fits.
  Object.defineProperty(nameOf(LONG_NAME), "scrollWidth", { value: 200 });
  Object.defineProperty(nameOf(LONG_NAME), "clientWidth", { value: 100 });
  Object.defineProperty(nameOf(SHORT_NAME), "scrollWidth", { value: 80 });
  Object.defineProperty(nameOf(SHORT_NAME), "clientWidth", { value: 80 });
  return { nameOf };
};

/** Returns the cards on the page that show a name in full. */
const findNameCards = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".open-card-name-card"));

describe("the card of a cut-off workflow name", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the whole name once the pointer has rested on a name that is cut off", () => {
    const { nameOf } = renderRows();
    fireEvent.pointerEnter(nameOf(LONG_NAME));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(findNameCards()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(findNameCards().map((card) => card.textContent)).toEqual([LONG_NAME]);
  });

  it("shows nothing for a name that fits", () => {
    const { nameOf } = renderRows();
    fireEvent.pointerEnter(nameOf(SHORT_NAME));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(findNameCards()).toHaveLength(0);
  });

  it("shows nothing when the pointer leaves before it rests, and hides the card when it leaves", () => {
    const { nameOf } = renderRows();
    fireEvent.pointerEnter(nameOf(LONG_NAME));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerLeave(nameOf(LONG_NAME));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(findNameCards()).toHaveLength(0);

    fireEvent.pointerEnter(nameOf(LONG_NAME));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(findNameCards()).toHaveLength(1);
    fireEvent.pointerLeave(nameOf(LONG_NAME));
    expect(findNameCards()).toHaveLength(0);
  });

  it("hides the card when the row is pressed", () => {
    const { nameOf } = renderRows();
    fireEvent.pointerEnter(nameOf(LONG_NAME));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerDown(nameOf(LONG_NAME));
    expect(findNameCards()).toHaveLength(0);
  });

  it("shows the whole name at once for the keyboard's focus on a cut-off name, and hides it when the focus goes", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderRows();
    await user.tab();
    expect(document.activeElement?.textContent).toContain(LONG_NAME);
    expect(findNameCards().map((card) => card.textContent)).toEqual([LONG_NAME]);
    await user.tab();
    expect(findNameCards()).toHaveLength(0);
  });
});
