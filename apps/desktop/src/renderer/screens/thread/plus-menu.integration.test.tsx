/**
 * Tests the composer's `+` menu with the thread's MCP servers, on a Draft
 * Thread and on a started thread, against the stubbed controller: its two
 * rows and the words on the second, the red dot, the submenu and the order of
 * its rows, the picker's rows, what a change writes (a draft's pick sent with
 * the first message, a started thread's `session.update`), the refusal under
 * the menu, answer mode, and what the thread reads.
 *
 * jsdom has no popover API, so a test sends the `toggle` event the browser
 * sends when the popover opens. The submenu loads the first time
 * it is needed, so the tests wait for it.
 */
import { describe, expect, it, vi } from "vitest";
import type { McpServer, Session } from "@hercule/contract";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { queryKeys } from "@hercule/client-core";
import { buildErrorBody } from "@hercule/client-core/testing";
import { buildDraftKey } from "../../app/pending-submissions";
import { holdAnswer, THREAD_FIXTURES, type ThreadRecords } from "../../app/testing";
import {
  buildServer,
  LINEAR,
  LINEAR_CONNECTION,
  LINEAR_ID,
  OFFERING_CONNECTIONS,
  SENTRY_HOBBY,
  SENTRY_HOBBY_ID,
  SENTRY_WORK,
  SENTRY_WORK_ID,
  NOTION,
} from "../settings/mcp-servers/mcp-servers.testing";
import {
  findCalls,
  findPlusPopover,
  findSwitch,
  openComposerApp,
  openServersSubmenu,
  OPS,
  readListWrites,
  readServersRowWords,
  readSpawns,
  readSubmenuRows,
  toggleMenu,
  waitForTopicReads,
  WEBSHOP,
  withServers,
} from "./thread-servers.testing";

const SERVER_LIST = "/api/v1/mcp-servers";

/** An id that names no server, as a server deleted since a pick was made. */
const DELETED_ID = "01a06d02-8300-7000-8000-0000000000ff";

/** The webshop project with `ids` as its list of servers. */
const webshopWith = (ids: readonly string[]) => ({ ...WEBSHOP, mcpServerIds: [...ids] });

/** The idle fixture thread, in webshop, with `servers` as its list. */
const threadWith = (servers: Parameters<typeof withServers>[1]): ThreadRecords =>
  withServers(THREAD_FIXTURES.finished, servers);

/** Returns `count` ready servers named `tool01`, `tool02`, ... with distinct ids, all on the Linear Connection. */
const buildManyServers = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    buildServer(
      `01a06d02-8400-7000-8000-${String(index + 1).padStart(12, "0")}`,
      `tool${String(index + 1).padStart(2, "0")}`,
      LINEAR_CONNECTION,
    ),
  );

/** Sentry's work server, which needs sign-in. */
const SENTRY_SIGNED_OUT = {
  ...SENTRY_WORK,
  status: "needs-sign-in",
  statusDetail: "The token was revoked.",
} as const;

