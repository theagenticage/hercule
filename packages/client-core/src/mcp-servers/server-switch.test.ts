import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { ApiError, ConnectionError } from "../errors";
import { buildMcpListQuery } from "./list-edits";
import { DETACHED_REFUSAL_LIFETIME_MS } from "./edit-guard";
import {
  buildOfferSwitchTarget,
  buildServerSwitchTarget,
  createMcpServerSwitches,
  decideServerPageSwitch,
  findOrCreateMcpServerSwitches,
  type McpServerSwitchCache,
  type McpServerSwitchTarget,
} from "./server-switch";
import { joinOfferedServers } from "./offers";
import { CONNECTIONS, OFFERING_PLUGINS, SENTRY_WORK, buildServer } from "./testing";

// A conflict's details are decoded, so the id must be a real one.
const WINNER_ID = "01a1fbc5-06ef-74bd-8d5f-998d787ac50e";

const WORK: McpServerSwitchTarget = {
  kind: "plugin",
  contributionId: "sentry/sentry",
  connectionId: "c-work",
};
const SERVERS_KEY = ["mcp-servers"];
const OFFER_ORIGIN = (contributionId: string) =>
  contributionId === "sentry/sentry" ? "https://mcp.sentry.example" : undefined;
const PAGE_KEY = (id: string) => ["mcp-server", id];
/** The read of a server's page. The switch only marks it stale, so no test reads it. */
const READ_PAGE = (id: string) => ({
  queryKey: PAGE_KEY(id),
  queryFn: () => Promise.reject(new Error(`the page of ${id} is not read`)),
});

