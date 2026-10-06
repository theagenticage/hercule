/**
 * Tests the Request dock of an agent's page: when the pager line is drawn,
 * what it names, how its arrows page, and which Request the dock then shows.
 */
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionRequest } from "@hercule/contract";
import { FIXTURE_SUBAGENT, THREAD_FIXTURES, type ThreadRecords } from "../../app/testing";
import { AgentRequestDock } from "./agent-request-dock";
import { renderThreadPart } from "./testing";

/** The waiting fixture thread, whose session's own agent asks to run `git push`. */
const WAITING = THREAD_FIXTURES.waiting;

/** The waiting thread's subagent. */
const SUBAGENT = { ...FIXTURE_SUBAGENT, sessionId: WAITING.session.id };

/** A command approval the subagent asks. */
const SUBAGENT_REQUEST: SessionRequest = {
  requestId: "req-2",
  itemId: "tool-2",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "rm -rf tmp" },
  subagentId: SUBAGENT.id,
};

/** Returns the waiting thread with `openRequests` and its subagent. */
const withRequests = (openRequests: readonly SessionRequest[]): ThreadRecords => ({
  ...WAITING,
  session: { ...WAITING.session, openRequests },
  subagents: [SUBAGENT],
});

/** Renders the dock of the page of `pageSubagentId` on `thread`. */
const renderDock = (thread: ThreadRecords, pageSubagentId?: string) =>
  renderThreadPart(
    ({ sessionId }) => <AgentRequestDock sessionId={sessionId} pageSubagentId={pageSubagentId} />,
    { thread },
  );

/** Returns the pager line, or null when none is drawn. */
const findPager = (): HTMLElement | null => document.querySelector(".request-pager");

describe("the agent's Request dock", () => {
  it("draws no pager line for a lone Request of the main agent", async () => {
    await renderDock(WAITING);

    expect(screen.getByRole("group", { name: "Run this command?" })).toBeTruthy();
    expect(findPager()).toBeNull();
  });

  it("names a lone Request's subagent in its hue, with a link to its page, and shows its face", async () => {
    await renderDock(withRequests([SUBAGENT_REQUEST]));

    const pager = findPager()!;
    expect(pager.textContent).toBe(
      "Find the flaky webhook test asks · subagent of the main agentOpen subagent ›",
    );
    expect(pager.querySelector(".request-pager-nav")).toBeNull();
    const hue = /var\(--hue-[a-z]+\)/.exec(pager.getAttribute("style") ?? "")?.[0];
    expect(hue).toBeDefined();
    // The dock's face is the subagent's, in the same hue as its name.
    expect(document.querySelector(".dock-q .cr")!.getAttribute("style")).toContain(hue);
    const link = within(pager).getByRole("link", { name: "Open subagent" });
    expect(link.getAttribute("href")).toBe(
      `/threads/${WAITING.session.id}/subagents/${SUBAGENT.id}`,
    );
  });

  it("pages between the open Requests, and the dock shows the one paged to", async () => {
    const user = userEvent.setup();
    await renderDock(withRequests([...WAITING.session.openRequests, SUBAGENT_REQUEST]));
    const pager = findPager()!;
    const previous = within(pager).getByRole("button", { name: "Previous Request" });
    const next = within(pager).getByRole("button", { name: "Next Request" });
    expect(pager.textContent).toBe("1 of 2The main agent asks");
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(next.getAttribute("aria-disabled")).toBeNull();

    await user.click(next);

    expect(pager.textContent).toBe(
      "2 of 2Find the flaky webhook test asks · subagent of the main agentOpen subagent ›",
    );
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("group", { name: "Run this command?" }).textContent).toContain(
      "rm -rf tmp",
    );
    // At the end, the arrow does nothing and keeps the focus.
    await user.click(next);
    expect(pager.textContent).toMatch(/^2 of 2/);
    expect(document.activeElement).toBe(next);

    await user.click(previous);
    expect(pager.textContent).toBe("1 of 2The main agent asks");
    expect(screen.getByRole("group", { name: "Run this command?" }).textContent).toContain(
      "git push",
    );
  });

  it("pages only the subagent's own Requests on its page, without naming it again", async () => {
    const user = userEvent.setup();
    const another: SessionRequest = { ...SUBAGENT_REQUEST, requestId: "req-3", itemId: "tool-3" };
    await renderDock(
      withRequests([...WAITING.session.openRequests, SUBAGENT_REQUEST, another]),
      SUBAGENT.id,
    );

    const pager = findPager()!;
    expect(pager.textContent).toBe("1 of 2");
    await user.click(within(pager).getByRole("button", { name: "Next Request" }));
    expect(pager.textContent).toBe("2 of 2");
  });

  it("draws nothing while no Request is open", async () => {
    await renderDock(THREAD_FIXTURES.finished);

    expect(document.querySelector(".dock")).toBeNull();
    expect(findPager()).toBeNull();
  });
});
