/**
 * Tests the "Sign in…" of a thread's line about MCP servers while the code of
 * the sign-in dialog is still loading: the test holds the import, so nothing
 * depends on how fast a chunk arrives. A server that another client moves onto
 * a Connection during the load must show as moved once the dialog arrives,
 * never as a token form that cannot write its sign-in.
 *
 * Holding the import needs a file of its own: the dialog's lazy component
 * keeps the module once it loaded, so only the first test of a file can hold it.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { queryKeys } from "@hercule/client-core";
import type { McpServer } from "@hercule/contract";
import { buildNextRows, THREAD_FIXTURES } from "../../app/testing";
import { NOTION, SENTRY_WORK } from "../settings/mcp-servers/mcp-servers.testing";
import { findCalls, openComposerApp } from "./thread-servers.testing";

// The dialog's module loads only after the test releases the gate.
const dialogImport = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
});
vi.mock("./sign-in-dialog", async (importOriginal) => {
  await dialogImport.gate;
  return importOriginal();
});

describe("the thread line's 'Sign in…' while the dialog's code is still loading", () => {
  it("shows the server as reached with a Connection, and offers no token field, when another client moved it during the load", async () => {
    const signedOut: McpServer = { ...NOTION, status: "needs-sign-in" };
    const { session, transcript } = THREAD_FIXTURES.finished;
    const thread = {
      ...THREAD_FIXTURES.finished,
      transcript: [
        ...transcript,
        ...buildNextRows(session.id, transcript, {
          _tag: "runtime.warning",
          message: "The servers were not reached.",
          mcpServers: [{ mcpServerId: NOTION.id, reason: "needs-sign-in" }],
        }),
      ],
    };
    const app = await openComposerApp(`/threads/${session.id}`, { thread, servers: [signedOut] });
    const button = await screen.findByRole("button", { name: "Sign in…" });
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Another client moves the server onto a Connection, and the list shows it, while the dialog's code is held.
    const moved: McpServer = { ...NOTION, source: SENTRY_WORK.source, status: "ready" };
    app.world.servers = [moved];
    act(() => {
      app.context.queryClient.setQueryData(queryKeys.mcpServers(), [moved]);
    });
    dialogImport.release();

    const dialog = await screen.findByRole("dialog", { name: /notion/ });
    await within(dialog).findByText(/notion is reached with a Connection now/);
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
    await waitFor(() => {
      expect(findCalls(app.calls, "POST", `/api/v1/mcp-servers/${NOTION.id}/token`)).toHaveLength(
        0,
      );
    });
  });
});