/** A promise the test settles by hand. */
const hold = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** A controller that holds a list of servers, with a stub client that creates and updates them. */
const setup = async (initial: readonly McpServer[] = []) => {
  const world = {
    servers: [...initial],
    readsFail: false,
    /** Holds the next read of the list until it is released, or `null`. */
    holdQuery: null as Promise<void> | null,
    /** The error the next update fails with, or `null`. */
    updateFails: null as Error | null,
    /** Holds the next update until it is released, or `null`. */
    holdUpdate: null as Promise<void> | null,
    /** True when the next update commits and then fails as if its reply was lost. */
    losesReply: false,
    /** Resolves the create that is running, or `null` while none waits. */
    finishCreate: null as ((error?: Error) => void) | null,
  };
  const client = {
    mcpServer: {
      query: vi.fn(async () => {
        const gate = world.holdQuery;
        world.holdQuery = null;
        if (gate !== null) await gate;
        if (world.readsFail) throw new Error("offline");
        return [...world.servers];
      }),
      create: vi.fn(
        () =>
          new Promise<unknown>((resolve, reject) => {
            world.finishCreate = (error) => {
              if (error === undefined) {
                world.servers = [...world.servers, SENTRY_WORK];
                resolve({ answeredWith: "not a record" });
              } else reject(error);
            };
          }),
      ),
      update: vi.fn(
        async (request: {
          params: { id: string };
          payload: { enabled?: boolean; source?: McpServer["source"] };
        }) => {
          const gate = world.holdUpdate;
          world.holdUpdate = null;
          if (gate !== null) await gate;
          if (world.updateFails !== null) throw world.updateFails;
          const lostReply = world.losesReply;
          world.losesReply = false;
          const { enabled, source } = request.payload;
          world.servers = world.servers.map((server) =>
            server.id === request.params.id
              ? {
                  ...server,
                  ...(enabled === undefined ? {} : { enabled }),
                  ...(source === undefined ? {} : { source }),
                }
              : server,
          );
          if (lostReply) throw new ConnectionError("http://controller.test", new Error("reset"));
          return { answeredWith: "not a record" };
        },
      ),
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const catalogue = buildMcpListQuery(queryClient, {
    queryKey: SERVERS_KEY,
    queryFn: () => client.mcpServer.query(),
  });
  await catalogue.fetch();
  const cache: McpServerSwitchCache = {
    readServers: () => queryClient.getQueryData<McpServer[]>(SERVERS_KEY),
    readCatalogue: () => catalogue,
    readOfferOrigin: OFFER_ORIGIN,
    readServerQuery: READ_PAGE,
  };
  const switches = createMcpServerSwitches({
    queryClient,
    client: client as unknown as HerculeClient,
    cache,
  });
  const settle = (target: McpServerSwitchTarget) =>
    vi.waitFor(() => {
      expect(switches.readState(target).blocked).toBe(false);
    });
  return { world, client, queryClient, switches, settle };
};

describe("the target of a switch", () => {
  it("is the same for a server's row, with or without a record, and for its page", () => {
    const [offered] = joinOfferedServers({
      servers: [],
      connections: [CONNECTIONS[0]!],
      plugins: OFFERING_PLUGINS,
    });

    expect(buildOfferSwitchTarget(offered!)).toEqual(WORK);
    expect(buildServerSwitchTarget(SENTRY_WORK)).toEqual(WORK);
  });

  it("is the record id for a server added by URL", () => {
    const byUrl = buildServer("s-url", "docs", "c-none", {
      source: { kind: "url", url: "https://docs.example/mcp", signIn: "none", signInOffered: null },
    });

    expect(buildServerSwitchTarget(byUrl)).toEqual({ kind: "url", serverId: "s-url" });
  });
});

describe("a press on the switch", () => {
  it("creates the server of an offer that has no record, ignores a second press meanwhile, and updates it on the next press", async () => {
    const { world, client, switches, settle } = await setup();

    switches.apply(WORK, true);
    switches.apply(WORK, true);

    expect(switches.readState(WORK).blocked).toBe(true);
    expect(client.mcpServer.create).toHaveBeenCalledExactlyOnceWith({
      payload: {
        source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
      },
    });
    world.finishCreate!();
    await settle(WORK);
    // The list was read again, so the record is known now.
    switches.apply(WORK, false);
    await settle(WORK);
    expect(client.mcpServer.create).toHaveBeenCalledTimes(1);
    expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      params: { id: "s-work" },
      payload: { enabled: false },
    });
  });

  it("updates the record when the cache holds one, turning it off or on", async () => {
    const { client, switches, settle } = await setup([SENTRY_WORK]);

    switches.apply(WORK, false);
    await settle(WORK);

    expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      params: { id: "s-work" },
      payload: { enabled: false },
    });
    expect(client.mcpServer.create).not.toHaveBeenCalled();
  });

  it("does nothing for an off of a server that was never switched on", async () => {
    const { client, switches } = await setup();

    switches.apply(WORK, false);

    expect(client.mcpServer.create).not.toHaveBeenCalled();
    expect(switches.readState(WORK).blocked).toBe(false);
  });

  it("keeps the switch guarded when a read brings the record in while a create runs, and turns the next press into an update", async () => {
    const { world, client, queryClient, switches, settle } = await setup();
    switches.apply(WORK, true);

    // Another client created the server, and a real read of the list brings its record in.
    world.servers = [SENTRY_WORK];
    await queryClient.fetchQuery({
      queryKey: SERVERS_KEY,
      queryFn: () => client.mcpServer.query(),
      staleTime: 0,
    });
    const [arrived] = queryClient.getQueryData<McpServer[]>(SERVERS_KEY)!;
    // The press names its target from the stored source of the record that arrived, as the server's page does.
    const target = buildServerSwitchTarget(arrived!);
    switches.apply(target, false);

    expect(target).toEqual(WORK);
    expect(switches.readState(target).blocked).toBe(true);
    expect(client.mcpServer.update).not.toHaveBeenCalled();

    // The controller refuses the create, as the server exists already.
    world.finishCreate!(new ApiError("conflict", "A server of this Connection exists."));
    await settle(target);

    switches.apply(target, false);
    await settle(target);
    expect(client.mcpServer.create).toHaveBeenCalledTimes(1);
    expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      params: { id: "s-work" },
      payload: { enabled: false },
    });
    expect(switches.readState(target).refusal).toBeNull();
  });

  it("shows the controller's reason until another record shows for the target, such as a server another client created", async () => {
    const { world, queryClient, switches, settle } = await setup();

    switches.apply(WORK, true);
    world.finishCreate!(new ApiError("conflict", "A server of this Connection exists."));
    await settle(WORK);
    expect(switches.readState(WORK).refusal).toEqual({
      kind: "refused",
      message: "A server of this Connection exists.",
    });
    const shown = switches.readState(WORK);
    expect(switches.readState(WORK)).toBe(shown);

    queryClient.setQueryData(SERVERS_KEY, [SENTRY_WORK]);

    expect(switches.readState(WORK).refusal).toBeNull();
    expect(switches.readState(WORK)).toBe(switches.readState(WORK));
  });

  it("puts no response of the write in the cache", async () => {
    const { queryClient, switches, settle } = await setup([SENTRY_WORK]);

    switches.apply(WORK, false);
    await settle(WORK);

    expect(queryClient.getQueryData<McpServer[]>(SERVERS_KEY)).toEqual([
      { ...SENTRY_WORK, enabled: false },
    ]);
  });

  it("marks the server's page stale, because the page holds the old record", async () => {
    const { queryClient, switches, settle } = await setup([SENTRY_WORK]);
    queryClient.setQueryData(PAGE_KEY("s-work"), SENTRY_WORK);

    switches.apply(WORK, false);
    await settle(WORK);

    expect(queryClient.getQueryState(PAGE_KEY("s-work"))?.isInvalidated).toBe(true);
  });

  it("keeps the target blocked, saying the change was saved, until a read of the list succeeds", async () => {
    const { world, client, queryClient, switches, settle } = await setup([SENTRY_WORK]);
    world.readsFail = true;

    switches.apply(WORK, false);
    await vi.waitFor(() => {
      expect(switches.readState(WORK).unread).toEqual({ saved: true });
    });
    switches.apply(WORK, true);
    expect(client.mcpServer.update).toHaveBeenCalledTimes(1);

    world.readsFail = false;
    await queryClient.fetchQuery({
      queryKey: SERVERS_KEY,
      queryFn: () => client.mcpServer.query(),
      staleTime: 0,
    });
    await settle(WORK);
  });

  it("is not released by a patch of the cache by hand, only by a fetch of the list", async () => {
    const { world, client, queryClient, switches, settle } = await setup([SENTRY_WORK]);
    world.readsFail = true;
    switches.apply(WORK, false);
    await vi.waitFor(() => {
      expect(switches.readState(WORK).unread).toEqual({ saved: true });
    });

    queryClient.setQueryData(SERVERS_KEY, [SENTRY_WORK]);
    switches.apply(WORK, true);

    expect(switches.readState(WORK).blocked).toBe(true);
    expect(client.mcpServer.update).toHaveBeenCalledTimes(1);
    world.readsFail = false;
    await queryClient.fetchQuery({
      queryKey: SERVERS_KEY,
      queryFn: () => client.mcpServer.query(),
      staleTime: 0,
    });
    await settle(WORK);
  });

  it("drops a refusal that no control shows after its lifetime", async () => {
    vi.useFakeTimers();
    try {
      const { world, switches, settle } = await setup();
      const detach = switches.attach(WORK);
      switches.apply(WORK, true);
      world.finishCreate!(new ApiError("conflict", "A server of this Connection exists."));
      await settle(WORK);
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS * 2);
      expect(switches.readState(WORK).refusal).not.toBeNull();

      detach();
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS);

      expect(switches.readState(WORK).refusal).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses, with a reason, while the list of servers is not cached", () => {
    const queryClient = new QueryClient();
    const catalogue = buildMcpListQuery(queryClient, { queryKey: SERVERS_KEY, queryFn: () => [] });
    const switches = createMcpServerSwitches({
      queryClient,
      client: {} as HerculeClient,
      cache: {
        readServers: () => undefined,
        readCatalogue: () => catalogue,
        readOfferOrigin: OFFER_ORIGIN,
        readServerQuery: READ_PAGE,
      },
    });

    switches.apply(WORK, true);

    expect(switches.readState(WORK).refusal).toMatchObject({ kind: "refused" });
  });

  it("refuses the switch of a URL server whose record is gone", async () => {
    const { client, switches } = await setup();
    const target: McpServerSwitchTarget = { kind: "url", serverId: "s-gone" };

    switches.apply(target, true);

    expect(client.mcpServer.update).not.toHaveBeenCalled();
    expect(switches.readState(target).refusal).toMatchObject({ kind: "refused" });
  });

  it("never creates the server of a page whose record left the list, and refuses with a reason", async () => {
    const { client, queryClient, switches } = await setup([SENTRY_WORK]);
    queryClient.setQueryData(SERVERS_KEY, []);

    switches.apply(WORK, true, SENTRY_WORK.id);

    expect(client.mcpServer.create).not.toHaveBeenCalled();
    expect(client.mcpServer.update).not.toHaveBeenCalled();
    expect(switches.readState(WORK).refusal).toMatchObject({ kind: "refused" });
  });

  it("updates the page's own record, and never a record created again under another id", async () => {
    const { client, queryClient, switches, settle } = await setup([SENTRY_WORK]);

    switches.apply(WORK, false, SENTRY_WORK.id);
    await settle(WORK);
    expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      params: { id: SENTRY_WORK.id },
      payload: { enabled: false },
    });

    queryClient.setQueryData(SERVERS_KEY, [{ ...SENTRY_WORK, id: "s-recreated" }]);
    switches.apply(WORK, true, SENTRY_WORK.id);

    expect(client.mcpServer.update).toHaveBeenCalledTimes(1);
    expect(switches.readState(WORK).refusal).toMatchObject({ kind: "refused" });
  });

  it("shares one guard between every consumer of a query client", async () => {
    const { queryClient, client } = await setup();
    const options = {
      queryClient,
      client: client as unknown as HerculeClient,
      cache: {
        readServers: () => [],
        readCatalogue: () =>
          buildMcpListQuery(queryClient, { queryKey: SERVERS_KEY, queryFn: () => [] }),
        readOfferOrigin: OFFER_ORIGIN,
        readServerQuery: READ_PAGE,
      },
    };

    expect(findOrCreateMcpServerSwitches(options)).toBe(findOrCreateMcpServerSwitches(options));
  });
});