describe("the + menu on a Draft Thread", () => {
  it("has two rows, and counts the servers the draft starts with, which are its project's", async () => {
    const app = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [SENTRY_WORK, LINEAR],
      projects: [webshopWith([SENTRY_WORK_ID, LINEAR_ID]), OPS],
    });
    const popover = await findPlusPopover();
    await waitForTopicReads(app);
    toggleMenu(popover, "open");

    expect(
      within(popover)
        .getAllByRole("menuitem", { hidden: true })
        .map((row) => row.textContent),
    ).toEqual(["Attach an image", "MCP servers2"]);
    expect(document.querySelector(".plus-dot")).toBeNull();
    // The draft read the servers when it opened, to know whether one of them needs sign-in,
    // and again on the topic's first push. Opening the menu read nothing more.
    expect(findCalls(app.calls, "GET", SERVER_LIST)).toHaveLength(2);
  });

  it("says none and reads nothing while the list is empty, and reads when the MCP row opens", async () => {
    const app = await openComposerApp(`/?project=${WEBSHOP.id}`, { servers: [SENTRY_WORK] });
    const { calls, live } = app;
    const popover = await findPlusPopover();

    toggleMenu(popover, "open");

    expect(readServersRowWords(popover)).toBe("none");
    expect(findCalls(calls, "GET", SERVER_LIST)).toHaveLength(0);
    expect(live.readTopics()).not.toContain("mcpServer");

    await openServersSubmenu();
    await waitForTopicReads(app);

    expect(readSubmenuRows(popover)).toEqual(["sentry work"]);
    // The read when the row opened, and the one on the topic's first push.
    expect(findCalls(calls, "GET", SERVER_LIST)).toHaveLength(2);
  });

  it("reads the servers when the draft has some, holds the topic while it is open, and drops it when the user leaves", async () => {
    const app = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
    });
    const { calls, live, router } = app;
    await waitForTopicReads(app);
    const reads = findCalls(calls, "GET", SERVER_LIST).length;

    await act(async () => {
      await router.navigate({ to: "/settings/providers" });
    });

    await waitFor(() => {
      expect(live.readTopics()).not.toContain("mcpServer");
    });
    // The read when the draft opened, and the one on the topic's first push; leaving reads nothing.
    expect(reads).toBe(2);
    expect(findCalls(calls, "GET", SERVER_LIST)).toHaveLength(reads);
  });

  it("puts a red dot on the + and reads '1 needs sign-in' while a server of the list needs it", async () => {
    await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [SENTRY_SIGNED_OUT, LINEAR],
      projects: [webshopWith([SENTRY_WORK_ID, LINEAR_ID]), OPS],
    });
    const popover = await findPlusPopover();

    await waitFor(() => {
      expect(document.querySelector(".plus-dot")).not.toBeNull();
    });
    toggleMenu(popover, "open");

    expect(readServersRowWords(popover)).toBe("1 needs sign-in");
    expect(popover.querySelector(".plus-fine.is-fail")).not.toBeNull();
  });

  it("keeps the rows in the order the submenu opened with while the user switches them", async () => {
    await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [SENTRY_WORK, SENTRY_HOBBY, LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
    });

    const popover = await openServersSubmenu();
    // The draft's own server first, then the others.
    expect(readSubmenuRows(popover)).toEqual(["linear acme", "sentry"]);

    fireEvent.click(findSwitch("linear"));
    await waitFor(() => {
      expect(findSwitch("linear").getAttribute("aria-checked")).toBe("false");
    });
    fireEvent.click(findSwitch("sentry"));
    await waitFor(() => {
      expect(findSwitch("sentry").getAttribute("aria-checked")).toBe("true");
    });

    expect(readSubmenuRows(popover)).toEqual(["linear acme", "sentry"]);
  });

  it("lists eight names and '1 more server…' for nine, which opens the picker, and lists nine of the draft's own", async () => {
    const nine = buildManyServers(9);
    await openComposerApp(`/?project=${WEBSHOP.id}`, { servers: nine });
    const popover = await openServersSubmenu();

    expect(readSubmenuRows(popover)).toHaveLength(8);
    fireEvent.click(
      within(popover).getByRole("menuitem", { name: "1 more server…", hidden: true }),
    );

    const picker = await screen.findByRole("dialog", { name: "MCP servers of this thread" });
    expect(within(picker).getAllByRole("checkbox")).toHaveLength(9);
  });

  it("shows every one of nine own servers, with no 'more' row", async () => {
    const nine = buildManyServers(9);
    await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: nine,
      projects: [webshopWith(nine.map((server) => server.id)), OPS],
    });

    const popover = await openServersSubmenu();

    expect(readSubmenuRows(popover)).toHaveLength(9);
    expect(
      within(popover).queryByRole("menuitem", { name: /more server/, hidden: true }),
    ).toBeNull();
  });

  it("sends no list for an untouched draft, so a default changed meanwhile still applies", async () => {
    const { calls } = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [SENTRY_WORK, LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
    });

    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "First{Enter}");

    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
    expect(readSpawns(calls)[0]!.body).not.toHaveProperty("mcpServerIds");
  });

  it("sends the list the user changed with the first message", async () => {
    const { calls } = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [SENTRY_WORK, LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
    });
    await openServersSubmenu();

    fireEvent.click(findSwitch("sentry"));
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "First{Enter}");

    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
    expect(readSpawns(calls)[0]!.body).toMatchObject({ mcpServerIds: [LINEAR_ID, SENTRY_WORK_ID] });
  });

  it("takes a choice from the servers the cache holds, with no Connection records to join them with", async () => {
    let connectionsFail = false;
    const { calls, context } = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [SENTRY_WORK, LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
      handlers: {
        "GET /api/v1/connections": () =>
          connectionsFail
            ? { status: 500, body: buildErrorBody("internal", "The controller fell over.") }
            : { body: { items: OFFERING_CONNECTIONS } },
      },
    });
    await openServersSubmenu();
    // The menu is drawn. Its display records leave the cache, and cannot be read again.
    connectionsFail = true;
    context.queryClient.removeQueries({ queryKey: queryKeys.connections() });

    fireEvent.click(findSwitch("sentry"));
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "First{Enter}");

    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
    expect(readSpawns(calls)[0]!.body).toMatchObject({ mcpServerIds: [LINEAR_ID, SENTRY_WORK_ID] });
  });

  it("sends an empty list when the user switched every server off", async () => {
    const { calls } = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
    });
    await openServersSubmenu();

    fireEvent.click(findSwitch("linear"));
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "First{Enter}");

    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
    expect(readSpawns(calls)[0]!.body).toMatchObject({ mcpServerIds: [] });
  });

  it("swaps the account of a name in one change, and the select is off while the name is off", async () => {
    const { calls } = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [SENTRY_WORK, SENTRY_HOBBY],
      projects: [webshopWith([SENTRY_WORK_ID]), OPS],
    });
    await openServersSubmenu();
    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Account of sentry",
      hidden: true,
    });
    expect(select.value).toBe(SENTRY_WORK_ID);

    fireEvent.change(select, { target: { value: SENTRY_HOBBY_ID } });
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "First{Enter}");

    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
    expect(readSpawns(calls)[0]!.body).toMatchObject({ mcpServerIds: [SENTRY_HOBBY_ID] });
  });

  it("disables the account select while the name is off", async () => {
    await openComposerApp(`/?project=${WEBSHOP.id}`, { servers: [SENTRY_WORK, SENTRY_HOBBY] });

    await openServersSubmenu();

    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Account of sentry",
      hidden: true,
    });
    expect(select.disabled).toBe(true);
  });

  it("does not carry a pick made in another project, and shows the list the project gives", async () => {
    const { calls, context } = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [SENTRY_WORK, LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
    });
    act(() => {
      context.controller!.pendingSubmissions.writePicks(buildDraftKey(WEBSHOP.id, null), {
        mcpServers: { projectId: OPS.id, mcpServerIds: [SENTRY_WORK_ID] },
      });
    });
    const popover = await openServersSubmenu();

    // The pick of the other project is ignored: the draft shows its own project's list.
    expect(readServersRowWords(popover)).toBe("1");
    expect(findSwitch("linear").getAttribute("aria-checked")).toBe("true");
    expect(findSwitch("sentry").getAttribute("aria-checked")).toBe("false");
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "First{Enter}");

    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
    expect(readSpawns(calls)[0]!.body).not.toHaveProperty("mcpServerIds");
  });

  it("drops a server deleted since the pick was made with the user's next change, and not before", async () => {
    const { context } = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [LINEAR, SENTRY_WORK],
      projects: [webshopWith([]), OPS],
    });
    const key = buildDraftKey(WEBSHOP.id, null);
    act(() => {
      context.controller!.pendingSubmissions.writePicks(key, {
        mcpServers: { projectId: WEBSHOP.id, mcpServerIds: [LINEAR_ID, DELETED_ID] },
      });
    });
    await openServersSubmenu();
    // Reading the servers changes nothing in the pick.
    expect(context.controller!.pendingSubmissions.read(key).picks.mcpServers?.mcpServerIds).toEqual(
      [LINEAR_ID, DELETED_ID],
    );

    fireEvent.click(findSwitch("sentry"));

    await waitFor(() => {
      expect(
        context.controller!.pendingSubmissions.read(key).picks.mcpServers?.mcpServerIds,
      ).toEqual([LINEAR_ID, SENTRY_WORK_ID]);
    });
  });

  it("sends a pick without the server deleted since, once the servers are read, though the user changed nothing", async () => {
    const { context, calls } = await openComposerApp(`/?project=${WEBSHOP.id}`, {
      servers: [LINEAR, SENTRY_WORK],
      projects: [webshopWith([]), OPS],
    });
    const key = buildDraftKey(WEBSHOP.id, null);
    act(() => {
      context.controller!.pendingSubmissions.writePicks(key, {
        mcpServers: { projectId: WEBSHOP.id, mcpServerIds: [LINEAR_ID, DELETED_ID] },
      });
    });
    await openServersSubmenu();

    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "First{Enter}");

    await waitFor(() => {
      expect(readSpawns(calls)).toHaveLength(1);
    });
    expect(readSpawns(calls)[0]!.body).toMatchObject({ mcpServerIds: [LINEAR_ID] });
  });
});

