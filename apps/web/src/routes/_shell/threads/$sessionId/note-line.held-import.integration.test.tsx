/**
 * Tests the "Sign in…" button of a thread's warning line while the code of the
 * sign-in dialog is still loading: the test holds the import, so nothing
 * depends on how fast a chunk arrives. A server that another client deletes
 * during the load must show as removed once the dialog arrives, never as a
 * token form for a server that no longer exists.
 *
 * Holding the import needs a file of its own: the dialog's lazy component
 * keeps the module once it loaded, so only the first test of a file can hold it.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpServer, TranscriptRow } from "@hercule/contract";
import { renderApp, stubApi } from "../../../../app/testing";
import { S_DOCS_URL, buildMcpServerRoutes } from "../../../../app/testing-mcp-servers";
import { SESSION_ID, buildController, buildSession } from "./-fixtures";

// The dialog's module loads only after the test releases the gate.
const dialogImport = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
});
vi.mock("../../../../screens/mcp-url-server/token-dialog", async (importOriginal) => {
  await dialogImport.gate;
  return importOriginal();
});

const AT = "2026-09-08T10:00:01.000Z";

/** A turn that holds one warning saying the server `mcpServerId` needs sign-in. */
const buildWarningRows = (mcpServerId: string): TranscriptRow[] =>
  [
    { _tag: "turn.started", turnId: "t1", at: "2026-09-08T10:00:00.000Z" },
    {
      _tag: "runtime.warning",
      turnId: "t1",
      at: AT,
      message: "MCP servers were left out.",
      mcpServers: [{ mcpServerId, reason: "needs-sign-in" }],
    },
  ].map(
    (event, position) =>
      ({
        position,
        at: event.at,
        event: { ...event, eventId: `e${String(position)}`, sessionId: SESSION_ID },
      }) as TranscriptRow,
  );

describe("the warning line's 'Sign in…' while the dialog's code is still loading", () => {
  const openLine = async (read: () => readonly McpServer[]) => {
    const api = stubApi(
      buildController(
        { session: buildSession({ status: "idle" }), subagents: [] },
        {
          ...buildMcpServerRoutes(read),
          [`GET /api/v1/sessions/${SESSION_ID}/transcript`]: {
            body: { items: buildWarningRows(S_DOCS_URL.id) },
          },
          [`GET /api/v1/mcp-servers/${S_DOCS_URL.id}`]: () => ({ body: S_DOCS_URL }),
        },
      ),
    );
    const app = await renderApp({
      path: `/threads/${SESSION_ID}`,
      api: api.fetch,
      token: "held",
    });
    return { ...app, api };
  };

  const pushDocsChange = async (live: Awaited<ReturnType<typeof openLine>>["live"]) => {
    await waitFor(() => {
      expect(live.topics()).toContain("mcpServer");
    });
    act(() => {
      live.push("mcpServer", { _tag: "invalidate", ids: [S_DOCS_URL.id], kind: "updated" });
    });
  };

  it("shows the server as removed, and offers no token field, when another client deleted it during the load", async () => {
    const user = userEvent.setup();
    let servers: readonly McpServer[] = [S_DOCS_URL];
    const { live, api } = await openLine(() => servers);
    await user.click(await screen.findByRole("button", { name: "Sign in…: docs" }));
    expect(screen.queryByRole("dialog", { name: "Sign in to docs" })).toBeNull();

    // The delete reaches the app, and the list is read again, while the dialog's code is held.
    servers = [];
    await pushDocsChange(live);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Sign in…: docs" })).toBeNull();
    });
    dialogImport.release();

    const dialog = await screen.findByRole("dialog", { name: "Sign in to docs" });
    await within(dialog).findByText("docs was removed.");
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
    expect(api.calls.filter((call) => call.path.endsWith("/token"))).toHaveLength(0);
  });
});
