/**
 * Tests that the composer's `+` works while the code of the servers' submenu
 * and the code that joins the servers have not loaded: the imports are held
 * by the test, so nothing depends on how fast a chunk arrives. Both load when
 * the "MCP servers" row opens (see `lazy-thread-servers.ts`), so the `+`,
 * Attach and the red dot must never wait for them, and the records that
 * change while the join is held show as they are once it arrives. The module
 * that builds a line's views (`app/build-mcp-server-views.ts`) is held for the
 * whole test: the editor must draw its rows from the join's own code, with no
 * second import behind the join.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { queryKeys } from "@hercule/client-core";
import type { McpServer, Project } from "@hercule/contract";
import { LINEAR, LINEAR_ID, SENTRY_WORK } from "../settings/mcp-servers/mcp-servers.testing";
import {
  findPlusPopover,
  openComposerApp,
  readServersRowWords,
  readSubmenuRows,
  toggleMenu,
  WEBSHOP,
  withServers,
} from "./thread-servers.testing";
import { THREAD_FIXTURES } from "../../app/testing";

// The submenu's module loads only after the test releases the gate. The module is not loaded
// before this file's one test, because nothing else here opens the submenu.
const submenuImport = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
});
vi.mock("./thread-servers-menu", async (importOriginal) => {
  await submenuImport.gate;
  return importOriginal();
});

// The join's module loads only after the test releases its gate, which comes after the submenu's.
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

// The module that builds the views for a line of the transcript is never released before the
// test's last step. The editor's rows must not wait for it.
const builderImport = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
});
vi.mock("../../app/build-mcp-server-views", async (importOriginal) => {
  await builderImport.gate;
  return importOriginal();
});

const SIGNED_OUT = { ...SENTRY_WORK, status: "needs-sign-in" } as const;

describe("the + while the code of the servers' submenu and join is still loading", () => {
  it("attaches, shows the red dot and the MCP row's words, then draws the submenu and the current records once the code arrives", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    try {
      const thread = withServers(THREAD_FIXTURES.finished, [SENTRY_WORK]);
      const projects: Project[] = [{ ...WEBSHOP, mcpServerIds: [SENTRY_WORK.id] }];
      const app = await openComposerApp(`/threads/${thread.session.id}`, {
        thread,
        servers: [SIGNED_OUT, LINEAR],
        projects,
      });
      const popover = await findPlusPopover();
      const composer = screen.getByRole("textbox", { name: "Message" });
      const trigger = screen.getByRole("button", { name: "Add (1 needs sign-in)" });
      toggleMenu(popover, "open");

      fireEvent.click(
        within(popover).getByRole("menuitem", { name: /^MCP servers/, hidden: true }),
      );
      await waitFor(() => {
        expect(popover.querySelector(".plus-sub[aria-busy='true']")).not.toBeNull();
      });

      expect(screen.getByRole("button", { name: "Add (1 needs sign-in)" })).toBe(trigger);
      expect(readServersRowWords(popover)).toBe("1 needs sign-in");
      fireEvent.click(
        within(popover).getByRole("menuitem", { name: "Attach an image", hidden: true }),
      );
      expect(click).toHaveBeenCalledTimes(1);
      expect(popover.querySelector(".plus-row")).toBeNull();

      // The submenu's code arrives while the join's does not: the editor loads, and the badge and
      // the row still come from the records the first screen holds.
      submenuImport.release();
      expect(
        await within(popover).findByText("Reading the servers…", { exact: true }),
      ).not.toBeNull();
      expect(readServersRowWords(popover)).toBe("1 needs sign-in");
      expect(popover.querySelector(".plus-row")).toBeNull();

      // The records change while the join is held: the server is signed in again, another server
      // appears, and the project's list is now another one than the thread's.
      const signedIn: McpServer[] = [SENTRY_WORK, LINEAR];
      act(() => {
        app.context.queryClient.setQueryData(queryKeys.mcpServers(), signedIn);
        app.context.queryClient.setQueryData(queryKeys.projects(), [
          { ...WEBSHOP, mcpServerIds: [LINEAR_ID] },
        ]);
      });
      expect(popover.querySelector(".plus-row")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Message" })).toBe(composer);

      // Only the join is released: the views' builder stays held, and the rows still arrive.
      joinImport.release();
      await waitFor(() => {
        expect(popover.querySelector(".plus-row")).not.toBeNull();
      });

      // The editor shows the records as they are now, on the same composer and trigger.
      expect(readSubmenuRows(popover)).toEqual(["sentry work", "linear acme"]);
      for (const mark of popover.querySelectorAll(".plus-row-mark")) {
        expect(mark.firstElementChild).not.toBeNull();
      }
      expect(popover.querySelector(".plus-foot")?.textContent).toContain("Back to webshop's list");
      expect(popover.textContent).not.toContain("needs sign-in");
      expect(screen.getByRole("textbox", { name: "Message" })).toBe(composer);
      expect(screen.getByRole("button", { name: "Add" })).toBe(trigger);
    } finally {
      submenuImport.release();
      joinImport.release();
      builderImport.release();
      click.mockRestore();
    }
  });
});
