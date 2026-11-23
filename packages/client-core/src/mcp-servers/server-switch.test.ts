import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { ApiError } from "../errors";
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
    readPageKey: PAGE_KEY,
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
        readPageKey: PAGE_KEY,
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
        readPageKey: PAGE_KEY,
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

    expect(press).toEqual({
      kind: "replace",
      candidates: [docsByUrl("s-a"), docsByUrl("s-b", "/sse")],
    });
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

describe("Replace", () => {
  it("moves the chosen server onto the Connection and switches it on, in one write", async () => {
    const { world, client, queryClient, switches, settle } = await setup([
      docsByUrl("s-a"),
      docsByUrl("s-b", "/sse"),
    ]);
    queryClient.setQueryData(PAGE_KEY("s-b"), docsByUrl("s-b", "/sse"));

    switches.replace(WORK, "s-b");

    expect(switches.readState(WORK).blocked).toBe(true);
    expect(switches.readState(URL_TARGET("s-b")).blocked).toBe(true);
    expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      params: { id: "s-b" },
      payload: {
        source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
        enabled: true,
      },
    });
    await settle(WORK);
    await settle(URL_TARGET("s-b"));
    // The list is read again, the chosen page is marked stale, and the other candidate is left alone.
    expect(world.servers.find(({ id }) => id === "s-b")).toMatchObject({
      enabled: true,
      source: { kind: "plugin", connectionId: "c-work" },
    });
    expect(queryClient.getQueryState(PAGE_KEY("s-b"))?.isInvalidated).toBe(true);
    expect(world.servers.find(({ id }) => id === "s-a")?.source.kind).toBe("url");
    expect(client.mcpServer.create).not.toHaveBeenCalled();
  });

  it("is ignored while the offer or the chosen server has a write, and by a second press in the same tick", async () => {
    const { client, switches, settle } = await setup([docsByUrl("s-a"), docsByUrl("s-b", "/sse")]);

    switches.replace(WORK, "s-a");
    switches.replace(WORK, "s-b");
    switches.apply(WORK, true);
    switches.apply(URL_TARGET("s-a"), true);

    expect(client.mcpServer.update).toHaveBeenCalledTimes(1);
    expect(client.mcpServer.create).not.toHaveBeenCalled();
    await settle(WORK);
  });

  it("blocks the offer's own switch while a plain press on the chosen server's switch runs", async () => {
    const { client, switches, settle } = await setup([docsByUrl("s-a")]);

    switches.apply(URL_TARGET("s-a"), true);
    switches.replace(WORK, "s-a");

    expect(client.mcpServer.update).toHaveBeenCalledTimes(1);
    expect(client.mcpServer.update).toHaveBeenCalledWith({
      params: { id: "s-a" },
      payload: { enabled: true },
    });
    await settle(URL_TARGET("s-a"));
  });

  it("is refused with no write when the chosen server is gone, or no longer sits on the origin", async () => {
    const { client, switches } = await setup([
      buildServer("s-else", "else", "", {
        source: {
          kind: "url",
          url: "https://else.example/mcp",
          signIn: "none",
          signInOffered: null,
        },
      }),
    ]);

    switches.replace(WORK, "s-gone");
    expect(switches.readState(WORK).refusal).toEqual({
      kind: "refused",
      message:
        "Nothing was replaced. The server you chose is gone, or is no longer added by URL on this address. Choose again.",
    });
    switches.replace(WORK, "s-else");

    expect(client.mcpServer.update).not.toHaveBeenCalled();
    expect(switches.readState(WORK).blocked).toBe(false);
  });

  it("is refused, naming the winner, when the offer got a record meanwhile, and keeps the refusal while that record shows", async () => {
    const { client, switches } = await setup([docsByUrl("s-a"), SENTRY_WORK]);

    switches.replace(WORK, "s-a");

    expect(switches.readState(WORK).refusal).toEqual({
      kind: "refused",
      message: "Nothing was replaced. This Connection's server was added meanwhile.",
      existingServerId: "s-work",
    });
    expect(client.mcpServer.update).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", "gone."],
    ["invalid_state", "It is reached with a Connection."],
    ["validation", "Not a URL server."],
  ] as const)(
    "shows a %s from the controller as the refusal, reads the list again and marks the chosen page stale",
    async (code, message) => {
      const { world, queryClient, switches, settle } = await setup([docsByUrl("s-a")]);
      queryClient.setQueryData(PAGE_KEY("s-a"), docsByUrl("s-a"));
      world.updateFails = new ApiError(code, message);

      switches.replace(WORK, "s-a");
      await settle(WORK);

      expect(switches.readState(WORK).refusal).toEqual({
        kind: "refused",
        message: `Nothing was replaced. ${message}`,
      });
      expect(switches.readState(URL_TARGET("s-a")).blocked).toBe(false);
      expect(queryClient.getQueryState(PAGE_KEY("s-a"))?.isInvalidated).toBe(true);
    },
  );

  it("shows the winner of a lost race for the external account, and keeps showing it once its record is in the list", async () => {
    const { world, queryClient, switches, settle } = await setup([docsByUrl("s-a")]);
    world.updateFails = new ApiError("conflict", "A server of this account exists.", {
      reason: "mcp-server-exists",
      mcpServerId: WINNER_ID,
    });

    switches.replace(WORK, "s-a");
    await settle(WORK);
    // Another client's create arrives with the next read of the list.
    queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-a"), { ...SENTRY_WORK, id: WINNER_ID }]);

    expect(switches.readState(WORK).refusal).toEqual({
      kind: "refused",
      message: "Nothing was replaced. A server of this account exists.",
      existingServerId: WINNER_ID,
    });
    // A new confirmation resolves the candidates from the list as it is now.
    switches.replace(WORK, "s-a");
    expect(switches.readState(WORK).refusal).toEqual({
      kind: "refused",
      message: "Nothing was replaced. This Connection's server was added meanwhile.",
      existingServerId: WINNER_ID,
    });
  });
});

