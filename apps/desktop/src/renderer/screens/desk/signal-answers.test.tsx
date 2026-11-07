/**
 * Tests how the pane draws a Hand to an agent answer, which binds
 * `signal.handOff` (or `run.start` on a signal written before it existed): its
 * label as the controller wrote it, and the face of the workflow it starts.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DONE_ACTION_ID, type Signal } from "@hercule/contract";
import { buildSignalAnswers } from "@hercule/client-core";
import { SignalAnswers } from "./signal-answers";

const WORKFLOW_ID = "01a0ec64-6e80-7000-8000-0000000000f8";

/** Builds a signal with one Hand to an agent answer that binds `operation`. */
const buildSignal = (operation: NonNullable<Signal["actions"][number]["operation"]>): Signal => ({
  id: "01a0ec64-6e80-7000-8000-000000000001",
  kind: "github/review-requested",
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
  title: "Retry failed webhooks",
  priority: "normal",
  blocks: [],
  actions: [
    {
      id: `hand-to-${WORKFLOW_ID}`,
      label: "Hand to Review PR",
      operation,
      describeLine: [{ kind: "text", text: "Starts Review PR" }],
    },
  ],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:18:00.000Z",
});

const nothing = (): void => undefined;

describe("SignalAnswers", () => {
  it.each([
    ["signal.handOff", { op: "signal.handOff", input: { signalId: "s", workflowId: WORKFLOW_ID } }],
    ["run.start", { op: "run.start", input: { workflowId: WORKFLOW_ID, inputs: { signal: "s" } } }],
  ] as const)(
    "draws a Hand to answer that binds %s with its label and the workflow's face",
    (_op, operation) => {
      const { container } = render(
        <SignalAnswers
          answers={buildSignalAnswers(buildSignal(operation))}
          openReplyId={null}
          drafts={{}}
          locked={false}
          failure={null}
          idPrefix="test"
          shortcutFor={() => null}
          onOpenReply={nothing}
          onDraftChange={nothing}
          onAct={nothing}
          platform="mac"
        />,
      );
      expect(screen.getByRole("button", { name: "Hand to Review PR" })).toBeTruthy();
      expect(container.querySelector(".ans .btn .cr")).not.toBeNull();
    },
  );

  it("shows the key the caller gives beside an answer, and none when the caller gives none", () => {
    const signal = buildSignal({
      op: "signal.handOff",
      input: { signalId: "s", workflowId: WORKFLOW_ID },
    });
    const withDone: Signal = {
      ...signal,
      actions: [...signal.actions, { id: DONE_ACTION_ID, label: "Mark done", operation: null }],
    };
    const { container } = render(
      <SignalAnswers
        answers={buildSignalAnswers(withDone)}
        openReplyId={null}
        drafts={{}}
        locked={false}
        failure={null}
        idPrefix="test"
        shortcutFor={(answer) => (answer.action.id === DONE_ACTION_ID ? "E" : null)}
        onOpenReply={nothing}
        onDraftChange={nothing}
        onAct={nothing}
        platform="mac"
      />,
    );

    expect(
      [...container.querySelectorAll(".ans")].map((row) => row.querySelector("kbd")?.textContent),
    ).toEqual([undefined, "E"]);
  });
});
