/** Tests how a section of the pane folds, what its head says, and what its body shows while the read is on its way. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxAskSection, InboxMoreAsks, type AskSectionBody } from "./inbox-ask-section";

const READY: AskSectionBody = {
  state: "ready",
  timezone: "UTC",
  now: new Date("2026-11-12T12:00:00.000Z"),
  blocks: [{ type: "text", markdown: "Please look at the retry loop." }],
  answers: {
    answers: [
      {
        action: { id: "approve", label: "Approve", operation: null, primary: true },
        style: "plain",
        suggested: true,
        workflowId: null,
      },
    ],
    sourceName: "GitHub",
    chosen: undefined,
    reply: null,
    platform: "mac",
    onAnswer: vi.fn(),
    onDone: vi.fn(),
    onOpenReply: vi.fn(),
    onCloseReply: vi.fn(),
    onDraftChange: vi.fn(),
    onRetry: vi.fn(),
    onDiscard: vi.fn(),
  },
};

const renderSection = (props: {
  readonly isOpen: boolean;
  readonly isCurrent?: boolean;
  readonly body?: AskSectionBody;
  readonly onToggle?: () => void;
}) =>
  render(
    <InboxAskSection
      say="Mei asked for your review"
      asker="Mei"
      time="2h"
      isOpen={props.isOpen}
      isCurrent={props.isCurrent ?? false}
      body={props.body ?? READY}
      onToggle={props.onToggle ?? vi.fn()}
    />,
  );

describe("InboxAskSection", () => {
  it("says the ask with the asker in ink, and the time", () => {
    const { container } = renderSection({ isOpen: true });
    const head = screen.getByRole("button", { name: /Mei asked for your review/ });
    expect(head.querySelector("b")?.textContent).toBe("Mei");
    expect(head.textContent).toContain("2h");
    expect(container.querySelector(".sig-say")?.textContent).toBe("Mei asked for your review");
  });

  it("states whether it is unfolded, and folds a body that is shut so nothing in it takes focus", () => {
    const { container, rerender } = renderSection({ isOpen: false });
    const head = screen.getByRole("button", { name: /Mei asked/, expanded: false });
    expect(container.querySelector(".sig-body")?.hasAttribute("inert")).toBe(true);
    rerender(
      <InboxAskSection
        say="Mei asked for your review"
        asker="Mei"
        time="2h"
        isOpen
        isCurrent={false}
        body={READY}
        onToggle={vi.fn()}
      />,
    );
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".sig-body")?.hasAttribute("inert")).toBe(false);
    // Under Reduce motion the fold has finished at once and leaves no height behind.
    expect((container.querySelector(".sig-body") as HTMLElement).style.height).toBe("");
  });

  it("calls back when the head is pressed", async () => {
    const onToggle = vi.fn();
    renderSection({ isOpen: false, onToggle });
    await userEvent.setup().click(screen.getByRole("button", { name: /Mei asked/ }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("marks the current ask, and draws its blocks and answers", () => {
    const { container } = renderSection({ isOpen: true, isCurrent: true });
    expect(container.querySelector(".sig")?.classList.contains("is-current-ask")).toBe(true);
    expect(screen.getByText("Please look at the retry loop.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("draws quiet shapes while the read is on its way, and the reason when it failed", () => {
    const { container, rerender } = renderSection({ isOpen: true, body: { state: "reading" } });
    expect(container.querySelector(".sig-skel")?.getAttribute("aria-hidden")).toBe("true");
    rerender(
      <InboxAskSection
        say="Mei asked for your review"
        asker="Mei"
        time="2h"
        isOpen
        isCurrent
        body={{ state: "failed", message: "Could not read this ask." }}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("Could not read this ask.")).toBeTruthy();
  });
});

describe("InboxMoreAsks", () => {
  it("says how many asks are not shown, and nothing for none", () => {
    const { container, rerender } = render(<InboxMoreAsks count={3} />);
    expect(container.textContent).toBe("3 more asks");
    rerender(<InboxMoreAsks count={1} />);
    expect(container.textContent).toBe("1 more ask");
    rerender(<InboxMoreAsks count={0} />);
    expect(container.textContent).toBe("");
  });
});