/** A server added by URL on the Sentry plugin's origin. */
const docsByUrl = (id: string, path = "/mcp", overrides: Partial<McpServer> = {}): McpServer =>
  buildServer(id, "docs", "", {
    source: {
      kind: "url",
      url: `https://mcp.sentry.example${path}`,
      signIn: "token",
      signInOffered: "token",
    },
    enabled: false,
    ...overrides,
  });

const URL_TARGET = (serverId: string): McpServerSwitchTarget => ({ kind: "url", serverId });

describe("switching an offer on while a server added by URL sits on its origin", () => {
  it("writes nothing and returns the candidates, resolved from the list at this moment", async () => {
    const { client, switches } = await setup([docsByUrl("s-a"), docsByUrl("s-b", "/sse")]);

    const press = switches.apply(WORK, true);

    expect(press).toEqual({ kind: "replace" });
    expect(client.mcpServer.create).not.toHaveBeenCalled();
    expect(switches.readState(WORK).blocked).toBe(false);
  });

  it("creates the server as usual when no server added by URL sits on the origin, or on another one", async () => {
    const { client, switches } = await setup([
      buildServer("s-other", "other", "", {
        source: {
          kind: "url",
          url: "https://other.example/mcp",
          signIn: "none",
          signInOffered: null,
        },
      }),
    ]);

    expect(switches.apply(WORK, true)).toEqual({ kind: "handled" });
    expect(client.mcpServer.create).toHaveBeenCalledTimes(1);
  });

  it("only updates the record of the offer when it has one, whatever sits on the origin", async () => {
    const { client, switches, settle } = await setup([
      { ...SENTRY_WORK, enabled: false },
      docsByUrl("s-a"),
    ]);

    expect(switches.apply(WORK, true)).toEqual({ kind: "handled" });
    await settle(WORK);

    expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      params: { id: "s-work" },
      payload: { enabled: true },
    });
  });

  it("does not ask for Replace to switch the offer off", async () => {
    const { client, switches } = await setup([docsByUrl("s-a")]);

    expect(switches.apply(WORK, false)).toEqual({ kind: "handled" });
    expect(client.mcpServer.update).not.toHaveBeenCalled();
  });
});

