/** Tests what the Inbox's answers draw for one ask, and what pressing them calls back with. */
import { useState, type JSX } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SignalAnswer } from "@hercule/client-core";
import { DONE_ACTION_ID } from "@hercule/contract";
import {
  InboxAnswers,
  InboxUnsentAnswers,
  type InboxAnswersProps,
  type OpenReply,
  type UnsentAnswer,
} from "./inbox-answers";

const ANSWERS: ReadonlyArray<SignalAnswer> = [
  {
    action: {
      id: "approve",
      label: "Approve",
      operation: null,
      primary: true,
      describeLine: [
        { kind: "text", text: "Approves " },
        { kind: "marked", text: "PR 41" },
        { kind: "text", text: " on GitHub" },
      ],
    },
    style: "plain",
    suggested: true,
    workflowId: null,
  },
  {
    action: {
      id: "reply",
      label: "Reply…",
      operation: null,
      field: { name: "body", placeholder: "Reply to Mei…" },
      describeLine: [{ kind: "text", text: "Posts your reply" }],
    },
    style: "reply",
    suggested: false,
    workflowId: null,
  },
  {
    action: { id: "hand-to-review", label: "Hand to Review PR", operation: null },
    style: "plain",
    suggested: false,
    workflowId: "01a0ec64-6e80-7000-8000-0000000000f8",
  },
  {
    action: { id: DONE_ACTION_ID, label: "Done", operation: null },
    style: "done",
    suggested: false,
    workflowId: null,
  },
];

/** Renders the answers with every callback a spy, and returns the spies. */
const renderAnswers = (overrides: Partial<InboxAnswersProps> = {}) => {
  const calls = {
    onAnswer: vi.fn(),
    onDone: vi.fn(),
    onOpenReply: vi.fn(),
    onCloseReply: vi.fn(),
    onDraftChange: vi.fn(),
  };
  render(
    <InboxAnswers
      answers={ANSWERS}
      isCurrent
      sourceName="GitHub"
      chosen={undefined}
      reply={null}
      platform="mac"
      {...calls}
      {...overrides}
    />,
  );
  return calls;
};

