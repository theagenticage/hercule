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
  findOrCreateMcpServerSwitches,
  type McpServerSwitchCache,
  type McpServerSwitchTarget,
} from "./server-switch";
import { joinOfferedServers } from "./offers";
import { CONNECTIONS, OFFERING_PLUGINS, SENTRY_WORK, buildServer } from "./testing";

const WORK: McpServerSwitchTarget = {
  kind: "plugin",
  contributionId: "sentry/sentry",
  connectionId: "c-work",
};
const SERVERS_KEY = ["mcp-servers"];
const PAGE_KEY = (id: string) => ["mcp-server", id];

/** A controller that holds a list of servers, with a stub client that creates and updates them. */
const setup = async (initial: readonly McpServer[] = []) => {
  const world = {
    servers: [...initial],
    readsFail: false,
    /** Resolves the create that is running, or `null` while none waits. */
    finishCreate: null as ((error?: Error) => void) | null,
  };
  const client = {
    mcpServer: {
      query: vi.fn(() =>
        world.readsFail
          ? Promise.reject(new Error("offline"))
          : Promise.resolve([...world.servers]),
      ),
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
      update: vi.fn((request: { params: { id: string }; payload: { enabled: boolean } }) => {
        world.servers = world.servers.map((server) =>
          server.id === request.params.id
            ? { ...server, enabled: request.payload.enabled }
            : server,
        );
        return Promise.resolve({ answeredWith: "not a record" });
      }),
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

  it("shares one guard between every consumer of a query client", async () => {
    const { queryClient, client } = await setup();
    const options = {
      queryClient,
      client: client as unknown as HerculeClient,
      cache: {
        readServers: () => [],
        readCatalogue: () =>
          buildMcpListQuery(queryClient, { queryKey: SERVERS_KEY, queryFn: () => [] }),
        readPageKey: PAGE_KEY,
      },
    };

    expect(findOrCreateMcpServerSwitches(options)).toBe(findOrCreateMcpServerSwitches(options));
  });
});
