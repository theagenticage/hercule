/**
 * Tests the "Sign in…" of the composer's `+` menu while the code of the
 * sign-in dialog is still loading: the test holds the import, so nothing
 * depends on how fast a chunk arrives. A server that another client moves onto
 * a Connection during the load must show as moved once the dialog arrives,
 * never as a token form that cannot write its sign-in.
 *
 * Holding the import needs a file of its own: the dialog's lazy component
 * keeps the module once it loaded, so only the first test of a file can hold it.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpServer } from "@hercule/contract";
import { renderApp, stubApi } from "../../../../app/testing";
import {
  S_DOCS_URL,
  S_SENTRY_WORK,
  buildMcpServerRoutes,
  findServerConnection,
  openServersSubmenu,
} from "../../../../app/testing-mcp-servers";
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

describe("the + menu's 'Sign in…' while the dialog's code is still loading", () => {
  it("shows the server as reached with a Connection, and offers no token field, when another client moved it during the load", async () => {
    const user = userEvent.setup();
    let servers: readonly McpServer[] = [S_DOCS_URL];
    const api = stubApi(
      buildController(
        { session: buildSession({ status: "idle" }), subagents: [] },
        {
          ...buildMcpServerRoutes(() => servers),
          [`GET /api/v1/mcp-servers/${S_DOCS_URL.id}`]: () => ({ body: S_DOCS_URL }),
        },
      ),
    );
    const { live, queryClient } = await renderApp({
      path: `/threads/${SESSION_ID}`,
      api: api.fetch,
      token: "held",
    });
    const submenu = await openServersSubmenu(user);
    await user.click(within(submenu).getByRole("button", { name: "Sign in…" }));
    expect(screen.queryByRole("dialog", { name: "Sign in to docs" })).toBeNull();

    // Another client moves the server onto a Connection, and the list is read again, while the dialog's code is held.
    servers = [
      {
        ...S_DOCS_URL,
        source: {
          kind: "plugin",
          contributionId: "sentry/sentry",
          connectionId: findServerConnection(S_SENTRY_WORK).id,
        },
        status: "ready",
        statusDetail: null,
      },
    ];
    const reads = (): number =>
      api.calls.filter((call) => call.method === "GET" && call.path === "/api/v1/mcp-servers")
        .length;
    const before = reads();
    await waitFor(() => {
      expect(live.topics()).toContain("mcpServer");
    });
    act(() => {
      live.push("mcpServer", { _tag: "invalidate", ids: [S_DOCS_URL.id], kind: "updated" });
    });
    await waitFor(() => {
      expect(reads()).toBeGreaterThan(before);
      expect(queryClient.isFetching()).toBe(0);
    });
    dialogImport.release();

    // The dialog opens on the record as it is now, so its title is the one of a record that needs no sign-in.
    const dialog = await screen.findByRole("dialog", { name: "Replace the token of docs" });
    await within(dialog).findByText(/docs is reached with a Connection now/);
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
    expect(api.calls.filter((call) => call.path.endsWith("/token"))).toHaveLength(0);
  });
});
