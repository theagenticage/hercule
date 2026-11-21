/**
 * Tests the thread's lines about MCP servers against the stubbed controller:
 * the button each server with a fix gets (Reconnect, Open server), no button
 * for a reason with no fix or a server deleted since, no dedup, the failure
 * colours of a line the user can act on and the quiet look of any other, and
 * that a thread with such a line reads the servers and holds their topic.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { McpServer } from "@hercule/contract";
import { buildNextRows, THREAD_FIXTURES, type ThreadRecords } from "../../app/testing";
import {
  LINEAR,
  LINEAR_ID,
  SENTRY_HOBBY,
  SENTRY_WORK,
  SENTRY_WORK_ID,
} from "../settings/mcp-servers/mcp-servers.testing";
import { findCalls, openComposerApp, waitForTopicReads } from "./thread-servers.testing";

type Reason = NonNullable<
  Extract<ThreadRecords["transcript"][number]["event"], { _tag: "runtime.warning" }>["mcpServers"]
>[number]["reason"];

/** An id that names no server, as a server deleted since the line was written. */
const DELETED_ID = "01a06d02-8300-7000-8000-0000000000ff";

/** The idle fixture thread with a warning line after its transcript, naming `entries`. */
const threadWithLine = (
  entries: ReadonlyArray<{ readonly mcpServerId: string; readonly reason: Reason }>,
): ThreadRecords => {
  const { session, transcript } = THREAD_FIXTURES.finished;
  return {
    ...THREAD_FIXTURES.finished,
    transcript: [
      ...transcript,
      ...buildNextRows(session.id, transcript, {
        _tag: "runtime.warning",
        message: "The servers were not reached.",
        mcpServers: entries.map((entry) => ({ ...entry })),
      }),
    ],
  };
};

/**
 * Opens the thread with a line naming `entries`, over `servers`, and returns
 * `readNote`, which finds the line. The line is drawn as a plain warning
 * until its code has loaded and then replaced, so a test reads it again
 * rather than keep the element.
 */
const openLine = async (
  entries: Parameters<typeof threadWithLine>[0],
  servers: readonly McpServer[],
) => {
  const thread = threadWithLine(entries);
  const app = await openComposerApp(`/threads/${thread.session.id}`, { thread, servers });
  const readNote = (): HTMLElement =>
    document.querySelector<HTMLElement>(".warning-note, .error-note")!;
  await waitFor(() => {
    expect(readNote()).not.toBeNull();
  });
  return { ...app, readNote };
};

const SIGNED_OUT: McpServer = { ...SENTRY_WORK, status: "needs-sign-in" };

describe("a thread's line about MCP servers", () => {
  it("has a Reconnect button for a server that needs sign-in, which opens the Connection's dialog, and is drawn as a failure", async () => {
    const { readNote } = await openLine(
      [{ mcpServerId: SENTRY_WORK_ID, reason: "needs-sign-in" }],
      [SIGNED_OUT],
    );

    // The plain warning stands in until the line's code has loaded, so the line is found again on each try.
    const button = await waitFor(() =>
      within(readNote()).getByRole("button", { name: "Reconnect Sentry · work" }),
    );
    expect(readNote().className).toBe("error-note");
    // The marker keeps the warning's name for a screen reader.
    expect(within(readNote()).getByRole("img", { name: "Warning" })).toBeTruthy();

    fireEvent.click(button);

    expect(await screen.findByRole("dialog", { name: "Reconnect Sentry · work" })).toBeTruthy();
  });

  it.each(["unreachable", "error", "switched-off"] as const)(
    "has an Open server button for a server that is %s, which goes to its page",
    async (reason) => {
      const { readNote, router } = await openLine([{ mcpServerId: LINEAR_ID, reason }], [LINEAR]);

      const button = await waitFor(() =>
        within(readNote()).getByRole("button", { name: "Open server" }),
      );
      expect(readNote().className).toBe("error-note");
      fireEvent.click(button);

      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`/settings/mcp-servers/${LINEAR_ID}`);
      });
    },
  );

  it.each([
    "runner-too-old",
    "harness-unsupported",
    "missing-grant",
    "timed-out",
    "not-in-list",
  ] as const)(
    "has no button and stays quiet for the reason %s, which has no fix",
    async (reason) => {
      const { readNote, calls } = await openLine([{ mcpServerId: LINEAR_ID, reason }], [LINEAR]);

      // Wait for the servers, so a button that should appear has had its chance.
      await waitFor(() => {
        expect(findCalls(calls, "GET", "/api/v1/mcp-servers").length).toBeGreaterThan(0);
      });
      expect(within(readNote()).queryByRole("button")).toBeNull();
      expect(readNote().className).toBe("warning-note");
    },
  );

  it("has no button for a server deleted since the line was written", async () => {
    const { readNote, calls } = await openLine(
      [{ mcpServerId: DELETED_ID, reason: "needs-sign-in" }],
      [LINEAR],
    );

    await waitFor(() => {
      expect(findCalls(calls, "GET", "/api/v1/mcp-servers").length).toBeGreaterThan(0);
    });
    expect(within(readNote()).queryByRole("button")).toBeNull();
    expect(readNote().className).toBe("warning-note");
  });

  it("has a button for each server that has a fix, with no dedup, and none for the one that has not", async () => {
    const { readNote } = await openLine(
      [
        { mcpServerId: SENTRY_WORK_ID, reason: "needs-sign-in" },
        { mcpServerId: LINEAR_ID, reason: "unreachable" },
        { mcpServerId: DELETED_ID, reason: "error" },
        { mcpServerId: SENTRY_HOBBY.id, reason: "runner-too-old" },
      ],
      [SIGNED_OUT, LINEAR, SENTRY_HOBBY],
    );

    await waitFor(() =>
      within(readNote()).getByRole("button", { name: "Reconnect Sentry · work" }),
    );

    expect(
      within(readNote())
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Reconnect Sentry · work", "Open server"]);
  });

  it("makes the thread read the servers once and hold their topic, though its own list is empty", async () => {
    const thread = threadWithLine([{ mcpServerId: LINEAR_ID, reason: "unreachable" }]);
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR],
    });

    await waitForTopicReads(app);

    expect(app.live.readTopics()).toContain("mcpServer");
    // The read when the thread opened, and the one on the topic's first push.
    expect(findCalls(app.calls, "GET", "/api/v1/mcp-servers")).toHaveLength(2);
  });
});