describe("the + menu on a started thread", () => {
  it("writes one session.update with the current list, and keeps the switches off while it runs", async () => {
    const thread = threadWith([LINEAR]);
    const held = holdAnswer();
    const { calls } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, LINEAR],
      holdWrite: held.handler,
    });
    await openServersSubmenu();

    fireEvent.click(findSwitch("sentry"));

    await waitFor(() => {
      expect(findSwitch("linear").getAttribute("aria-disabled")).toBe("true");
    });
    // A second press while the write runs starts no second write.
    fireEvent.click(findSwitch("linear"));
    expect(readListWrites(calls, thread.session.id)).toHaveLength(1);
    expect(readListWrites(calls, thread.session.id)[0]!.body).toEqual({
      mcpServerIds: [LINEAR_ID, SENTRY_WORK_ID],
    });

    held.answer({ body: {} });

    await waitFor(() => {
      expect(findSwitch("sentry").getAttribute("aria-checked")).toBe("true");
    });
    expect(findSwitch("linear").getAttribute("aria-disabled")).toBe("false");
    expect(readListWrites(calls, thread.session.id)).toHaveLength(1);
  });

  it("keeps the account choice, the switches and the way back off while a write runs, and ignores presses on them", async () => {
    const thread = threadWith([SENTRY_WORK]);
    const held = holdAnswer();
    const { calls } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, SENTRY_HOBBY, LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
      holdWrite: held.handler,
    });
    const popover = await openServersSubmenu();
    const account = () =>
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Account of sentry", hidden: true });
    const wayBack = () =>
      within(popover).getByRole("button", { name: "Back to webshop's list", hidden: true });

    fireEvent.change(account(), { target: { value: SENTRY_HOBBY_ID } });

    await waitFor(() => {
      expect(account().getAttribute("aria-disabled")).toBe("true");
    });
    expect(findSwitch("sentry").getAttribute("aria-disabled")).toBe("true");
    expect(findSwitch("linear").getAttribute("aria-disabled")).toBe("true");
    expect(wayBack().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(account(), { target: { value: SENTRY_WORK_ID } });
    fireEvent.click(wayBack());
    fireEvent.click(findSwitch("linear"));
    expect(readListWrites(calls, thread.session.id)).toHaveLength(1);

    held.answer({ body: {} });

    await waitFor(() => {
      expect(account().getAttribute("aria-disabled")).toBe("false");
    });
    expect(wayBack().getAttribute("aria-disabled")).toBe("false");
    expect(readListWrites(calls, thread.session.id)).toHaveLength(1);
  });

  it("swaps the account of a name in one write", async () => {
    const thread = threadWith([SENTRY_WORK]);
    const { calls } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, SENTRY_HOBBY],
    });
    await openServersSubmenu();

    fireEvent.change(screen.getByRole("combobox", { name: "Account of sentry", hidden: true }), {
      target: { value: SENTRY_HOBBY_ID },
    });

    await waitFor(() => {
      expect(readListWrites(calls, thread.session.id)).toHaveLength(1);
    });
    expect(readListWrites(calls, thread.session.id)[0]!.body).toEqual({
      mcpServerIds: [SENTRY_HOBBY_ID],
    });
  });

  it("shows the controller's refusal under the menu and leaves the list as the session holds it", async () => {
    const thread = threadWith([LINEAR]);
    await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, LINEAR],
      handlers: {
        [`PATCH /api/v1/sessions/${thread.session.id}`]: {
          status: 403,
          body: {
            error: {
              code: "forbidden",
              message: "This session needs the grant mcp.manage.",
              details: { grant: "mcp.manage" },
            },
          },
        },
      },
    });
    const popover = await openServersSubmenu();

    fireEvent.click(findSwitch("sentry"));

    const refusal = await within(popover).findByRole("alert", { hidden: true });
    expect(refusal.textContent).toBe("This session needs the grant mcp.manage.");
    expect(findSwitch("sentry").getAttribute("aria-checked")).toBe("false");
    expect(findSwitch("sentry").getAttribute("aria-disabled")).toBe("false");
  });

  it("says where the list started, and writes the project's list from the quiet button", async () => {
    const thread = threadWith([SENTRY_WORK]);
    const { calls } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, LINEAR],
      projects: [webshopWith([LINEAR_ID]), OPS],
    });
    const popover = await openServersSubmenu();
    expect(popover.querySelector(".plus-foot .menu-note")?.textContent).toBe(
      "Starts from webshop's list. Changes are for this thread only. Back to webshop's list",
    );

    fireEvent.click(
      within(popover).getByRole("button", { name: "Back to webshop's list", hidden: true }),
    );

    await waitFor(() => {
      expect(readListWrites(calls, thread.session.id)).toHaveLength(1);
    });
    expect(readListWrites(calls, thread.session.id)[0]!.body).toEqual({
      mcpServerIds: [LINEAR_ID],
    });
  });

  it("reads the servers once for a thread that has some, holds the topic, and drops it on leaving", async () => {
    const thread = threadWith([LINEAR]);
    const app = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [LINEAR],
    });
    const { calls, live, router } = app;
    await waitForTopicReads(app);
    // The read when the thread opened, and the one on the topic's first push.
    expect(findCalls(calls, "GET", SERVER_LIST)).toHaveLength(2);
    const reads = findCalls(calls, "GET", SERVER_LIST).length;

    await act(async () => {
      await router.navigate({ to: "/settings/providers" });
    });

    await waitFor(() => {
      expect(live.readTopics()).not.toContain("mcpServer");
    });
    expect(findCalls(calls, "GET", SERVER_LIST)).toHaveLength(reads);
  });

  it("puts a red dot on the + when a server of the thread needs sign-in", async () => {
    const thread = threadWith([SENTRY_WORK]);
    await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_SIGNED_OUT],
    });
    const popover = await findPlusPopover();

    await waitFor(() => {
      expect(document.querySelector(".plus-dot")).not.toBeNull();
    });
    toggleMenu(popover, "open");
    expect(readServersRowWords(popover)).toBe("1 needs sign-in");
  });

  it("says a server that needs sign-in stays on, and its button opens the Connection's Reconnect dialog", async () => {
    const thread = threadWith([SENTRY_WORK]);
    await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_SIGNED_OUT],
    });
    const popover = await openServersSubmenu();

    expect(popover.querySelector(".plus-row-name small")?.textContent).toBe(
      "on, joins once you sign inReconnect Sentry · work",
    );
    expect(findSwitch("sentry").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(
      within(popover).getByRole("button", { name: "Reconnect Sentry · work", hidden: true }),
    );

    expect(await screen.findByRole("dialog", { name: "Reconnect Sentry · work" })).toBeTruthy();
  });

  it("offers Sign in… for a server added by URL that needs a token, which opens its token dialog", async () => {
    const signedOut = { ...NOTION, status: "needs-sign-in" } as const;
    const thread = threadWith([signedOut]);
    const { world } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [signedOut],
    });
    const popover = await openServersSubmenu();

    // A server added by URL is written by its name alone, never with its address beside it.
    expect(readSubmenuRows(popover)).toEqual(["notion"]);
    fireEvent.click(within(popover).getByRole("button", { name: "Sign in…", hidden: true }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in to notion" });
    await userEvent.type(within(dialog).getByLabelText("Token"), "abcd1234efgh5678");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));
    await waitFor(() => {
      expect(world.tokens).toEqual([{ id: NOTION.id, token: "abcd1234efgh5678" }]);
    });
  });

  it("keeps the thread on the live topic while a sign-in dialog opened from the submenu follows its server, on a thread with an empty list", async () => {
    const signedOut = { ...NOTION, status: "needs-sign-in" } as const;
    const app = await openComposerApp(`/?project=${WEBSHOP.id}`, { servers: [signedOut] });
    const popover = await openServersSubmenu();
    expect(readSubmenuRows(popover)).toEqual(["notion"]);
    fireEvent.click(within(popover).getByRole("button", { name: "Sign in…", hidden: true }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to notion" });
    await userEvent.type(within(dialog).getByLabelText("Token"), "abcd1234efgh5678");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));
    await within(dialog).findByText("Asking mcp.notion.example for its tools.");

    // The menu that opened the dialog is closed now, and nothing else on the thread names a server.
    toggleMenu(popover, "closed");
    expect(app.live.readTopics()).toContain("mcpServer");
    app.world.servers = app.world.servers.map((server) =>
      server.id === NOTION.id ? { ...server, status: "ready" } : server,
    );
    act(() => {
      app.live.pushInvalidation("mcpServer", [NOTION.id]);
    });

    await within(dialog).findByText("ready · 2 tools");
  });

  it.each([
    [
      "deleted",
      (app: { world: { servers: McpServer[] } }) => {
        app.world.servers = [];
      },
      "notion was removed.",
    ],
    [
      "moved onto a Connection",
      (app: { world: { servers: McpServer[] } }) => {
        app.world.servers = app.world.servers.map((server) =>
          buildServer(server.id, "notion", LINEAR_CONNECTION),
        );
      },
      "notion is reached with a Connection now.",
    ],
  ])(
    "ends a browser sign-in that waits when its server is %s meanwhile, and sends nothing when the browser returns after that",
    async (_name, change, words) => {
      const returns: ((outcome: { _tag: "received"; callbackQuery: string }) => void)[] = [];
      const signInReturn = {
        listen: vi.fn(() =>
          Promise.resolve({
            _tag: "listening",
            listenerId: "l-1",
            redirectUri: "http://127.0.0.1:4937/callback",
          } as const),
        ),
        wait: vi.fn(
          () =>
            new Promise<{ _tag: "received"; callbackQuery: string }>((resolve) => {
              returns.push(resolve);
            }),
        ),
        cancel: vi.fn(() => Promise.resolve(undefined)),
      };
      const signedOut = {
        ...NOTION,
        status: "needs-sign-in",
        source: { ...NOTION.source, signIn: "none", signInOffered: "oauth" },
      } as McpServer;
      const app = await openComposerApp(`/?project=${WEBSHOP.id}`, {
        servers: [signedOut],
        signInReturn,
      });
      const popover = await openServersSubmenu();
      fireEvent.click(within(popover).getByRole("button", { name: "Sign in…", hidden: true }));
      const dialog = await screen.findByRole("dialog", { name: "Sign in to notion" });
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Sign in with your browser" }),
      );
      await within(dialog).findByText("Finish in your browser");

      change(app);
      act(() => {
        app.live.pushInvalidation("mcpServer", [NOTION.id]);
      });
      await within(dialog).findByText(words);
      await act(async () => {
        returns[0]!({ _tag: "received", callbackQuery: "code=the-code&state=abc123" });
        await Promise.resolve();
      });

      expect(signInReturn.cancel).toHaveBeenCalledWith({ listenerId: "l-1" });
      expect(findCalls(app.calls, "POST", `${SERVER_LIST}/${NOTION.id}/sign-in/finish`)).toEqual(
        [],
      );
    },
  );

  it("says why Reconnect cannot go on when its Connection is deleted while the dialog is open, and closes with Close", async () => {
    const thread = threadWith([SENTRY_WORK]);
    const { context } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_SIGNED_OUT],
    });
    const popover = await openServersSubmenu();
    fireEvent.click(
      within(popover).getByRole("button", { name: "Reconnect Sentry · work", hidden: true }),
    );
    await screen.findByRole("dialog", { name: "Reconnect Sentry · work" });

    act(() => {
      context.queryClient.setQueryData(queryKeys.connections(), []);
    });

    const dialog = await screen.findByRole("dialog", { name: "Reconnect" });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "This Connection was deleted elsewhere, so it cannot be reconnected.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Reconnect" })).toBeNull();
    });
  });

  it("keeps the attach row off and the MCP servers row usable while the composer answers a question", async () => {
    const asking: ThreadRecords = withServers(
      {
        ...THREAD_FIXTURES.waiting,
        session: {
          ...THREAD_FIXTURES.waiting.session,
          openRequests: [
            {
              requestId: "req-2",
              itemId: "tool-2",
              kind: "question",
              detail: {
                questions: [
                  {
                    question: "Which storage?",
                    header: "Storage",
                    options: [],
                    multiSelect: false,
                  },
                ],
              },
            },
          ],
        },
      },
      [LINEAR],
    );
    await openComposerApp(`/threads/${asking.session.id}`, { thread: asking, servers: [LINEAR] });
    const popover = await findPlusPopover();
    toggleMenu(popover, "open");

    const attach = within(popover).getByRole("menuitem", { name: "Attach an image", hidden: true });
    const servers = within(popover).getByRole("menuitem", { name: /^MCP servers/, hidden: true });

    expect(attach.getAttribute("aria-disabled")).toBe("true");
    expect(servers.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(servers);
    await within(popover).findByRole("group", { name: "Servers of this thread", hidden: true });
  });
});

