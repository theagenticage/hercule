/**
 * Tests the header of a subagent's page: the crumb from the thread down
 * through the subagent's ancestors, and the subagent's own crumb at its end.
 * The side pane's toggle is tested with the thread header.
 */
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import type { Subagent } from "@hercule/contract";
import { FIXTURE_SUBAGENT, FIXTURE_THREAD_IDS, THREAD_FIXTURES } from "../../app/testing";
import { renderThreadPart } from "../thread/testing";
import { SubagentHeader } from "./subagent-header";

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

/** Renders the header of `subagent`'s page on the delegating thread, whose subagents are `FIXTURE_SUBAGENT` and `CHILD`. */
const renderSubagentHeader = (subagent: Subagent) => {
  const subagents = [FIXTURE_SUBAGENT, CHILD];
  const { session } = THREAD_FIXTURES.delegating;
  return renderThreadPart(
    () => <SubagentHeader session={session} subagent={subagent} subagents={subagents} />,
    { thread: { ...THREAD_FIXTURES.delegating, subagents } },
  );
};

/** Returns the crumb from the thread down to the subagent. */
const readCrumbs = (): HTMLElement =>
  screen.getByRole("navigation", { name: "Subagent's place in the thread" });

describe("the header of a subagent's page", () => {
  it("draws the crumb from the thread down through the ancestors, each linking to its page", async () => {
    await renderSubagentHeader(CHILD);

    const links = within(readCrumbs()).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Fix flaky webhook tests", `/threads/${FIXTURE_THREAD_IDS.flaky}`],
      [
        "Find the flaky webhook test",
        `/threads/${FIXTURE_THREAD_IDS.flaky}/subagents/${FIXTURE_SUBAGENT.id}`,
      ],
    ]);
    // The subagent itself comes last, not as a link, with its tag.
    const here = readCrumbs().querySelector(".subagent-crumb-here");
    expect(here?.textContent).toBe("Read the retry testsubagent");
    expect(here?.getAttribute("style")).toMatch(/--hue: var\(--hue-/);
    expect(here?.querySelector(".mark--working")).not.toBeNull();
    // The thread's tabs, Open in editor and More belong to the thread's own page.
    expect(screen.queryByRole("navigation", { name: "Threads in this workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("draws a subagent the thread started with the thread as its only earlier crumb", async () => {
    await renderSubagentHeader(FIXTURE_SUBAGENT);

    expect(
      within(readCrumbs())
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Fix flaky webhook tests"]);
  });

  it("marks a stopped subagent idle, because the marks have no stopped glyph", async () => {
    await renderSubagentHeader({ ...CHILD, status: "stopped" });

    expect(readCrumbs().querySelector(".subagent-crumb-here .mark--idle")).not.toBeNull();
  });
});
