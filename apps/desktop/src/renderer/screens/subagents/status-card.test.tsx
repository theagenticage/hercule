/**
 * Tests `StatusCard` against the stubbed controller: the words for each
 * state, where Open parent leads, and the Stop of a running subagent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Subagent } from "@hercule/contract";
import {
  buildErrorBody,
  FIXTURE_SUBAGENT,
  FIXTURE_THREAD_IDS,
  THREAD_FIXTURES,
  type ThreadRecords,
} from "../../app/testing";
import { renderThreadPart } from "../thread/testing";
import { StatusCard } from "./status-card";

afterEach(() => {
  vi.useRealTimers();
});

/** The operation that interrupts the delegating thread. */
const INTERRUPT = `POST /api/v1/sessions/${FIXTURE_THREAD_IDS.flaky}/interrupt`;

/** A subagent that `FIXTURE_SUBAGENT` started. */
const CHILD: Subagent = {
  id: "agent-2",
  sessionId: FIXTURE_THREAD_IDS.flaky,
  parentSubagentId: FIXTURE_SUBAGENT.id,
  description: "Read the retry test",
  status: "running",
  toolCalls: 0,
  startedAt: "2026-09-10T09:04:00.000Z",
};

/**
 * Renders the status card of the subagent `subagentId` of `thread`, whose
 * subagents are `subagents`. The controller answers every interrupt unless
 * `failInterrupt` is set.
 */
const renderStatusCard = (
  subagentId: string,
  subagents: readonly Subagent[],
  options: { readonly thread?: ThreadRecords; readonly failInterrupt?: boolean } = {},
) => {
  const { thread = THREAD_FIXTURES.delegating, failInterrupt = false } = options;
  return renderThreadPart(
    () => (
      <StatusCard
        subagent={subagents.find((each) => each.id === subagentId)!}
        subagents={subagents}
        openRequests={thread.session.openRequests}
      />
    ),
    {
      thread: { ...thread, subagents },
      handlers: {
        [INTERRUPT]: failInterrupt
          ? { status: 409, body: buildErrorBody("invalid_state", "The session has ended.") }
          : { body: thread.session },
      },
    },
  );
};

/** Returns the card's two lines of words. */
const readWords = (): readonly (string | null)[] =>
  [...document.querySelector(".status-card-text")!.children].map((line) => line.textContent);

describe("StatusCard", () => {
  it("draws a running subagent of the main agent with its time, Open parent to the thread, and Stop", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T09:05:00.000Z"), toFake: ["Date"] });
    await renderStatusCard(FIXTURE_SUBAGENT.id, [FIXTURE_SUBAGENT]);

    expect(readWords()).toEqual([
      "Working for 1m 20s",
      "Subagent of the main agent · takes no messages",
    ]);
    expect(screen.getByRole("link", { name: "Open parent" }).getAttribute("href")).toBe(
      `/threads/${FIXTURE_THREAD_IDS.flaky}`,
    );
    expect(screen.getByRole("button", { name: "Stop" }).getAttribute("title")).toBeNull();
  });

  it("leads Open parent to the parent subagent's page, and counts the subagents below in Stop", async () => {
    await renderStatusCard(CHILD.id, [FIXTURE_SUBAGENT, CHILD]);
    expect(screen.getByRole("link", { name: "Open parent" }).getAttribute("href")).toBe(
      `/threads/${FIXTURE_THREAD_IDS.flaky}/subagents/${FIXTURE_SUBAGENT.id}`,
    );
    expect(readWords()[1]).toBe("Subagent of Find the flaky webhook test · takes no messages");
  });

  it("says Stop also stops the subagents below", async () => {
    await renderStatusCard(FIXTURE_SUBAGENT.id, [FIXTURE_SUBAGENT, CHILD]);
    const stop = screen.getByRole("button", { name: "Stop with 1 below" });
    expect(stop.getAttribute("title")).toBe("Also stops the subagent below it");
  });

  it("draws a subagent that has ended with no Stop", async () => {
    const done: Subagent = {
      ...FIXTURE_SUBAGENT,
      status: "completed",
      endedAt: "2026-09-10T09:06:00.000Z",
    };
    await renderStatusCard(done.id, [done]);
    expect(readWords()[0]).toBe("Done in 2m 20s");
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  it("colours the headline of a subagent that waits on the user", async () => {
    const { delegating } = THREAD_FIXTURES;
    const thread: ThreadRecords = {
      ...delegating,
      session: {
        ...delegating.session,
        openRequests: [
          {
            requestId: "req-9",
            itemId: "tool-9",
            subagentId: FIXTURE_SUBAGENT.id,
            kind: "command_approval",
            decisions: ["allow", "deny"],
            detail: { command: "pnpm test" },
          },
        ],
      },
    };
    await renderStatusCard(FIXTURE_SUBAGENT.id, [FIXTURE_SUBAGENT], { thread });
    const headline = document.querySelector(".status-card-text b")!;
    expect(headline.textContent).toBe("Waiting on you");
    expect(headline.getAttribute("data-hue")).toBe("attn");
  });

  it("says why a Stop failed", async () => {
    const user = userEvent.setup();
    await renderStatusCard(FIXTURE_SUBAGENT.id, [FIXTURE_SUBAGENT], { failInterrupt: true });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("The session has ended.");
    });
  });
});
