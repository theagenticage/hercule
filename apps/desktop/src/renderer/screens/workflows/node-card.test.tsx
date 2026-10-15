/**
 * Tests the run part of a node's card: the status line with its mark and
 * question, the facts of the step's current visit, "Ran N times" with a row
 * per visit, and Open thread.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NodeCard, NodeRunPart, NodeVisit } from "@hercule/client-core/node-details";
import { NodeCardContent } from "./node-card";

const NOW = "2026-10-11T12:00:00Z";

/** The run part of a step that waits on the user on its second visit, each visit with its own session. */
const WAITING: NodeRunPart = {
  state: "waiting",
  statusText: "Waiting on you",
  question: "Which branch should I review?",
  visits: [
    {
      number: 1,
      state: "failed",
      text: "Failed",
      startedAt: "2026-10-11T09:00:00Z",
      finishedAt: "2026-10-11T09:05:00Z",
      sessionId: "s-first",
    },
    {
      number: 2,
      state: "waiting",
      text: "Waiting on you",
      startedAt: "2026-10-11T09:12:00Z",
      finishedAt: undefined,
      sessionId: "s-second",
    },
  ],
  sessionId: "s-second",
};

/** Returns the card of `review` on a run, with `run` as its run part. */
const buildCard = (run: NodeRunPart | null): NodeCard => ({
  id: "review",
  kind: "agent",
  kindText: "Agent step",
  firesOn: null,
  facts: [
    { kind: "startTime", label: "Started", at: "2026-10-11T09:12:00Z" },
    {
      kind: "elapsed",
      label: "Running for",
      startedAt: "2026-10-11T09:12:00Z",
      finishedAt: undefined,
    },
    {
      kind: "elapsed",
      label: "Took",
      startedAt: "2026-10-11T09:00:00Z",
      finishedAt: "2026-10-11T09:05:00Z",
    },
    { kind: "text", label: "Error", value: "The diff is empty.", isCode: false, isError: true },
  ],
  texts: [{ label: "Prompt", text: "Review the diff.", isCode: false }],
  run,
});

/** Renders the card of `run`, opening threads with `onOpenSession`. */
const renderCard = (run: NodeRunPart | null, onOpenSession?: (sessionId: string) => void) =>
  render(
    <NodeCardContent
      card={buildCard(run)}
      pluginId={null}
      plugins={[]}
      timezone="UTC"
      onOpenSession={onOpenSession}
    />,
  );

/** Returns the value of the fact labelled `label`. */
const readFact = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll(".node-facts > div")]
    .find((row) => row.querySelector("dt")?.textContent === label)!
    .querySelector("dd")!;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a node's card on a run", () => {
  it("leads with where the run is at the node, its mark, and what the step asks", () => {
    const { container } = renderCard(WAITING);
    const status = container.querySelector(".node-status")!;
    expect(status.classList.contains("is-you")).toBe(true);
    expect(status.querySelector(".mark")?.classList.contains("mark--waiting")).toBe(true);
    expect(status.querySelector("b")?.textContent).toBe("Waiting on you");
    expect(status.querySelector("small")?.textContent).toBe("Which branch should I review?");
  });

  it("keeps a mark's room on the status line of a state with no mark", () => {
    const { container } = renderCard({
      ...WAITING,
      state: "unreached",
      statusText: "Not reached in this run",
      question: undefined,
      visits: [],
    });
    const status = container.querySelector(".node-status")!;
    expect(status.classList.contains("is-you")).toBe(false);
    expect(status.classList.contains("is-fail")).toBe(false);
    expect(status.querySelector(".no-mark")).not.toBeNull();
    expect(status.querySelector("small")).toBeNull();
  });

  it.each([
    ["skipped", "Skipped: its condition was false"],
    ["cancelled", "Cancelled"],
    ["pending", "Waiting to start"],
  ] as const)("shows a %s step's words with no mark and in the plain ink", (state, statusText) => {
    const { container } = renderCard({
      ...WAITING,
      state,
      statusText,
      question: undefined,
      visits: [],
    });
    const status = container.querySelector(".node-status")!;
    expect(status.querySelector("b")?.textContent).toBe(statusText);
    expect(status.querySelector(".mark")).toBeNull();
    expect(status.querySelector(".no-mark")).not.toBeNull();
    expect(status.classList.contains("is-you")).toBe(false);
    expect(status.classList.contains("is-fail")).toBe(false);
  });

  it("shows when the visit started with its day, how long it ran, and its error in fail ink", () => {
    const { container } = renderCard(WAITING);
    expect(readFact(container, "Started").textContent).toBe("Today 09:12");
    expect(readFact(container, "Running for").textContent).toBe("2h 48m");
    expect(readFact(container, "Took").textContent).toBe("5m 0s");
    expect(readFact(container, "Error").classList.contains("is-fail")).toBe(true);
    expect(readFact(container, "Error").classList.contains("is-code")).toBe(false);
  });

  it("lists every visit, and each opens its own thread", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    const { container } = renderCard(WAITING, onOpenSession);
    expect(screen.getByText("Ran 2 times")).toBeTruthy();
    const visits = [...container.querySelectorAll("button.line")].filter((line) =>
      line.textContent?.startsWith("#"),
    );
    expect(visits.map((visit) => visit.textContent)).toEqual([
      "#1 Failed5m 0s",
      "#2 Waiting on you2h 48m",
    ]);

    await user.click(visits[0]!);
    expect(onOpenSession).toHaveBeenLastCalledWith("s-first");
  });

  it("draws a visit with no session yet as a plain row that opens nothing", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    const done = (number: number, sessionId: string): NodeVisit => ({
      number,
      state: "done",
      text: "Done",
      startedAt: "2026-10-11T09:00:00Z",
      finishedAt: "2026-10-11T09:05:00Z",
      sessionId,
    });
    renderCard(
      {
        ...WAITING,
        state: "pending",
        statusText: "Waiting to start",
        question: undefined,
        visits: [
          done(1, "s-first"),
          done(2, "s-second"),
          {
            number: 3,
            state: "pending",
            text: "Waiting to start",
            startedAt: undefined,
            finishedAt: undefined,
            sessionId: undefined,
          },
        ],
      },
      onOpenSession,
    );
    expect(screen.getByText("#1").closest("button")).not.toBeNull();
    expect(screen.getByText("#2").closest("button")).not.toBeNull();
    const third = screen.getByText("#3").closest(".line")!;
    expect(third.tagName).toBe("DIV");
    await user.click(third);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("ends with Open thread, which opens the step's newest session", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    renderCard(WAITING, onOpenSession);
    await user.click(screen.getByRole("button", { name: "Open thread" }));
    expect(onOpenSession).toHaveBeenCalledWith("s-second");
  });

  it("opens no thread without a way to open one, or a session to open", () => {
    const { container, unmount } = renderCard(WAITING);
    expect(container.querySelector("button")).toBeNull();
    expect(screen.queryByText("Open thread")).toBeNull();
    unmount();

    renderCard({ ...WAITING, visits: [], sessionId: undefined }, vi.fn());
    expect(screen.queryByText("Open thread")).toBeNull();
  });

  it("shows no run part on a card off a run", () => {
    const { container } = renderCard(null);
    expect(container.querySelector(".node-status")).toBeNull();
    expect(screen.queryByText(/^Ran /)).toBeNull();
  });
});
