import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { stubResizeObserver, THREAD_FIXTURES } from "../../app/testing";
import { renderThreadPart } from "../thread/testing";
import { UserMessage } from "./messages";

it("shows the HTML a user typed as text, not as elements", () => {
  const { container } = render(
    <UserMessage
      text="make it <b>bold</b>"
      attachments={[]}
      at="2026-09-29T09:14:00.000Z"
      timezone="UTC"
      today={Date.UTC(2026, 8, 29)}
    />,
  );

  expect(screen.getByText("make it <b>bold</b>")).toBeTruthy();
  expect(container.querySelector("b")).toBeNull();
});

describe("a long message", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Renders a message whose text is `height` pixels tall, as the browser lays it out. */
  const renderMessageOfHeight = (height: number) => {
    const resize = stubResizeObserver();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(height);
    render(
      <UserMessage
        text="a message"
        attachments={[]}
        at="2026-09-29T09:14:00.000Z"
        timezone="UTC"
        today={Date.UTC(2026, 8, 29)}
      />,
    );
    act(() => {
      resize();
    });
  };
  const text = (): HTMLElement => document.querySelector(".bubble-text")!;

  it("is drawn in full, with no button, when it is 10 lines or shorter", () => {
    renderMessageOfHeight(217);

    expect(screen.queryByRole("button")).toBeNull();
    expect(text().style.maxHeight).toBe("");
  });

  it("is collapsed, and its button opens it in full and collapses it again", () => {
    renderMessageOfHeight(400);

    const button = screen.getByRole("button", { name: "Show full message" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(text().style.maxHeight).toBe("162px");

    fireEvent.click(button);
    expect(button.textContent).toBe("Show less");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(text().style.maxHeight).toBe("");

    fireEvent.click(button);
    expect(button.textContent).toBe("Show full message");
    expect(text().style.maxHeight).toBe("162px");
  });
});

const THREAD = THREAD_FIXTURES.finished;
const SKILLS_PATH = `/api/v1/sessions/${THREAD.session.id}/skills`;
const REVIEW = { source: "library", name: "review", description: "Review a diff" };

/**
 * Renders a user message with `text` that the runner translated `skills` of,
 * for a session whose skills are `items`.
 */
const renderMessage = (text: string, skills: readonly string[], items: readonly object[]) =>
  renderThreadPart(
    () => (
      <UserMessage
        text={text}
        attachments={[]}
        at="2026-09-29T09:14:00.000Z"
        timezone="UTC"
        today={Date.UTC(2026, 8, 29)}
        skills={skills}
        sessionId={THREAD.session.id}
      />
    ),
    {
      thread: THREAD,
      handlers: { [`GET ${SKILLS_PATH}`]: () => ({ body: { items, skipped: [] } }) },
    },
  );

// jsdom cannot tell whether a popover is open, so the card's presence in the DOM is what is tested.
const queryCard = (): HTMLElement | null => screen.queryByRole("tooltip", { hidden: true });

describe("the skill chips in a message", () => {
  it("draws a chip for a skill the runner translated, with the hover card of the session's skill", async () => {
    await renderMessage("please $review the diff", ["review"], [REVIEW]);

    const chip = document.querySelector(".skill-chip")!;
    expect(chip.textContent).toBe("review");
    expect(document.querySelector(".bubble")!.textContent).toBe("please review the diff");
    expect(chip.getAttribute("data-placement")).toBe("message");
    // The card needs the session's skill, which arrives with the read.
    fireEvent.pointerEnter(chip);
    await waitFor(() => {
      expect(queryCard()?.textContent).toContain("Review a diff");
    });
  });

  it("keeps a typo as text, because the runner translated no skill by that name", async () => {
    await renderMessage("please $reveiw the diff", [], [REVIEW]);

    expect(document.querySelector(".skill-chip")).toBeNull();
    expect(screen.getByText("please $reveiw the diff")).toBeTruthy();
  });

  it("draws only the translated names, though the session has the other skill too", async () => {
    await renderMessage(
      "$review then $debug",
      ["review"],
      [REVIEW, { source: "library", name: "debug", description: "Debug" }],
    );

    expect([...document.querySelectorAll(".skill-chip")].map((chip) => chip.textContent)).toEqual([
      "review",
    ]);
    expect(document.querySelector(".bubble")!.textContent).toBe("review then $debug");
  });

  it("keeps the chip of a skill the session no longer has, with no hover card", async () => {
    await renderMessage("run $gone now", ["gone"], [REVIEW]);

    const chip = document.querySelector(".skill-chip")!;
    expect(chip.textContent).toBe("gone");
    fireEvent.pointerEnter(chip);
    expect(queryCard()).toBeNull();
  });

  it("draws the chip, with no card, when the skills cannot be read", async () => {
    await renderThreadPart(
      () => (
        <UserMessage
          text="run $review"
          attachments={[]}
          at="2026-09-29T09:14:00.000Z"
          timezone="UTC"
          today={Date.UTC(2026, 8, 29)}
          skills={["review"]}
          sessionId={THREAD.session.id}
        />
      ),
      { thread: THREAD },
    );

    const chip = document.querySelector(".skill-chip")!;
    expect(chip.textContent).toBe("review");
    fireEvent.pointerEnter(chip);
    expect(queryCard()).toBeNull();
  });
});
