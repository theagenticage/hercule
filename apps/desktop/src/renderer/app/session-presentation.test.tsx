/**
 * Tests `useRowMembers`: a component that reads the sidebar rows' members
 * draws again only when a row's key, title or lead, or a member's label,
 * changes, and not for a push that changes a session's last activity.
 */
import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import type { Session } from "@hercule/contract";
import { renderThreadPart } from "../screens/thread/testing";
import { threadAndAgentSessionsQuery } from "./queries";
import { FIXTURE_THREAD_IDS, THREAD_FIXTURES } from "./testing";
import { useRowMembers } from "./session-presentation";

/** Renders a part that counts how often it draws and shows the title of `FIXTURE_THREAD_IDS.bunPin`'s row. */
const renderMembers = async () => {
  const draws = { count: 0 };
  const rendered = await renderThreadPart(
    function RowTitle() {
      const members = useRowMembers();
      draws.count += 1;
      return <output>{members[FIXTURE_THREAD_IDS.bunPin]?.rowTitle}</output>;
    },
    { thread: THREAD_FIXTURES.running },
  );
  /** Replaces the cached thread list with `change` applied to the "Bump the Bun pin" session, as a push does. */
  const push = (change: Partial<Session>) =>
    act(async () => {
      rendered.queryClient.setQueryData(
        threadAndAgentSessionsQuery(rendered.client).queryKey,
        (sessions: readonly Session[] | undefined) =>
          sessions?.map((each) =>
            each.id === FIXTURE_THREAD_IDS.bunPin ? { ...each, ...change } : each,
          ),
      );
      // The cache tells its readers on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { draws, push };
};

describe("useRowMembers", () => {
  it("draws its reader again when a row's title changes, and not when only a last activity does", async () => {
    const { draws, push } = await renderMembers();
    expect(screen.getByRole("status").textContent).toBe("Bump the Bun pin");
    const before = draws.count;

    await push({ lastActivityAt: "2026-09-10T09:30:00.000Z" });
    expect(draws.count).toBe(before);

    await push({ title: "Bump the Bun pin to 1.3.2" });
    expect(screen.getByRole("status").textContent).toBe("Bump the Bun pin to 1.3.2");
    expect(draws.count).toBe(before + 1);
  });
});
