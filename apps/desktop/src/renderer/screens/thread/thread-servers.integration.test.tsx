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
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { queryKeys } from "@hercule/client-core";
import { describeThreadStartFoot } from "@hercule/client-core/mcp-servers";
import { describeThreadServers } from "@hercule/client-core/mcp-servers/first-screen";
import { buildErrorBody } from "@hercule/client-core/testing";
import { buildDraftKey } from "../../app/pending-submissions";
import type { McpServer } from "@hercule/contract";
import { buildNextRows, THREAD_FIXTURES, type ThreadRecords } from "../../app/testing";
import {
  buildServer,
  LINEAR,
  LINEAR_CONNECTION,
  LINEAR_ID,
  OFFERING_CONNECTIONS,
  SENTRY_WORK,
  SENTRY_WORK_ID,
} from "../settings/mcp-servers/mcp-servers.testing";
import {
  findCalls,
  findPlusPopover,
  findSwitch,
  openComposerApp,
  openServersSubmenu,
  OPS,
  readListWrites,
  readSubmenuRows,
  toggleMenu,
  waitForTopicReads,
  WEBSHOP,
  withServers,
} from "./thread-servers.testing";

// Counts the thread's descriptions without changing what they say: the provider describes the
// thread each time its inputs change, so the count shows how often it redraws what it shares.
vi.mock("@hercule/client-core/mcp-servers/first-screen", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@hercule/client-core/mcp-servers/first-screen")>();
  return { ...original, describeThreadServers: vi.fn(original.describeThreadServers) };
});

// Lets a test record each description of the foot the editor draws, to look at every render and
// not only the one that settles. It describes the foot as the real function does.
const foot = vi.hoisted(() => ({
  describe: undefined as unknown as typeof describeThreadStartFoot,
}));
vi.mock("@hercule/client-core/mcp-servers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@hercule/client-core/mcp-servers")>();
  foot.describe = original.describeThreadStartFoot;
  return { ...original, describeThreadStartFoot: vi.fn(original.describeThreadStartFoot) };
});

const SERVER_LIST = "/api/v1/mcp-servers";

/**
 * Returns the click handler a button has now. Called later, it stands for a click that began on the
 * render this button came from, before the cache changed.
 */
