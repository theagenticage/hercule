/**
 * Tests that the composer's `+` works while the code of the servers' submenu
 * has not loaded: the import is held by the test, so nothing depends on how
 * fast a chunk arrives. The submenu is loaded when the "MCP servers" row opens
 * (see `lazy-thread-servers.ts`), so the `+`, Attach and the red dot must
 * never wait for it.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SENTRY_WORK } from "../settings/mcp-servers/mcp-servers.testing";
import {
  findPlusPopover,
  openComposerApp,
  readServersRowWords,
  toggleMenu,
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

const SIGNED_OUT = { ...SENTRY_WORK, status: "needs-sign-in" } as const;

describe("the + while the code of the servers' submenu is still loading", () => {
  it("attaches, shows the red dot and the MCP row's words, then draws the submenu once the code arrives", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    try {
      const thread = withServers(THREAD_FIXTURES.finished, [SENTRY_WORK]);
      await openComposerApp(`/threads/${thread.session.id}`, { thread, servers: [SIGNED_OUT] });
      const popover = await findPlusPopover();
      toggleMenu(popover, "open");

      fireEvent.click(
        within(popover).getByRole("menuitem", { name: /^MCP servers/, hidden: true }),
      );
      await waitFor(() => {
        expect(popover.querySelector(".plus-sub[aria-busy='true']")).not.toBeNull();
      });

      expect(screen.getByRole("button", { name: "Add (1 needs sign-in)" })).not.toBeNull();
      expect(readServersRowWords(popover)).toBe("1 needs sign-in");
      fireEvent.click(
        within(popover).getByRole("menuitem", { name: "Attach an image", hidden: true }),
      );
      expect(click).toHaveBeenCalledTimes(1);
      expect(popover.querySelector(".plus-row")).toBeNull();

      submenuImport.release();
      await waitFor(() => {
        expect(popover.querySelector(".plus-row")).not.toBeNull();
      });
    } finally {
      submenuImport.release();
      click.mockRestore();
    }
  });
});
