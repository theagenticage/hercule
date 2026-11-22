/**
 * Tests that one open thread owns the reads and the topic of its MCP servers
 * (see `ThreadServersProvider`), against the stubbed controller. Each test
 * counts the requests for the servers, and the topic held, after the first
 * pushes, so the reads a test counts are the thread's own: an empty thread
 * and a menu opened for Attach read nothing, a thread with a line about
 * servers and a thread with servers read once and hold the topic, the
 * handoff from the submenu to the picker keeps the topic and reads nothing
 * more, and a draft pick naming only servers deleted since keeps the topic.
 *
 * The words, the red dot and the rules behind them are tested in client-core
 * (`thread-servers.test.ts`). `plus-menu.integration.test.tsx` tests what the
 * menu writes.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { buildDraftKey } from "../../app/pending-submissions";
import { buildNextRows, THREAD_FIXTURES, type ThreadRecords } from "../../app/testing";
import {
  buildServer,
  LINEAR,
  LINEAR_CONNECTION,
  LINEAR_ID,
  SENTRY_WORK,
} from "../settings/mcp-servers/mcp-servers.testing";
import {
  findCalls,
  findPlusPopover,
  findSwitch,
  openComposerApp,
  openServersSubmenu,
  OPS,
  readSubmenuRows,
  toggleMenu,
  waitForTopicReads,
  WEBSHOP,
  withServers,
} from "./thread-servers.testing";

const SERVER_LIST = "/api/v1/mcp-servers";

/** An id that names no server, as a server deleted since a pick was made. */
const DELETED_ID = "01a06d02-8300-7000-8000-0000000000ff";

/** The idle fixture thread with `count` warning lines about the server `mcpServerId` after its transcript. */
const threadWithLines = (mcpServerId: string, count: number): ThreadRecords => {
  const { session } = THREAD_FIXTURES.finished;
  let transcript = THREAD_FIXTURES.finished.transcript;
  for (let line = 0; line < count; line += 1) {
    transcript = [
      ...transcript,
      ...buildNextRows(session.id, transcript, {
        _tag: "runtime.warning",
        message: `The servers were not reached (${String(line + 1)}).`,
        mcpServers: [{ mcpServerId, reason: "unreachable" }],
      }),
    ];
  }
  return { ...THREAD_FIXTURES.finished, transcript };
};

/** Returns `count` ready servers named `tool01`, `tool02`, ... all on the Linear Connection. */
const buildManyServers = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    buildServer(
      `01a06d02-8400-7000-8000-${String(index + 1).padStart(12, "0")}`,
      `tool${String(index + 1).padStart(2, "0")}`,
      LINEAR_CONNECTION,
    ),
  );

describe("an open thread's reads of MCP servers", () => {
  it("reads nothing for an empty thread, and nothing for a menu opened for Attach", async () => {
    const app = await openComposerApp(`/threads/${THREAD_FIXTURES.finished.session.id}`, {
      servers: [LINEAR],
    });
    const popover = await findPlusPopover();

    toggleMenu(popover, "open");

    expect(findCalls(app.calls, "GET", SERVER_LIST)).toHaveLength(0);
    expect(app.live.readTopics()).not.toContain("mcpServer");
  });

  it("reads the servers once and holds the topic for a thread whose only reason is a line about them, whatever the number of lines", async () => {
    const thread = threadWithLines(LINEAR_ID, 2);
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR],
    });

    await waitForTopicReads(app);

    expect(app.live.readTopics()).toContain("mcpServer");
    // The read when the thread opened, and the one on the topic's first push, not one per line.
    expect(findCalls(app.calls, "GET", SERVER_LIST)).toHaveLength(2);
  });

  it("keeps the topic, and reads nothing more, from the submenu to the picker", async () => {
    const thread = withServers(THREAD_FIXTURES.finished, [LINEAR]);
    const nine = buildManyServers(9);
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR, ...nine],
    });
    const popover = await openServersSubmenu();
    await waitForTopicReads(app);
    const reads = findCalls(app.calls, "GET", SERVER_LIST).length;

    fireEvent.click(
      within(popover).getByRole("menuitem", { name: /more servers?…$/, hidden: true }),
    );
    const picker = await screen.findByRole("dialog", { name: "MCP servers of this thread" });
    // The browser reports the closed menu, which jsdom does not.
    toggleMenu(popover, "closed");

    expect(app.live.readTopics()).toContain("mcpServer");
    expect(findCalls(app.calls, "GET", SERVER_LIST)).toHaveLength(reads);
    expect(within(picker).getAllByRole("checkbox").length).toBeGreaterThan(8);
  });

  it("drops the topic of an empty thread when the picker closes", async () => {
    const nine = buildManyServers(9);
    const app = await openComposerApp(`/threads/${THREAD_FIXTURES.finished.session.id}`, {
      servers: nine,
    });
    const popover = await openServersSubmenu();
    await waitForTopicReads(app);
    fireEvent.click(
      within(popover).getByRole("menuitem", { name: /more servers?…$/, hidden: true }),
    );
    const picker = await screen.findByRole("dialog", { name: "MCP servers of this thread" });
    // The browser reports the closed menu, which jsdom does not.
    toggleMenu(popover, "closed");
    expect(app.live.readTopics()).toContain("mcpServer");

    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(app.live.readTopics()).not.toContain("mcpServer");
    });
  });

  it("keeps the topic of a draft whose pick names only a server deleted since", async () => {
    const app = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [LINEAR, SENTRY_WORK],
      projects: [{ ...WEBSHOP, mcpServerIds: [] }, OPS],
    });
    const key = buildDraftKey(WEBSHOP.id, null);

    act(() => {
      app.context.controller!.pendingSubmissions.writePicks(key, {
        mcpServers: { projectId: WEBSHOP.id, mcpServerIds: [DELETED_ID] },
      });
    });
    await waitForTopicReads(app);

    expect(app.live.readTopics()).toContain("mcpServer");
    expect(findCalls(app.calls, "GET", SERVER_LIST)).toHaveLength(2);
  });

  it("leaves the switches usable when the project the thread started from is gone", async () => {
    const thread = withServers(THREAD_FIXTURES.finished, [LINEAR]);
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR, SENTRY_WORK],
      projects: [OPS],
    });

    const popover = await openServersSubmenu();

    expect(readSubmenuRows(popover)).toContain("sentry work");
    expect(findSwitch("sentry").getAttribute("aria-disabled")).toBe("false");
    expect(popover.querySelector(".plus-foot .menu-note")?.textContent).toBe(
      "This thread's project no longer exists. Changes are for this thread only.",
    );
    expect(app.live.readTopics()).toContain("mcpServer");
  });
});
