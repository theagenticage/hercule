/**
 * Tests that a dialog opened from a thread's page stays open while the
 * thread's MCP servers arrive: the catalogue is read again and the code that
 * joins the servers loads and reports. The provider's children must neither
 * remount nor suspend then, or the dialog's state would be lost. The join's
 * import is held by the test, so nothing depends on how fast a chunk arrives.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "@hercule/client-core";
import { buildNextRows, THREAD_FIXTURES } from "../../app/testing";
import { LINEAR, LINEAR_ID } from "../settings/mcp-servers/mcp-servers.testing";
import { findCalls, openComposerApp, withServers } from "./thread-servers.testing";

// The join's module loads only after the test releases the gate.
const joinImport = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
});
vi.mock("./thread-servers-join", async (importOriginal) => {
  await joinImport.gate;
  return importOriginal();
});

/** The idle fixture thread with one warning line about the server `mcpServerId`. */
const threadWithLine = (mcpServerId: string) => {
  const { session, transcript } = THREAD_FIXTURES.finished;
  return {
    ...THREAD_FIXTURES.finished,
    transcript: [
      ...transcript,
      ...buildNextRows(session.id, transcript, {
        _tag: "runtime.warning",
        message: "The servers were not reached.",
        mcpServers: [{ mcpServerId, reason: "unreachable" }],
      }),
    ],
  };
};

describe("a dialog opened from the thread's page while its servers arrive", () => {
  it("stays open, on the same composer, while the catalogue is read again and the join loads and reports", async () => {
    // A line about servers and a stored list make the provider read the catalogue and mount the join.
    const thread = withServers(threadWithLine(LINEAR_ID), [LINEAR]);
    let holding = false;
    let releaseCatalogue: () => void = () => undefined;
    const catalogueHeld = new Promise<void>((resolve) => {
      releaseCatalogue = resolve;
    });
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR],
      handlers: {
        "GET /api/v1/mcp-servers": async () => {
          if (holding) await catalogueHeld;
          return { body: { items: [LINEAR] } };
        },
      },
    });
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.click(await screen.findByRole("button", { name: "Workspace details" }));
    const dialog = await screen.findByRole("dialog", { name: "Workspace details" });
    holding = true;
    const reads = findCalls(app.calls, "GET", "/api/v1/mcp-servers").length;
    act(() => {
      void app.context.queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() });
    });
    await waitFor(() => {
      expect(findCalls(app.calls, "GET", "/api/v1/mcp-servers")).toHaveLength(reads + 1);
    });
    expect(screen.getByRole("dialog", { name: "Workspace details" })).toBe(dialog);

    releaseCatalogue();
    joinImport.release();
    await waitFor(() => {
      expect(app.context.queryClient.isFetching()).toBe(0);
    });
    // The line about the servers is a plain warning until the join's code has loaded, then it is
    // drawn as a failure with its button: that is the join arriving.
    await waitFor(() => {
      expect(document.querySelector(".error-note")).not.toBeNull();
    });

    expect(screen.getByRole("dialog", { name: "Workspace details" })).toBe(dialog);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(composer);
  });
});