describe("InboxAnswers", () => {
  it("fills the suggested answer and puts ↩ on it only on the current ask", () => {
    const { unmount } = render(
      <InboxAnswers
        answers={ANSWERS}
        isCurrent
        sourceName="GitHub"
        chosen={undefined}
        reply={null}
        platform="mac"
        onAnswer={vi.fn()}
        onDone={vi.fn()}
        onOpenReply={vi.fn()}
        onCloseReply={vi.fn()}
        onDraftChange={vi.fn()}
      />,
    );
    const approve = screen.getByRole("button", { name: /Approve/ });
    expect(approve.getAttribute("aria-keyshortcuts")).toBe("Enter");
    expect(approve.textContent).toContain("↩");
    expect(screen.getAllByText("↩")).toHaveLength(1);
    unmount();

    renderAnswers({ isCurrent: false });
    expect(
      screen.getByRole("button", { name: "Approve" }).getAttribute("aria-keyshortcuts"),
    ).toBeNull();
    expect(screen.queryByText("↩")).toBeNull();
  });

  it("leaves out the hand-off to an agent and puts Done last", () => {
    renderAnswers();
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names).toEqual(["Approve↩", "Reply…", "Done"]);
  });

  it("calls back with the answer pressed, and Done and a reply opening apart", async () => {
    const user = userEvent.setup();
    const calls = renderAnswers();
    await user.click(screen.getByRole("button", { name: /Approve/ }));
    await user.click(screen.getByRole("button", { name: "Reply…" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(calls.onAnswer).toHaveBeenCalledWith("approve");
    expect(calls.onOpenReply).toHaveBeenCalledWith("reply");
    expect(calls.onDone).toHaveBeenCalledOnce();
  });

  it("shows the describe line of the answer under the focus, and the first answer's before that", async () => {
    const user = userEvent.setup();
    renderAnswers();
    const line = (): string => document.querySelector(".sig-desc")?.textContent ?? "";
    expect(line()).toBe("Approves PR 41 on GitHub");
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Reply…" })).toBe(document.activeElement);
    expect(line()).toBe("Posts your reply");
    await user.tab();
    expect(line()).toBe("Ends this ask here. GitHub is not told.");
  });

  it("draws the chosen answer as pressed and takes no other answer while it is on its way", async () => {
    const user = userEvent.setup();
    const calls = renderAnswers({ chosen: { actionId: "approve", state: "held" } });
    expect(screen.getByRole("button", { name: "Approve" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(calls.onDone).not.toHaveBeenCalled();
  });

  it("takes no other answer while the answer it chose is unsent", async () => {
    const user = userEvent.setup();
    const calls = renderAnswers({ chosen: { actionId: "approve", state: "unsent" } });
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(calls.onDone).not.toHaveBeenCalled();
  });

  describe("the reply box", () => {
    /** Holds the open box and its words the way the caller does, so closing and opening keep them. */
    function Harness({
      onAnswer,
    }: {
      readonly onAnswer: (id: string, text?: string) => void;
    }): JSX.Element {
      const [reply, setReply] = useState<OpenReply | null>(null);
      const [draft, setDraft] = useState("");
      return (
        <InboxAnswers
          answers={ANSWERS}
          isCurrent
          sourceName="GitHub"
          chosen={undefined}
          reply={reply === null ? null : { ...reply, draft }}
          platform="mac"
          onAnswer={onAnswer}
          onDone={vi.fn()}
          onOpenReply={(actionId) => {
            setReply({ actionId, draft });
          }}
          onCloseReply={() => {
            setReply(null);
          }}
          onDraftChange={setDraft}
        />
      );
    }

    it("opens with the cursor in it, keeps the words through Esc, and sends them", async () => {
      const user = userEvent.setup();
      const onAnswer = vi.fn();
      render(<Harness onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Reply…" }));
      const box = screen.getByRole("textbox", { name: "Reply" });
      expect(box).toBe(document.activeElement);
      expect(box.getAttribute("placeholder")).toBe("Reply to Mei…");
      expect(screen.getByText("as you on GitHub")).toBeTruthy();

      await user.type(box, "Looks good");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply…" }));

      await user.click(screen.getByRole("button", { name: "Reply…" }));
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Looks good");
      await user.keyboard("{Meta>}{Enter}{/Meta}");
      expect(onAnswer).toHaveBeenCalledWith("reply", "Looks good");
    });

    it("sends nothing for an empty draft", async () => {
      const user = userEvent.setup();
      const onAnswer = vi.fn();
      render(<Harness onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Reply…" }));
      await user.click(screen.getByRole("button", { name: "Reply" }));
      expect(onAnswer).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox")).toBe(document.activeElement);
    });
  });
});

describe("InboxUnsentAnswers", () => {
  const unsent = (overrides: Partial<UnsentAnswer> = {}): UnsentAnswer => ({
    id: "one",
    sentence: "GitHub did not answer.",
    isInterrupted: false,
    words: undefined,
    canSendAgain: true,
    onSendAgain: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  });

  it("says why an answer was not sent, and offers to send it again or discard it", async () => {
    const user = userEvent.setup();
    const answer = unsent();
    render(<InboxUnsentAnswers answers={[answer]} />);
    expect(screen.getByRole("alert").textContent).toContain("GitHub did not answer.");
    await user.click(screen.getByRole("button", { name: "Send again" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(answer.onSendAgain).toHaveBeenCalledOnce();
    expect(answer.onDiscard).toHaveBeenCalledOnce();
  });

  it("offers only Discard, with the words to copy, when the ask is no longer open", () => {
    render(
      <InboxUnsentAnswers answers={[unsent({ canSendAgain: false, words: "Looks good to me" })]} />,
    );
    expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(screen.getByText("Looks good to me")).toBeTruthy();
  });

  it("lists every unsent answer", () => {
    render(
      <InboxUnsentAnswers
        answers={[
          unsent({ id: "a", sentence: "First." }),
          unsent({ id: "b", sentence: "Second." }),
        ]}
      />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });
});