/** Returns the body of a 403 that names the missing grant, which the client decodes. */
const buildForbiddenBody = (message: string) => ({
  error: { code: "forbidden", message, details: { grant: "mcp.manage" } },
});

describe("the + menu's writes that end badly", () => {
  const REFUSAL = "This session needs the grant mcp.manage.";

  it("keeps the switches off and says so while a write's list could not be read again, until a read answers", async () => {
    const thread = threadWith([LINEAR]);
    const sessionPath = `GET /api/v1/sessions/${thread.session.id}`;
    let failing = false;
    let readSession: () => Session = () => thread.session;
    const { calls, context, ...rest } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, LINEAR],
      handlers: {
        [sessionPath]: () =>
          failing
            ? { status: 500, body: buildErrorBody("internal", "The controller fell over.") }
            : { body: readSession() },
      },
    });
    readSession = rest.readSession;
    const popover = await openServersSubmenu();

    failing = true;
    fireEvent.click(findSwitch("sentry"));

    const note = await within(popover).findByRole("alert", { hidden: true });
    expect(note.textContent).toBe("Saved, but the list could not be read again.");
    expect(findSwitch("linear").getAttribute("aria-disabled")).toBe("true");
    // The cache still holds the old list, so a write now would undo the one that was saved.
    fireEvent.click(findSwitch("linear"));
    expect(readListWrites(calls, thread.session.id)).toHaveLength(1);

    failing = false;
    await act(() =>
      context.queryClient.invalidateQueries({ queryKey: queryKeys.session(thread.session.id) }),
    );

    await waitFor(() => {
      expect(findSwitch("linear").getAttribute("aria-disabled")).toBe("false");
    });
    expect(findSwitch("sentry").getAttribute("aria-checked")).toBe("true");
    expect(within(popover).queryByRole("alert", { hidden: true })).toBeNull();
  });

  it("shows a refusal that came after the menu was closed, when the menu opens again", async () => {
    const thread = threadWith([LINEAR]);
    const held = holdAnswer();
    await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, LINEAR],
      handlers: { [`PATCH /api/v1/sessions/${thread.session.id}`]: held.handler },
    });
    const popover = await openServersSubmenu();
    fireEvent.click(findSwitch("sentry"));
    await waitFor(() => {
      expect(findSwitch("linear").getAttribute("aria-disabled")).toBe("true");
    });
    toggleMenu(popover, "closed");

    held.answer({ status: 403, body: buildForbiddenBody(REFUSAL) });
    await waitFor(() => {
      expect(document.querySelector(".plus-error")).toBeNull();
    });
    await openServersSubmenu();

    expect((await within(popover).findByRole("alert", { hidden: true })).textContent).toBe(REFUSAL);
  });

  it("keeps a refusal the menu showed through closing the menu and opening it again", async () => {
    const thread = threadWith([LINEAR]);
    await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, LINEAR],
      handlers: {
        [`PATCH /api/v1/sessions/${thread.session.id}`]: {
          status: 403,
          body: buildForbiddenBody(REFUSAL),
        },
      },
    });
    const popover = await openServersSubmenu();
    fireEvent.click(findSwitch("sentry"));
    await within(popover).findByRole("alert", { hidden: true });

    toggleMenu(popover, "closed");
    await openServersSubmenu();

    expect((await within(popover).findByRole("alert", { hidden: true })).textContent).toBe(REFUSAL);
  });

  it("keeps a refusal the submenu showed through the handoff to the picker and back, until the next write", async () => {
    const thread = threadWith([LINEAR]);
    const nine = buildManyServers(9);
    const { calls } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, LINEAR, ...nine],
      handlers: {
        [`PATCH /api/v1/sessions/${thread.session.id}`]: {
          status: 403,
          body: buildForbiddenBody(REFUSAL),
        },
      },
    });
    const popover = await openServersSubmenu();
    fireEvent.click(findSwitch("sentry"));
    await within(popover).findByRole("alert", { hidden: true });

    fireEvent.click(
      within(popover).getByRole("menuitem", { name: /more servers?…$/, hidden: true }),
    );
    const picker = await screen.findByRole("dialog", { name: "MCP servers of this thread" });
    toggleMenu(popover, "closed");

    expect((await within(picker).findByRole("alert")).textContent).toBe(REFUSAL);

    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "MCP servers of this thread" })).toBeNull();
    });
    await openServersSubmenu();

    expect((await within(popover).findByRole("alert", { hidden: true })).textContent).toBe(REFUSAL);
    expect(readListWrites(calls, thread.session.id)).toHaveLength(1);
  });

  it("keeps the picker's rows, account choice and way back off while a write runs, and ignores presses on them", async () => {
    const thread = threadWith([SENTRY_WORK]);
    const held = holdAnswer();
    const { calls } = await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, SENTRY_HOBBY, LINEAR, ...buildManyServers(9)],
      projects: [webshopWith([LINEAR_ID]), OPS],
      holdWrite: held.handler,
    });
    const popover = await openServersSubmenu();
    fireEvent.click(
      within(popover).getByRole("menuitem", { name: /more servers?…$/, hidden: true }),
    );
    const picker = await screen.findByRole("dialog", { name: "MCP servers of this thread" });
    const account = () =>
      within(picker).getByRole<HTMLSelectElement>("combobox", { name: "Account of sentry" });
    const wayBack = () => within(picker).getByRole("button", { name: "Back to webshop's list" });
    const linear = () => within(picker).getByRole("checkbox", { name: /linear/ });

    fireEvent.change(account(), { target: { value: SENTRY_HOBBY_ID } });

    await waitFor(() => {
      expect(account().getAttribute("aria-disabled")).toBe("true");
    });
    expect(linear().getAttribute("aria-disabled")).toBe("true");
    expect(wayBack().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(linear());
    fireEvent.click(wayBack());
    expect(readListWrites(calls, thread.session.id)).toHaveLength(1);

    held.answer({ body: {} });

    await waitFor(() => {
      expect(wayBack().getAttribute("aria-disabled")).toBe("false");
    });
    expect(readListWrites(calls, thread.session.id)).toHaveLength(1);
  });
});

