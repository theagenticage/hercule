import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnswerLedger, type AnswerLedgerRow } from "./answer-ledger";

const ROWS: ReadonlyArray<AnswerLedgerRow<"start" | "dismiss">> = [
  {
    id: "start",
    label: "Start",
    primary: true,
    describeLine: [
      { kind: "text", text: "Start a run of " },
      { kind: "name", text: "Bugfix" },
    ],
    description: "Opens a session on the task.",
  },
  {
    id: "dismiss",
    label: "Dismiss",
    primary: false,
    describeLine: [{ kind: "text", text: "Does nothing" }],
    runsNothing: true,
  },
];

describe("AnswerLedger", () => {
  it("makes each row one button holding its label, describe line and description, in order", () => {
    render(<AnswerLedger rows={ROWS} disabled={false} onSelect={() => {}} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "StartStart a run of BugfixOpens a session on the task.",
      "DismissDoes nothing",
    ]);
  });

  it("sets the primary label in ink and the others muted, and a row that runs nothing in italics", () => {
    render(<AnswerLedger rows={ROWS} disabled={false} onSelect={() => {}} />);

    const [start, dismiss] = screen.getAllByRole("button");
    expect(within(start!).getByText("Start").className).toContain("text-ink");
    expect(within(dismiss!).getByText("Dismiss").className).toContain("text-muted");
    expect(within(dismiss!).getByText("Does nothing").className).toContain("italic");
    expect(within(start!).getByText(/Start a run of/).className).not.toContain("italic");
  });

  it("isolates each name for bidirectional text and keeps its line breaks", () => {
    // A right-to-left override inside a name would otherwise reverse the
    // words that follow it.
    const name = "evil‮txt\nsecond line";
    render(
      <AnswerLedger
        rows={[
          {
            id: "send",
            label: "Send",
            primary: false,
            describeLine: [
              { kind: "text", text: "Send " },
              { kind: "name", text: name },
              { kind: "text", text: " to session " },
              { kind: "name", text: "Chat" },
            ],
          },
        ]}
        disabled={false}
        onSelect={() => {}}
      />,
    );

    const names = screen.getByRole("button").querySelectorAll("bdi");
    expect([...names].map((element) => element.textContent)).toEqual([name, "Chat"]);
    for (const element of names) {
      expect(element.className).toContain("text-ink");
      expect(element.className).toContain("whitespace-pre-wrap");
    }
  });

  it("calls onSelect with the clicked row's id", async () => {
    const onSelect = vi.fn();
    render(<AnswerLedger rows={ROWS} disabled={false} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: /Dismiss/ }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("dismiss");
  });

  it("refuses every click while disabled", async () => {
    const onSelect = vi.fn();
    render(<AnswerLedger rows={ROWS} disabled onSelect={onSelect} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
      await userEvent.click(button);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });
});