const WORDS = { connectionLabel: "work", typeName: "Sentry" };

describe("the Replace dialog", () => {
  const winnerRecord = (): McpServer => ({ ...SENTRY_WORK, id: WINNER_ID, name: "sentry_win" });
  /** The record of `s-a` after another client moved it onto the Connection. */
  const movedA = (): McpServer => ({
    ...docsByUrl("s-a"),
    enabled: true,
    source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
  });
  /** Opens the dialog the way an app does after a press, and returns a reader of what it draws. */
  const openDialog = async (initial: readonly McpServer[]) => {
    const setUp = await setup(initial);
    const { switches } = setUp;
    expect(switches.apply(WORK, true)).toEqual({ kind: "replace" });
    switches.openReplace(WORK, WORDS);
    const view = () => switches.readReplaceDialog(WORK)!;
    return { ...setUp, view };
  };

  describe("what it asks", () => {
    it("asks about the one server added by URL, with it selected, and lists nothing to choose from", async () => {
      const { switches, view } = await openDialog([docsByUrl("s-a")]);

      expect(view()).toEqual({
        title: "Replace the docs server you added?",
        body: "You added https://mcp.sentry.example/mcp by hand, with a sign-in of its own. Sentry · work reaches the same server, and one address and account is one server.",
        lines: [
          { label: "Stays", text: "the name and the projects that name it." },
          { label: "Changes", text: "it acts through the Connection." },
          { label: "Goes", text: "the sign-in made by hand." },
        ],
        choices: null,
        selectedId: "s-a",
        locked: false,
        notice: null,
        canReplace: true,
        done: false,
      });
      expect(switches.readReplaceDialog(URL_TARGET("s-a"))).toBeNull();
    });

    it("chooses nothing among several: Replace is off until the user picks, and the pick is the title", async () => {
      const { client, switches, view } = await openDialog([
        docsByUrl("s-a"),
        { ...docsByUrl("s-b", "/sse"), name: "wiki" },
      ]);

      expect(view()).toMatchObject({
        title: "Which server do you replace?",
        body: null,
        lines: [],
        selectedId: null,
        canReplace: false,
        choices: [
          { serverId: "s-a", name: "docs", address: "https://mcp.sentry.example/mcp" },
          { serverId: "s-b", name: "wiki", address: "https://mcp.sentry.example/sse" },
        ],
      });
      switches.confirmReplace(WORK);
      expect(client.mcpServer.update).not.toHaveBeenCalled();

      switches.pickReplaceServer(WORK, "s-b");

      expect(view()).toMatchObject({
        title: "Replace the wiki server you added?",
        selectedId: "s-b",
        canReplace: true,
      });
    });

    it("ignores a pick of a server that is not listed", async () => {
      const { switches, view } = await openDialog([docsByUrl("s-a"), docsByUrl("s-b", "/sse")]);

      switches.pickReplaceServer(WORK, "s-gone");

      expect(view().selectedId).toBeNull();
    });

    it("returns null for a target that is not a plugin's, and when no dialog is open", async () => {
      const { switches } = await setup([docsByUrl("s-a")]);

      expect(switches.readReplaceDialog(WORK)).toBeNull();
      switches.openReplace(URL_TARGET("s-a"), WORDS);
      expect(switches.readReplaceDialog(URL_TARGET("s-a"))).toBeNull();
    });
  });

  describe("the list changing under the dialog", () => {
    it("follows the list: a server that appeared is offered, to be chosen", async () => {
      const { queryClient, switches, view } = await openDialog([
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
      ]);
      switches.pickReplaceServer(WORK, "s-a");

      queryClient.setQueryData(SERVERS_KEY, [
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
        docsByUrl("s-c", "/v2"),
      ]);

      expect(view().choices?.map((choice) => choice.serverId)).toEqual(["s-a", "s-b", "s-c"]);
      expect(view().selectedId).toBe("s-a");
    });

    it("says the chosen server is gone, chooses nothing, and never moves the choice to a server that is left", async () => {
      const { client, queryClient, switches, view } = await openDialog([
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
      ]);
      switches.pickReplaceServer(WORK, "s-a");

      queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-b", "/sse")]);

      expect(view()).toMatchObject({
        selectedId: null,
        canReplace: false,
        choices: [{ serverId: "s-b" }],
        notice: {
          kind: "lost-choice",
          message:
            "The server you chose is gone, or is not added by URL on this address any more. Nothing was replaced. Choose again.",
        },
      });
      switches.confirmReplace(WORK);
      expect(client.mcpServer.update).not.toHaveBeenCalled();
    });

    it("says the chosen server moved onto a Connection, the same way", async () => {
      const { queryClient, view, switches } = await openDialog([
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
      ]);
      switches.pickReplaceServer(WORK, "s-a");

      queryClient.setQueryData(SERVERS_KEY, [
        { ...docsByUrl("s-a"), source: movedA().source, id: "s-a" },
        docsByUrl("s-b", "/sse"),
      ]);

      // The moved server is a record of the Connection now, so it is also a winner.
      expect(view()).toMatchObject({ selectedId: null, canReplace: false });
      expect(view().notice).toMatchObject({ kind: "refused", winner: { serverId: "s-a" } });
    });

    it("says no server is left when the only candidate was deleted", async () => {
      const { queryClient, view } = await openDialog([docsByUrl("s-a")]);

      queryClient.setQueryData(SERVERS_KEY, []);

      expect(view()).toMatchObject({
        selectedId: null,
        choices: null,
        canReplace: false,
        notice: {
          kind: "empty",
          message:
            "The server you chose is gone, or is not added by URL on this address any more. Nothing was replaced.",
        },
      });
    });

    it("refuses with a link to the winner when another client's server arrives before the user confirms, and writes nothing", async () => {
      const { client, queryClient, switches, view } = await openDialog([docsByUrl("s-a")]);

      queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-a"), winnerRecord()]);

      expect(view().notice).toEqual({
        kind: "refused",
        message: "Nothing was replaced. This Connection's server was added meanwhile.",
        winner: { serverId: WINNER_ID, label: "Open sentry_win" },
        readAgainLabel: null,
      });
      expect(view().canReplace).toBe(false);
      switches.confirmReplace(WORK);
      expect(client.mcpServer.update).not.toHaveBeenCalled();
    });
  });

  describe("confirming", () => {
    it("moves the chosen server onto the Connection and switches it on, in one write, then closes the dialog's story with done", async () => {
      const { world, client, queryClient, switches, settle, view } = await openDialog([
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
      ]);
      queryClient.setQueryData(PAGE_KEY("s-b"), docsByUrl("s-b", "/sse"));
      switches.pickReplaceServer(WORK, "s-b");

      switches.confirmReplace(WORK);

      expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
        params: { id: "s-b" },
        payload: {
          source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
          enabled: true,
        },
      });
      expect(view()).toMatchObject({
        locked: true,
        selectedId: "s-b",
        canReplace: false,
        done: false,
        notice: { kind: "working", message: "Replacing…" },
      });
      await settle(WORK);
      await settle(URL_TARGET("s-b"));
      expect(view()).toMatchObject({ done: true, notice: null });
      // The page is marked stale, and the other candidate is left alone.
      expect(queryClient.getQueryState(PAGE_KEY("s-b"))?.isInvalidated).toBe(true);
      expect(world.servers.find(({ id }) => id === "s-a")?.source.kind).toBe("url");
      expect(client.mcpServer.create).not.toHaveBeenCalled();
    });

    it("writes once for two confirmations in the same tick, and not while a plain press on the chosen server's switch runs", async () => {
      const { client, switches, settle } = await openDialog([docsByUrl("s-a")]);

      switches.confirmReplace(WORK);
      switches.confirmReplace(WORK);
      switches.apply(WORK, true);

      expect(client.mcpServer.update).toHaveBeenCalledTimes(1);
      expect(client.mcpServer.create).not.toHaveBeenCalled();
      await settle(WORK);
    });

    it("is off while the chosen server's own switch has a write", async () => {
      const { client, switches, settle, view } = await openDialog([docsByUrl("s-a")]);

      switches.apply(URL_TARGET("s-a"), true);

      expect(view().canReplace).toBe(false);
      switches.confirmReplace(WORK);
      expect(client.mcpServer.update).toHaveBeenCalledTimes(1);
      await settle(URL_TARGET("s-a"));
      expect(view().canReplace).toBe(true);
    });

    it("keeps the confirmed server, its name and the servers listed at the confirmation, when the write moves it off the list", async () => {
      const { world, queryClient, switches, view } = await openDialog([
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
      ]);
      switches.pickReplaceServer(WORK, "s-b");
      world.holdUpdate = hold().promise;

      switches.confirmReplace(WORK);
      queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-a")]);

      expect(view()).toMatchObject({
        locked: true,
        title: "Replace the docs server you added?",
        selectedId: "s-b",
        choices: [{ serverId: "s-a" }, { serverId: "s-b" }],
      });
    });

    it("stays working, not done, while the write is held even when the list already shows the record", async () => {
      const { world, queryClient, switches, view } = await openDialog([docsByUrl("s-a")]);
      const gate = hold();
      world.holdUpdate = gate.promise;

      switches.confirmReplace(WORK);
      queryClient.setQueryData(SERVERS_KEY, [movedA()]);

      expect(view()).toMatchObject({ done: false, notice: { kind: "working" } });
      gate.resolve();
    });
  });

  describe("a refusal", () => {
    it.each([
      ["not_found", "gone."],
      ["invalid_state", "It is reached with a Connection."],
      ["validation", "Not a URL server."],
    ] as const)(
      "shows a %s from the controller, reads the list again, marks the chosen page stale and unlocks the dialog",
      async (code, message) => {
        const { world, queryClient, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
        queryClient.setQueryData(PAGE_KEY("s-a"), docsByUrl("s-a"));
        world.updateFails = new ApiError(code, message);

        switches.confirmReplace(WORK);
        await settle(WORK);

        expect(view()).toMatchObject({
          locked: false,
          selectedId: "s-a",
          canReplace: true,
          notice: { kind: "refused", message: `Nothing was replaced. ${message}`, winner: null },
        });
        expect(switches.readState(URL_TARGET("s-a")).blocked).toBe(false);
        expect(queryClient.getQueryState(PAGE_KEY("s-a"))?.isInvalidated).toBe(true);
      },
    );

    it("links to the winner of a lost race for the external account, and keeps the link once its record is in the list", async () => {
      const { world, queryClient, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      world.updateFails = new ApiError("conflict", "A server of this account exists.", {
        reason: "mcp-server-exists",
        mcpServerId: WINNER_ID,
      });

      switches.confirmReplace(WORK);
      await settle(WORK);
      // Another client's create arrives with the next read of the list.
      queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-a"), winnerRecord()]);

      expect(view().notice).toMatchObject({
        kind: "refused",
        message: "Nothing was replaced. A server of this account exists.",
        winner: { serverId: WINNER_ID, label: "Open sentry_win" },
      });
      // Replace is off while the Connection has a server.
      expect(view().canReplace).toBe(false);
    });

    it("links to a winner that arrives while the write is held, keeps the confirmed server selected, and writes once, to the confirmed id", async () => {
      const { world, client, queryClient, switches, settle, view } = await openDialog([
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
      ]);
      const gate = hold();
      world.holdUpdate = gate.promise;
      world.updateFails = new ApiError("conflict", "A server of this account exists.", {
        reason: "mcp-server-exists",
        mcpServerId: WINNER_ID,
      });
      switches.pickReplaceServer(WORK, "s-b");

      switches.confirmReplace(WORK);
      queryClient.setQueryData(SERVERS_KEY, [
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
        winnerRecord(),
      ]);

      expect(view()).toMatchObject({
        locked: true,
        selectedId: "s-b",
        notice: { kind: "refused", winner: { serverId: WINNER_ID } },
      });
      gate.resolve();
      await settle(WORK);
      expect(view()).toMatchObject({
        locked: false,
        notice: {
          kind: "refused",
          message: "Nothing was replaced. A server of this account exists.",
        },
      });
      expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
        params: { id: "s-b" },
        payload: expect.objectContaining({ enabled: true }) as unknown,
      });
    });

    it("keeps Replace off after a refusal that names the server holding the Connection, even when the list does not show that server", async () => {
      const { world, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      world.updateFails = new ApiError("conflict", "This Connection has a server already.", {
        reason: "mcp-server-exists",
        mcpServerId: WINNER_ID,
      });

      switches.confirmReplace(WORK);
      await settle(WORK);

      expect(view()).toMatchObject({
        selectedId: "s-a",
        canReplace: false,
        notice: { kind: "refused" },
      });
    });

    it("chooses nothing after a refusal that left the confirmed server out of the candidates, even with one candidate left", async () => {
      const { world, queryClient, switches, settle, view } = await openDialog([
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
      ]);
      switches.pickReplaceServer(WORK, "s-b");
      world.updateFails = new ApiError("not_found", "Gone.");
      const gate = hold();
      world.holdUpdate = gate.promise;

      switches.confirmReplace(WORK);
      // The confirmed server is deleted while the write is held: the dialog still names it.
      world.servers = [docsByUrl("s-a")];
      queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-a")]);
      expect(view()).toMatchObject({
        title: "Replace the docs server you added?",
        selectedId: "s-b",
      });
      gate.resolve();
      await settle(WORK);

      expect(view()).toMatchObject({
        title: "Which server do you replace?",
        locked: false,
        selectedId: null,
        canReplace: false,
        // The one left is listed, to be picked.
        choices: [{ serverId: "s-a" }],
        notice: { kind: "refused", message: "Nothing was replaced. Gone." },
      });
      switches.pickReplaceServer(WORK, "s-a");
      expect(view()).toMatchObject({ selectedId: "s-a", canReplace: true });
    });

    it("keeps the pick after a refusal when the confirmed server is still a candidate", async () => {
      const { world, switches, settle, view } = await openDialog([
        docsByUrl("s-a"),
        docsByUrl("s-b", "/sse"),
      ]);
      switches.pickReplaceServer(WORK, "s-b");
      world.updateFails = new ApiError("validation", "Not valid.");

      switches.confirmReplace(WORK);
      await settle(WORK);

      expect(view()).toMatchObject({ selectedId: "s-b", canReplace: true });
    });
  });

  describe("after the write", () => {
    it("stays working after the acknowledgement while the list read after it is held, and is done once that read shows the record", async () => {
      const { world, queryClient, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      const patch = hold();
      const read = hold();
      world.holdUpdate = patch.promise;
      switches.confirmReplace(WORK);
      // Another client's move of the same server reaches the cache before the acknowledgement.
      queryClient.setQueryData(SERVERS_KEY, [movedA()]);
      world.holdQuery = read.promise;

      patch.resolve();
      await vi.waitFor(() => {
        expect(world.holdQuery).toBeNull();
      });
      expect(view()).toMatchObject({ done: false, notice: { kind: "working" } });

      read.resolve();
      await settle(WORK);
      expect(view().done).toBe(true);
    });

    it("says the write is saved and the list could not be read, offers to read again, and is done once a read shows the record", async () => {
      const { world, queryClient, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      const patch = hold();
      world.holdUpdate = patch.promise;
      switches.confirmReplace(WORK);
      queryClient.setQueryData(SERVERS_KEY, [movedA()]);
      world.readsFail = true;

      patch.resolve();
      await vi.waitFor(() => {
        expect(view().notice?.kind).toBe("unread");
      });
      expect(view()).toMatchObject({
        locked: true,
        done: false,
        notice: {
          message:
            "The server was replaced, but the list of servers could not be read again, so the result is not shown yet.",
          readAgainLabel: "Read again",
        },
      });

      // A read that fails again leaves the same words.
      switches.readReplaceListAgain(WORK);
      expect(view().notice).toMatchObject({ kind: "working", message: "Reading the list again…" });
      await vi.waitFor(() => {
        expect(view().notice?.kind).toBe("unread");
      });

      world.readsFail = false;
      switches.readReplaceListAgain(WORK);
      await settle(WORK);
      expect(view()).toMatchObject({ done: true, notice: null });
    });

    it("refuses, without a winner, when the acknowledged server is gone from the list read after the write", async () => {
      const { world, queryClient, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      const patch = hold();
      const read = hold();
      world.holdUpdate = patch.promise;
      switches.confirmReplace(WORK);
      queryClient.setQueryData(SERVERS_KEY, [movedA()]);
      patch.resolve();
      await vi.waitFor(() => {
        expect(world.holdUpdate).toBeNull();
      });
      // Another client deletes the server after the write was acknowledged.
      world.holdQuery = read.promise;
      world.servers = [];

      read.resolve();
      await settle(WORK);
      expect(view().notice).toMatchObject({
        kind: "refused",
        message:
          "The server you chose was removed or moved by another client right after the write, so it is not on this Connection.",
        winner: null,
      });
      expect(view().done).toBe(false);
    });
  });

  describe("a write whose reply was lost", () => {
    it("is done, and leaves no refusal, when the list shows the confirmed server on the Connection", async () => {
      const { world, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      world.losesReply = true;

      switches.confirmReplace(WORK);
      await settle(WORK);

      expect(view()).toMatchObject({ done: true, notice: null });
      expect(switches.readState(WORK).refusal).toBeNull();
    });

    it("says nothing was replaced, and what the list shows, when the server did not move", async () => {
      const { world, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      world.updateFails = new ConnectionError("http://controller.test", new Error("reset"));

      switches.confirmReplace(WORK);
      await settle(WORK);

      expect(view()).toMatchObject({
        locked: false,
        done: false,
        notice: {
          kind: "refused",
          message:
            "Nothing was replaced. The controller's reply was lost, and the list shows the server did not move.",
        },
      });
    });

    it("says the outcome is not known while the list cannot be read, and is done when a read shows the server moved", async () => {
      const { world, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      world.losesReply = true;
      world.readsFail = true;

      switches.confirmReplace(WORK);
      await vi.waitFor(() => {
        expect(view().notice?.kind).toBe("unread");
      });
      expect(view().notice).toMatchObject({
        message:
          "The controller's reply was lost and the list of servers could not be read, so it is not known whether the server was replaced.",
        readAgainLabel: "Read again",
      });

      world.readsFail = false;
      switches.readReplaceListAgain(WORK);
      await settle(WORK);
      expect(view()).toMatchObject({ done: true, notice: null });
    });
  });

  describe("living with the app", () => {
    it("tells a subscriber `locked` at the first notification after the confirmation, with no later cache event", async () => {
      const { world, switches, view } = await openDialog([docsByUrl("s-a")]);
      const seen: boolean[] = [];
      const stop = switches.subscribeReplaceDialog(() => {
        seen.push(view().locked);
      });
      world.holdUpdate = hold().promise;

      switches.confirmReplace(WORK);

      expect(seen[0]).toBe(true);
      stop();
    });

    it("returns the same object while nothing changed, and does no Replace work for an unrelated change of the cache", async () => {
      const { queryClient, switches, view } = await openDialog([docsByUrl("s-a")]);
      const listener = vi.fn();
      const stop = switches.subscribeReplaceDialog(listener);
      const first = view();

      queryClient.setQueryData(["unrelated"], { anything: true });
      void queryClient.invalidateQueries({ queryKey: ["unrelated"] });

      expect(listener).not.toHaveBeenCalled();
      expect(view()).toBe(first);

      queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-a"), winnerRecord()]);
      expect(listener).toHaveBeenCalled();
      const refused = view();
      expect(refused.notice).toMatchObject({ kind: "refused" });
      expect(view()).toBe(refused);
      stop();
    });

    it("forgets the dialog and its refusal on close, and a dialog opened after starts from choosing", async () => {
      const { world, switches, settle, view } = await openDialog([docsByUrl("s-a")]);
      world.updateFails = new ApiError("not_found", "Gone.");
      switches.confirmReplace(WORK);
      await settle(WORK);
      expect(view().notice).toMatchObject({ kind: "refused" });

      switches.closeReplace(WORK);

      expect(switches.readReplaceDialog(WORK)).toBeNull();
      expect(switches.readState(WORK).refusal).toBeNull();
      switches.openReplace(WORK, WORDS);
      expect(view()).toMatchObject({ notice: null, selectedId: "s-a", locked: false });
    });

    it("keeps the guard of a write that still runs when the dialog is closed", async () => {
      const { world, switches, settle } = await openDialog([docsByUrl("s-a")]);
      const gate = hold();
      world.holdUpdate = gate.promise;
      switches.confirmReplace(WORK);

      switches.closeReplace(WORK);

      expect(switches.readState(WORK).blocked).toBe(true);
      gate.resolve();
      await settle(WORK);
    });
  });
});

describe("decideServerPageSwitch", () => {
  const page = buildServer("s-1", "sentry", "c-work", { enabled: true });
  const decide = (catalogued: McpServer | undefined, pageReadFailed = false) =>
    decideServerPageSwitch({ page, catalogued, pageReadFailed, reload: "Reload the page" });

  it("shows the record of the list, and waits for nothing while the page agrees with it", () => {
    expect(decide({ ...page })).toEqual({ on: true, waitReason: null });
  });

  it("shows the page's own value and waits while the list has no record of the server", () => {
    expect(decide(undefined)).toEqual({
      on: true,
      waitReason: "This server is not in the list of servers any more, so the switch waits.",
    });
  });

  it("shows the list's value and waits while the page's read shows another one", () => {
    expect(decide({ ...page, enabled: false })).toEqual({
      on: false,
      waitReason: "This page is reading the server again, so the switch waits.",
    });
  });

  it("says the page could not read the server again when that read failed, with the app's words to reopen it", () => {
    expect(decide({ ...page, enabled: false }, true).waitReason).toBe(
      "This page could not read the server again, so the switch waits. Reload the page to try again.",
    );
  });

  it("does not blame a failed read while the page agrees with the list", () => {
    expect(decide({ ...page }, true).waitReason).toBeNull();
  });
});