describe("the + menu on a thread that cannot be resumed", () => {
  it("turns Attach off and keeps the MCP servers row working, so the list can still be edited", async () => {
    const exited = withServers(
      {
        ...THREAD_FIXTURES.finished,
        session: {
          ...THREAD_FIXTURES.finished.session,
          status: "exited",
          resumable: false,
          nativeSessionId: null,
          exitedAt: "2026-09-10T09:04:00.000Z",
        },
      },
      [LINEAR],
    );
    const { calls } = await openComposerApp(`/threads/${exited.session.id}`, {
      thread: exited,
      servers: [SENTRY_WORK, LINEAR],
    });
    const popover = await findPlusPopover();
    toggleMenu(popover, "open");
    expect(
      within(popover)
        .getByRole("menuitem", { name: "Attach an image", hidden: true })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    await openServersSubmenu();
    fireEvent.click(findSwitch("sentry"));

    await waitFor(() => {
      expect(readListWrites(calls, exited.session.id)).toHaveLength(1);
    });
  });
});

describe("the + before the code of the servers' submenu has loaded", () => {
  it("draws the + and the count on its MCP row with the composer, and no submenu", async () => {
    const thread = threadWith([SENTRY_WORK, LINEAR]);
    await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_WORK, LINEAR],
    });

    // No wait for a chunk: the button and its words are part of the composer.
    const popover = document.querySelector<HTMLElement>("[popover][aria-label='Add']")!;
    expect(screen.getByRole("button", { name: "Add" })).not.toBeNull();
    toggleMenu(popover, "open");

    expect(readServersRowWords(popover)).toBe("2");
    expect(
      screen.queryByRole("group", { name: "Servers of this thread", hidden: true }),
    ).toBeNull();
  });

  it("puts the red dot on the + as soon as the servers say one needs sign-in", async () => {
    const thread = threadWith([SENTRY_WORK]);
    await openComposerApp(`/threads/${thread.session.id}`, {
      thread,
      servers: [SENTRY_SIGNED_OUT],
    });

    expect(screen.getByRole("button", { name: "Add (1 needs sign-in)" })).not.toBeNull();
    expect(document.querySelector(".plus-dot")).not.toBeNull();
  });

  it.each([
    ["a Draft Thread", `/?project=${WEBSHOP.id}`],
    ["a started thread", `/threads/${THREAD_FIXTURES.finished.session.id}`],
  ])("attaches on the first click on %s, loading nothing of the servers", async (_name, path) => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    try {
      const { calls } = await openComposerApp(path, { servers: [SENTRY_WORK] });
      const popover = document.querySelector<HTMLElement>("[popover][aria-label='Add']")!;
      toggleMenu(popover, "open");

      fireEvent.click(
        within(popover).getByRole("menuitem", { name: "Attach an image", hidden: true }),
      );

      expect(click).toHaveBeenCalledTimes(1);
      expect(findCalls(calls, "GET", SERVER_LIST)).toHaveLength(0);
      expect(
        screen.queryByRole("group", { name: "Servers of this thread", hidden: true }),
      ).toBeNull();
    } finally {
      click.mockRestore();
    }
  });

  it("keeps the focus on the same + while the submenu loads and draws", async () => {
    const thread = threadWith([LINEAR]);
    await openComposerApp(`/threads/${thread.session.id}`, { thread, servers: [LINEAR] });
    const trigger = screen.getByRole("button", { name: "Add" });
    trigger.focus();
    const popover = document.querySelector<HTMLElement>("[popover][aria-label='Add']")!;
    toggleMenu(popover, "open");

    fireEvent.click(within(popover).getByRole("menuitem", { name: /^MCP servers/, hidden: true }));
    await within(popover).findByRole("group", { name: "Servers of this thread", hidden: true });
    await waitFor(() => {
      expect(popover.querySelector(".plus-row")).not.toBeNull();
    });

    expect(screen.getByRole("button", { name: "Add" })).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
  });
});