const readClickHandler = (button: HTMLElement): (() => void) => {
  const key = Object.keys(button).find((each) => each.startsWith("__reactProps$"))!;
  return (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
};

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

  it("keeps the subscription, and reads nothing more, from the submenu to the picker of an empty thread", async () => {
    // The list is empty, so only the open menu or picker holds the topic: a flag that dropped
    // during the handoff would drop the subscription and make it again.
    const app = await openComposerApp(`/threads/${THREAD_FIXTURES.finished.session.id}`, {
      servers: [LINEAR, ...buildManyServers(9)],
    });
    const popover = await openServersSubmenu();
    await waitForTopicReads(app);
    const reads = findCalls(app.calls, "GET", SERVER_LIST).length;
    const subscriptions = app.live.countSubscriptions("mcpServer");
    expect(subscriptions).toBe(1);

    fireEvent.click(
      within(popover).getByRole("menuitem", { name: /more servers?…$/, hidden: true }),
    );
    const picker = await screen.findByRole("dialog", { name: "MCP servers of this thread" });
    // The browser reports the closed menu, which jsdom does not.
    toggleMenu(popover, "closed");
    await waitForTopicReads(app);

    expect(app.live.readTopics()).toContain("mcpServer");
    expect(app.live.countSubscriptions("mcpServer")).toBe(subscriptions);
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

describe("an open thread's start list", () => {
  /** The idle fixture thread, in no project, holding `servers`. */
  const threadInNoProject = (servers: readonly McpServer[]): ThreadRecords => {
    const thread = withServers(THREAD_FIXTURES.finished, servers);
    return { ...thread, session: { ...thread.session, projectId: null } };
  };
  const READ_FAILURE = "The controller fell over.";

  it("offers no way back to the default list once a refresh of the settings failed, though an earlier read succeeded", async () => {
    const thread = threadInNoProject([LINEAR]);
    let failing = false;
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR, SENTRY_WORK],
      handlers: {
        "GET /api/v1/settings": () =>
          failing
            ? { status: 500, body: buildErrorBody("internal", READ_FAILURE) }
            : { body: { controller: {}, user: { "thread.mcpServerIds": [SENTRY_WORK_ID] } } },
      },
    });
    const popover = await openServersSubmenu();
    const readFoot = (): string =>
      popover.querySelector(".plus-foot .menu-note")?.textContent ?? "";
    await waitFor(() => {
      expect(readFoot()).toContain("Back to the default list");
    });

    failing = true;
    await act(() => app.context.queryClient.invalidateQueries({ queryKey: queryKeys.settings() }));

    await waitFor(() => {
      expect(readFoot()).toContain(`could not be read (${READ_FAILURE})`);
    });
    expect(readFoot()).not.toContain("Back to the default list");
    // The thread's own switches keep working.
    expect(findSwitch("linear").getAttribute("aria-disabled")).toBe("false");
  });

  it("offers no way back to the project's list once a refresh of the projects failed, though an earlier read listed it", async () => {
    const thread = withServers(THREAD_FIXTURES.finished, [LINEAR]);
    let failing = false;
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR, SENTRY_WORK],
      projects: [{ ...WEBSHOP, mcpServerIds: [SENTRY_WORK_ID] }, OPS],
      handlers: {
        "GET /api/v1/projects": () =>
          failing
            ? { status: 500, body: buildErrorBody("internal", READ_FAILURE) }
            : { body: { items: [{ ...WEBSHOP, mcpServerIds: [SENTRY_WORK_ID] }, OPS] } },
      },
    });
    const popover = await openServersSubmenu();
    const readFoot = (): string =>
      popover.querySelector(".plus-foot .menu-note")?.textContent ?? "";
    await waitFor(() => {
      expect(readFoot()).toContain("Back to webshop's list");
    });

    failing = true;
    await act(() => app.context.queryClient.invalidateQueries({ queryKey: queryKeys.projects() }));

    await waitFor(() => {
      expect(readFoot()).toContain(`could not be read (${READ_FAILURE})`);
    });
    expect(readFoot()).not.toContain("Back to webshop's list");
    // The thread's own switches keep working.
    expect(findSwitch("linear").getAttribute("aria-disabled")).toBe("false");
  });

  it("never draws the reset of an earlier start in a render that already knows the refresh of the projects failed", async () => {
    const thread = withServers(THREAD_FIXTURES.finished, [LINEAR]);
    let failing = false;
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR, SENTRY_WORK],
      projects: [{ ...WEBSHOP, mcpServerIds: [SENTRY_WORK_ID] }, OPS],
      handlers: {
        "GET /api/v1/projects": () =>
          failing
            ? { status: 500, body: buildErrorBody("internal", READ_FAILURE) }
            : { body: { items: [{ ...WEBSHOP, mcpServerIds: [SENTRY_WORK_ID] }, OPS] } },
      },
    });
    const popover = await openServersSubmenu();
    await waitFor(() => {
      expect(popover.querySelector(".plus-foot")?.textContent).toContain("Back to webshop's list");
    });
    // Every render of the foot, with what the projects' read was at that moment.
    const seen: { kind: string; reads: string | undefined }[] = [];
    vi.mocked(describeThreadStartFoot).mockImplementation((decision, ids) => {
      seen.push({
        kind: decision.kind,
        reads: app.context.queryClient.getQueryState(queryKeys.projects())?.status,
      });
      return foot.describe(decision, ids);
    });
    failing = true;
    await act(() => app.context.queryClient.invalidateQueries({ queryKey: queryKeys.projects() }));
    await waitFor(() => {
      expect(popover.querySelector(".plus-foot")?.textContent).toContain(
        `could not be read (${READ_FAILURE})`,
      );
    });

    expect(seen.filter(({ reads }) => reads === "error").map(({ kind }) => kind)).not.toContain(
      "start",
    );
  });

  it("writes nothing when a reset pressed on an earlier render arrives after the refresh of the projects failed", async () => {
    const thread = withServers(THREAD_FIXTURES.finished, [LINEAR]);
    let failing = false;
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR, SENTRY_WORK],
      projects: [{ ...WEBSHOP, mcpServerIds: [SENTRY_WORK_ID] }, OPS],
      handlers: {
        "GET /api/v1/projects": () =>
          failing
            ? { status: 500, body: buildErrorBody("internal", READ_FAILURE) }
            : { body: { items: [{ ...WEBSHOP, mcpServerIds: [SENTRY_WORK_ID] }, OPS] } },
      },
    });
    const popover = await openServersSubmenu();
    const earlierReset = readClickHandler(
      await within(popover).findByRole("button", { name: "Back to webshop's list", hidden: true }),
    );

    failing = true;
    await act(() => app.context.queryClient.invalidateQueries({ queryKey: queryKeys.projects() }));
    await waitFor(() => {
      expect(popover.querySelector(".plus-foot .menu-note")?.textContent).toContain(
        `could not be read (${READ_FAILURE})`,
      );
    });
    await act(async () => {
      earlierReset();
      await Promise.resolve();
    });

    expect(readListWrites(app.calls, thread.session.id)).toEqual([]);
  });

  it("says why the servers could not be read when a record they are joined with fails, with nothing cached", async () => {
    const thread = withServers(THREAD_FIXTURES.finished, [LINEAR]);
    let failing = false;
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR],
      handlers: {
        "GET /api/v1/connections": () =>
          failing
            ? { status: 500, body: buildErrorBody("internal", READ_FAILURE) }
            : { body: { items: OFFERING_CONNECTIONS } },
      },
    });
    // The shell holds the Connections, so the cache is emptied to leave the read nothing to fall back on.
    failing = true;
    app.context.queryClient.removeQueries({ queryKey: queryKeys.connections() });
    const popover = await findPlusPopover();
    toggleMenu(popover, "open");

    fireEvent.click(within(popover).getByRole("menuitem", { name: /^MCP servers/, hidden: true }));

    const note = await within(popover).findByRole("alert", { hidden: true });
    expect(note.textContent).toBe(`Could not read the servers: ${READ_FAILURE}`);
  });
});

describe("what an open thread shares while its transcript grows", () => {
  it("describes the thread once, not again for each row the transcript gets", async () => {
    const thread = withServers(THREAD_FIXTURES.finished, [LINEAR]);
    const { session } = thread;
    const app = await openComposerApp(`/threads/${session.id}`, { thread, servers: [LINEAR] });
    await waitForTopicReads(app);
    const described = vi.mocked(describeThreadServers).mock.calls.length;

    let transcript = thread.transcript;
    for (const message of ["First.", "Second."]) {
      const rows = buildNextRows(session.id, transcript, { _tag: "runtime.warning", message });
      transcript = [...transcript, ...rows];
      act(() => {
        app.live.pushStreamRows(session.id, rows);
      });
      await screen.findByText(message);
    }

    expect(vi.mocked(describeThreadServers).mock.calls).toHaveLength(described);
  });
});