describe("where the Replace of an offer stands", () => {
  const winnerRecord = (): McpServer => ({ ...SENTRY_WORK, id: WINNER_ID });

  it("goes from choosing to writing the confirmed server to replaced, once that server shows on the Connection", async () => {
    const { switches, settle } = await setup([docsByUrl("s-a"), docsByUrl("s-b", "/sse")]);
    switches.attachReplaceReader(WORK);
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "choosing" });

    switches.replace(WORK, "s-b");
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "writing", serverId: "s-b" });

    await settle(WORK);
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "replaced", serverId: "s-b" });
  });

  it("stays writing, and not replaced, while the write is held even when the list already shows the record", async () => {
    const { world, queryClient, switches } = await setup([docsByUrl("s-a")]);
    const gate = hold();
    world.holdUpdate = gate.promise;

    switches.replace(WORK, "s-a");
    queryClient.setQueryData(SERVERS_KEY, [
      {
        ...docsByUrl("s-a"),
        source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
      },
    ]);

    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "writing", serverId: "s-a" });
    gate.resolve();
  });

  it("refuses with a link to the winner when another client's server arrives before the user confirms, and never writes", async () => {
    const { client, queryClient, switches } = await setup([docsByUrl("s-a")]);

    queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-a"), winnerRecord()]);

    expect(switches.readReplaceProgress(WORK)).toEqual({
      kind: "refused",
      serverId: null,
      message: "Nothing was replaced. This Connection's server was added meanwhile.",
      winnerServerId: WINNER_ID,
    });
    switches.replace(WORK, "s-a");
    expect(client.mcpServer.update).not.toHaveBeenCalled();
    expect(switches.readReplaceProgress(WORK)).toMatchObject({
      kind: "refused",
      winnerServerId: WINNER_ID,
    });
  });

  it("keeps the confirmed server and shows the winner when another client's server arrives while the write is held, and the write was sent once to the confirmed id", async () => {
    const { world, client, queryClient, switches, settle } = await setup([
      docsByUrl("s-a"),
      docsByUrl("s-b", "/sse"),
    ]);
    const gate = hold();
    world.holdUpdate = gate.promise;
    world.updateFails = new ApiError("conflict", "A server of this account exists.", {
      reason: "mcp-server-exists",
      mcpServerId: WINNER_ID,
    });

    switches.replace(WORK, "s-b");
    queryClient.setQueryData(SERVERS_KEY, [
      docsByUrl("s-a"),
      docsByUrl("s-b", "/sse"),
      winnerRecord(),
    ]);

    expect(switches.readReplaceProgress(WORK)).toEqual({
      kind: "refused",
      serverId: "s-b",
      message: "Nothing was replaced. This Connection's server was added meanwhile.",
      winnerServerId: WINNER_ID,
    });
    expect(switches.readState(WORK).blocked).toBe(true);

    gate.resolve();
    await settle(WORK);
    expect(switches.readReplaceProgress(WORK)).toMatchObject({
      kind: "refused",
      serverId: "s-b",
      winnerServerId: WINNER_ID,
    });
    expect(client.mcpServer.update).toHaveBeenCalledExactlyOnceWith({
      params: { id: "s-b" },
      payload: expect.objectContaining({ enabled: true }) as unknown,
    });
  });

  /** The record of `s-a` after another client moved it onto the Connection. */
  const movedA = (): McpServer => ({
    ...docsByUrl("s-a"),
    enabled: true,
    source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: "c-work" },
  });

  it("stays writing after the acknowledgement while the list read after it is held, and is replaced once that read shows the record", async () => {
    const { world, queryClient, switches, settle } = await setup([docsByUrl("s-a")]);
    switches.attachReplaceReader(WORK);
    const patch = hold();
    const read = hold();
    world.holdUpdate = patch.promise;
    switches.replace(WORK, "s-a");
    // Another client's move of the same server reaches the cache before the acknowledgement.
    queryClient.setQueryData(SERVERS_KEY, [movedA()]);
    world.holdQuery = read.promise;

    patch.resolve();
    await vi.waitFor(() => {
      expect(world.holdQuery).toBeNull();
    });
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "writing", serverId: "s-a" });

    read.resolve();
    await settle(WORK);
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "replaced", serverId: "s-a" });
  });

  it("stays writing while the list read after the acknowledgement fails, and is replaced when a later read succeeds", async () => {
    const { world, client, queryClient, switches, settle } = await setup([docsByUrl("s-a")]);
    switches.attachReplaceReader(WORK);
    const patch = hold();
    world.holdUpdate = patch.promise;
    switches.replace(WORK, "s-a");
    queryClient.setQueryData(SERVERS_KEY, [movedA()]);
    world.readsFail = true;

    patch.resolve();
    await vi.waitFor(() => {
      expect(switches.readState(WORK).unread).not.toBeNull();
    });
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "writing", serverId: "s-a" });

    world.readsFail = false;
    await queryClient.fetchQuery({
      queryKey: SERVERS_KEY,
      queryFn: () => client.mcpServer.query(),
      staleTime: 0,
    });
    await settle(WORK);
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "replaced", serverId: "s-a" });
  });

  it("ends refused, with no winner, when the acknowledged server is gone from the list read after the write, and never goes back to writing", async () => {
    const { world, queryClient, switches, settle } = await setup([docsByUrl("s-a")]);
    switches.attachReplaceReader(WORK);
    const patch = hold();
    const read = hold();
    world.holdUpdate = patch.promise;
    switches.replace(WORK, "s-a");
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
    expect(switches.readReplaceProgress(WORK)).toMatchObject({
      kind: "refused",
      serverId: "s-a",
      winnerServerId: null,
    });
  });

  it("returns the same progress object while nothing changed, and does no Replace work for an unrelated change of the cache", async () => {
    const { queryClient, switches } = await setup([docsByUrl("s-a")]);
    const listener = vi.fn();
    const stop = switches.subscribeReplaceProgress(listener);
    const first = switches.readReplaceProgress(WORK);
    const spy = vi.spyOn(queryClient, "getQueryData");

    queryClient.setQueryData(["unrelated"], { anything: true });
    void queryClient.invalidateQueries({ queryKey: ["unrelated"] });

    expect(listener).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(switches.readReplaceProgress(WORK)).toBe(first);

    queryClient.setQueryData(SERVERS_KEY, [docsByUrl("s-a"), { ...SENTRY_WORK, id: WINNER_ID }]);
    expect(listener).toHaveBeenCalled();
    const refused = switches.readReplaceProgress(WORK);
    expect(refused).toMatchObject({ kind: "refused", winnerServerId: WINNER_ID });
    expect(switches.readReplaceProgress(WORK)).toBe(refused);
    stop();
  });

  it("drops the confirmed server of an abandoned Replace when its refusal expires, so a later dialog starts from choosing", async () => {
    vi.useFakeTimers();
    try {
      const { world, switches, settle } = await setup([docsByUrl("s-a")]);
      const gate = hold();
      world.holdUpdate = gate.promise;
      world.updateFails = new ApiError("not_found", "Gone.");
      const detachDialog = switches.attachReplaceReader(WORK);
      switches.replace(WORK, "s-a");
      // The user leaves Settings while the write is held: nothing shows the target.
      detachDialog();
      expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "writing", serverId: "s-a" });

      gate.resolve();
      await settle(WORK);
      expect(switches.readReplaceProgress(WORK)).toMatchObject({
        kind: "refused",
        serverId: "s-a",
      });
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS);

      expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "choosing" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the confirmed server when the last dialog that reads it unmounts after the attempt settled", async () => {
    const { switches, settle } = await setup([docsByUrl("s-a")]);
    const first = switches.attachReplaceReader(WORK);
    const second = switches.attachReplaceReader(WORK);
    switches.replace(WORK, "s-a");
    await settle(WORK);
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "replaced", serverId: "s-a" });

    first();
    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "replaced", serverId: "s-a" });
    second();

    // The confirmation is gone: the record on the Connection is no one's confirmed server now.
    expect(switches.readReplaceProgress(WORK)).toMatchObject({ kind: "refused", serverId: null });
  });

  it("forgets the confirmed server when the refusal is dismissed, and is always choosing for a target that is not a plugin's", async () => {
    const { world, switches, settle } = await setup([docsByUrl("s-a")]);
    world.updateFails = new ApiError("not_found", "Gone.");
    switches.replace(WORK, "s-a");
    await settle(WORK);
    expect(switches.readReplaceProgress(WORK)).toMatchObject({ kind: "refused", serverId: "s-a" });

    switches.clearRefusal(WORK);

    expect(switches.readReplaceProgress(WORK)).toEqual({ kind: "choosing" });
    expect(switches.readReplaceProgress(URL_TARGET("s-a"))).toEqual({ kind: "choosing" });
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
