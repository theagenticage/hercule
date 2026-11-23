import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";
import type { HerculeClient } from "../client";
import { ApiError } from "../errors";
import { buildProject } from "../threads/workspaces.testing";
import {
  buildMcpListQuery,
  createMcpListEdits,
  decideMcpListChoice,
  describeMcpListProblem,
  findOrCreateMcpListEdits,
  type McpListCache,
  type McpListChoice,
  type McpListTarget,
} from "./list-edits";
import { DETACHED_REFUSAL_LIFETIME_MS } from "./edit-guard";
import { describeThreadStartFoot } from "./start-list";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK, buildViews } from "./testing";

const VIEWS = buildViews([SENTRY_WORK, SENTRY_HOBBY, LINEAR]);
const SERVERS = VIEWS.map((view) => view.server);
const THREAD: McpListTarget = { kind: "thread", sessionId: "se-1", projectId: "p-shop" };
const PROJECT: McpListTarget = { kind: "project", projectId: "p-shop" };
const DEFAULT: McpListTarget = { kind: "default" };

const SESSION_KEY: QueryKey = ["session", "se-1"];
const PROJECTS_KEY: QueryKey = ["projects"];
const PROJECT_KEY: QueryKey = ["project", "p-shop"];
const SETTINGS_KEY: QueryKey = ["settings"];
const SERVERS_KEY: QueryKey = ["mcp-servers"];

/** Sets a server's account on a name: the `name` choice a control sends. */
const choose = (name: string, serverId: string | null, shownServerId: string): McpListChoice => ({
  kind: "name",
  name,
  serverId,
  shownServerId,
});

/** The ids the controller's three lists hold when a test starts. */
interface Lists {
  readonly threadIds?: string[];
  readonly projectIds?: string[];
  readonly defaultIds?: string[];
}

/**
 * A controller that holds three lists, and a stub client that reads and
 * writes them. `readsFail` makes every read of a list fail, as a controller
 * that went away after the write would.
 */
const buildWorld = (lists: Lists) => {
  const world = {
    threadIds: lists.threadIds ?? ["s-linear"],
    projectIds: lists.projectIds ?? ["s-linear"],
    defaultIds: lists.defaultIds ?? ["s-linear"],
    readsFail: false,
    refuseWith: null as Error | null,
    /** What a write answers with, which is not what a read says: a write's response must never reach the cache. */
    answer: { answeredWith: "not a record" },
    catalogueReads: 0,
    projectsReads: 0,
  };
  const saved = (list: "threadIds" | "projectIds" | "defaultIds") =>
    vi.fn((request: { payload: { mcpServerIds?: string[]; user?: Record<string, string[]> } }) => {
      if (world.refuseWith !== null) return Promise.reject(world.refuseWith);
      world[list] = request.payload.mcpServerIds ?? request.payload.user!["thread.mcpServerIds"]!;
      return Promise.resolve(world.answer);
    });
  const read = <Value>(value: () => Value) =>
    vi.fn(() =>
      world.readsFail ? Promise.reject(new Error("offline")) : Promise.resolve(value()),
    );
  const client = {
    session: {
      update: saved("threadIds"),
      read: read(() => ({
        id: "se-1",
        mcpServers: world.threadIds.map((id) => ({ mcpServerId: id })),
      })),
    },
    project: {
      update: saved("projectIds"),
      query: read(() => {
        world.projectsReads += 1;
        return [{ ...buildProject("p-shop", "webshop"), mcpServerIds: world.projectIds }];
      }),
      read: read(() => ({ ...buildProject("p-shop", "webshop"), mcpServerIds: world.projectIds })),
    },
    settings: {
      update: saved("defaultIds"),
      read: read(() => ({ user: { "thread.mcpServerIds": world.defaultIds } })),
    },
    mcpServer: {
      query: vi.fn(() => {
        world.catalogueReads += 1;
        return Promise.resolve(VIEWS.map((view) => view.server));
      }),
    },
  };
  return { world, client };
};

/** Builds the edits over a real query client, with the cache an app would hold: the three lists read once. */
const setup = async (lists: Lists = {}, cacheOverrides: Partial<McpListCache> = {}) => {
  const { world, client } = buildWorld(lists);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const reads = {
    thread: buildMcpListQuery(queryClient, {
      queryKey: SESSION_KEY,
      queryFn: () => client.session.read(),
    }),
    project: buildMcpListQuery(queryClient, {
      queryKey: PROJECTS_KEY,
      queryFn: () => client.project.query(),
    }),
    default: buildMcpListQuery(queryClient, {
      queryKey: SETTINGS_KEY,
      queryFn: () => client.settings.read(),
    }),
  };
  await Promise.all(Object.values(reads).map((read) => read.fetch()));
  const cache: McpListCache = {
    readList: (target) => {
      switch (target.kind) {
        case "thread":
          return queryClient
            .getQueryData<{ mcpServers: { mcpServerId: string }[] }>(SESSION_KEY)
            ?.mcpServers.map((server) => server.mcpServerId);
        case "project":
          return queryClient
            .getQueryData<{ id: string; mcpServerIds: string[] }[]>(PROJECTS_KEY)
            ?.find((project) => project.id === target.projectId)?.mcpServerIds;
        case "default":
          return queryClient.getQueryData<{ user: Record<string, string[]> }>(SETTINGS_KEY)?.user[
            "thread.mcpServerIds"
          ];
      }
    },
    readBase: (target) => reads[target.kind],
    readOtherKeys: (target) => (target.kind === "project" ? [PROJECT_KEY] : []),
    readServers: () => VIEWS.map((view) => view.server),
    readViews: () => VIEWS,
    readCatalogue: () =>
      buildMcpListQuery(queryClient, {
        queryKey: SERVERS_KEY,
        queryFn: () => client.mcpServer.query(),
      }),
    readStartRecords: () => ({
      project: {
        kind: "read",
        value: { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-work"] },
      },
      defaultIds: { kind: "read", value: [] },
    }),
    ...cacheOverrides,
  };
  const edits = createMcpListEdits({
    queryClient,
    client: client as unknown as HerculeClient,
    cache,
  });
  const settle = (target: McpListTarget) =>
    vi.waitFor(() => {
      expect(edits.readState(target).blocked).toBe(false);
    });
  return { world, client, queryClient, cache, edits, settle };
};

describe("one edit at a time for a list", () => {
  it("ignores a second edit of the same list while the first one runs, and takes the next once the list is read again", async () => {
    const { client, edits, settle } = await setup();

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    edits.apply(THREAD, choose("sentry", "s-hobby", "s-work"));

    expect(edits.readState(THREAD).blocked).toBe(true);
    await settle(THREAD);
    expect(client.session.update).toHaveBeenCalledTimes(1);
    expect(client.session.update).toHaveBeenCalledWith({
      params: { id: "se-1" },
      payload: { mcpServerIds: ["s-linear", "s-work"] },
    });
    // The next edit is built from the list the first one saved.
    edits.apply(THREAD, choose("sentry", "s-hobby", "s-work"));
    await settle(THREAD);
    expect(client.session.update).toHaveBeenLastCalledWith({
      params: { id: "se-1" },
      payload: { mcpServerIds: ["s-linear", "s-hobby"] },
    });
  });

  it("lets lists of other targets edit at the same time", async () => {
    const { client, edits, settle } = await setup();

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    edits.apply(DEFAULT, choose("sentry", "s-work", "s-work"));

    expect(client.session.update).toHaveBeenCalledTimes(1);
    expect(client.settings.update).toHaveBeenCalledTimes(1);
    await settle(THREAD);
    await settle(DEFAULT);
  });

  it("keeps the guard for every consumer: two lookups for one query client are one instance, and a second control in the same tick sees the first one's edit", async () => {
    const { client, queryClient, cache } = await setup();
    const options = { queryClient, client: client as never, cache };
    const first = findOrCreateMcpListEdits(options);
    const second = findOrCreateMcpListEdits(options);

    expect(second).toBe(first);
    // Two controls of one list press in the same tick, one on each handle.
    first.apply(THREAD, choose("sentry", "s-work", "s-work"));
    second.apply(THREAD, choose("sentry", "s-hobby", "s-work"));
    expect(client.session.update).toHaveBeenCalledTimes(1);
    expect(second.readState(THREAD).blocked).toBe(true);
    await vi.waitFor(() => {
      expect(first.readState(THREAD).blocked).toBe(false);
    });
  });

  it("returns the same state object until the target changes", async () => {
    const { edits, settle } = await setup();
    const idle = edits.readState(THREAD);

    expect(edits.readState(THREAD)).toBe(idle);
    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    const running = edits.readState(THREAD);
    expect(running).not.toBe(idle);
    expect(edits.readState(THREAD)).toBe(running);
    expect(edits.readState(DEFAULT)).toBe(idle);
    await settle(THREAD);
  });

  it("tells a subscriber when a target changes, and stops after it unsubscribes", async () => {
    const { edits, settle } = await setup();
    const listener = vi.fn();
    const stop = edits.subscribe(listener);

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await settle(THREAD);
    expect(listener).toHaveBeenCalled();
    stop();
    listener.mockClear();
    edits.apply(THREAD, choose("sentry", "s-hobby", "s-work"));
    await settle(THREAD);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("what a write puts in the cache", () => {
  it("puts no response of the write in the cache: only the read that follows it fills it", async () => {
    const { world, queryClient, edits, settle } = await setup();
    const setQueryData = vi.spyOn(queryClient, "setQueryData");

    edits.apply(DEFAULT, choose("sentry", "s-work", "s-work"));
    await settle(DEFAULT);

    expect(setQueryData).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(SETTINGS_KEY)).toEqual({
      user: { "thread.mcpServerIds": world.defaultIds },
    });
  });

  it("reads the list again even when nobody observes it, so the next edit starts from the saved list", async () => {
    const { client, edits, settle } = await setup();

    edits.apply(PROJECT, { kind: "box", serverId: "s-work", action: "tick" });
    await settle(PROJECT);

    expect(client.project.query).toHaveBeenCalledTimes(2);
  });

  it("drops a read that started before the write ended, so the cache never keeps the old list", async () => {
    const { world, client, queryClient, edits, settle } = await setup();
    // A read that began before the write answers with the old list, late: when the test says.
    let answerOldList: () => void = () => undefined;
    client.settings.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerOldList = () => {
            resolve({ user: { "thread.mcpServerIds": ["s-linear"] } });
          };
        }),
    );
    const oldRead = queryClient.fetchQuery({
      queryKey: SETTINGS_KEY,
      queryFn: () => client.settings.read(),
      staleTime: 0,
    });

    edits.apply(DEFAULT, choose("sentry", "s-work", "s-work"));
    await settle(DEFAULT);
    answerOldList();
    // The write cancelled the old read, so it may settle either way. A cache write by the old
    // read happens before its promise settles, so nothing is left to wait for after this.
    await Promise.allSettled([oldRead]);

    expect(queryClient.getQueryData(SETTINGS_KEY)).toEqual({
      user: { "thread.mcpServerIds": world.defaultIds },
    });
  });
});

describe("a list that could not be read again", () => {
  it("keeps the target blocked and says the change was saved, until a read of the list succeeds", async () => {
    const { world, client, queryClient, edits, settle } = await setup();
    world.readsFail = true;

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await vi.waitFor(() => {
      expect(edits.readState(THREAD).unread).toEqual({ saved: true });
    });

    expect(edits.readState(THREAD).blocked).toBe(true);
    expect(describeMcpListProblem(edits.readState(THREAD))).toBe(
      "Saved, but the list could not be read again.",
    );
    // A blocked target takes no edit, so none is built from the list the cache still holds.
    edits.apply(THREAD, choose("sentry", "s-hobby", "s-work"));
    expect(client.session.update).toHaveBeenCalledTimes(1);

    // Dismissing never releases it.
    edits.clearRefusal(THREAD);
    expect(edits.readState(THREAD).blocked).toBe(true);

    // A normal read, which nobody asked the module to make, releases it.
    world.readsFail = false;
    await queryClient.fetchQuery({
      queryKey: SESSION_KEY,
      queryFn: () => client.session.read(),
      staleTime: 0,
    });
    await settle(THREAD);
    expect(edits.readState(THREAD).unread).toBeNull();
  });

  it("does not say saved when the write was refused and the list could not be read again", async () => {
    const { world, edits } = await setup();
    world.readsFail = true;
    world.refuseWith = new ApiError("forbidden", "No grant mcp.manage");

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await vi.waitFor(() => {
      expect(edits.readState(THREAD).unread).toEqual({ saved: false });
    });

    expect(describeMcpListProblem(edits.readState(THREAD), "Could not save: ")).toBe(
      "Could not save: No grant mcp.manage The list could not be read again.",
    );
  });

  it("is not released by a read that failed", async () => {
    const { world, client, queryClient, edits } = await setup();
    world.readsFail = true;
    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await vi.waitFor(() => {
      expect(edits.readState(THREAD).unread).not.toBeNull();
    });

    await queryClient
      .fetchQuery({ queryKey: SESSION_KEY, queryFn: () => client.session.read(), staleTime: 0 })
      .catch(() => {});

    expect(edits.readState(THREAD).blocked).toBe(true);
  });
});

describe("what releases a list that could not be read again", () => {
  it("is not released by a patch of the cache by hand, only by a fetch of the list", async () => {
    const { world, client, queryClient, edits, settle } = await setup();
    world.readsFail = true;
    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await vi.waitFor(() => {
      expect(edits.readState(THREAD).unread).toEqual({ saved: true });
    });

    // Something else patches the cached Session, and leaves its list as it was before the write.
    queryClient.setQueryData(SESSION_KEY, {
      id: "se-1",
      mcpServers: [{ mcpServerId: "s-linear" }],
      title: "patched",
    });
    edits.apply(THREAD, choose("sentry", "s-hobby", "s-work"));

    expect(edits.readState(THREAD).blocked).toBe(true);
    expect(client.session.update).toHaveBeenCalledTimes(1);
    world.readsFail = false;
    await queryClient.fetchQuery({
      queryKey: SESSION_KEY,
      queryFn: () => client.session.read(),
      staleTime: 0,
    });
    await settle(THREAD);
  });

  it("is released by a read that succeeded while the servers were still being read, even though the list's own read failed", async () => {
    const { world, client, queryClient, edits, settle } = await setup();
    let releaseServers!: () => void;
    client.mcpServer.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseServers = () => {
            resolve(VIEWS.map((view) => view.server));
          };
        }),
    );
    world.readsFail = true;
    world.refuseWith = new ApiError("validation", "The list names a server that no longer exists.");
    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    // The list's own read fails, and the servers' read is held.
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(SESSION_KEY)?.status).toBe("error");
    });
    world.readsFail = false;
    await queryClient.fetchQuery({
      queryKey: SESSION_KEY,
      queryFn: () => client.session.read(),
      staleTime: 0,
    });

    // The target is released, and the refusal is shown, while the servers' read is still held.
    await vi.waitFor(() => {
      expect(edits.readState(THREAD)).toMatchObject({
        blocked: false,
        unread: null,
        refusal: { kind: "refused", message: "The list names a server that no longer exists." },
      });
    });

    releaseServers();
    await settle(THREAD);

    expect(edits.readState(THREAD)).toMatchObject({ blocked: false, unread: null });
  });

  it("shows a refusal as soon as the list was read again, without waiting for the servers' read", async () => {
    const { world, client, queryClient, edits, settle } = await setup();
    let releaseServers!: () => void;
    client.mcpServer.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseServers = () => {
            resolve(VIEWS.map((view) => view.server));
          };
        }),
    );
    world.refuseWith = new ApiError("validation", "The list names a server that no longer exists.");
    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));

    await vi.waitFor(() => {
      expect(edits.readState(THREAD)).toMatchObject({
        blocked: false,
        refusal: { kind: "refused" },
      });
    });
    expect(queryClient.isFetching({ queryKey: SERVERS_KEY })).toBe(1);

    releaseServers();
    await settle(THREAD);
  });

  it("marks another read of the list stale without reading it", async () => {
    const { client, queryClient, edits, settle } = await setup({ projectIds: ["s-linear"] });
    const observer = new QueryObserver(queryClient, {
      queryKey: PROJECT_KEY,
      queryFn: () => client.project.read(),
    });
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(PROJECT_KEY)?.status).toBe("success");
    });
    const readsBefore = client.project.read.mock.calls.length;

    edits.apply(PROJECT, { kind: "box", serverId: "s-work", action: "tick" });
    await settle(PROJECT);

    expect(queryClient.getQueryState(PROJECT_KEY)?.isInvalidated).toBe(true);
    expect(client.project.read.mock.calls.length).toBe(readsBefore);
    stop();
  });
});

describe("how long a refusal stays", () => {
  const refuse = async () => {
    const world = await setup();
    world.world.refuseWith = new ApiError("forbidden", "No grant mcp.manage");
    return world;
  };

  it("keeps a refusal as long as a control shows the target", async () => {
    vi.useFakeTimers();
    try {
      const { edits, settle } = await refuse();
      const detach = edits.attach(THREAD);

      edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
      await settle(THREAD);
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS * 2);

      expect(edits.readState(THREAD).refusal).not.toBeNull();
      detach();
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS);
      expect(edits.readState(THREAD).refusal).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a refusal that came after the last control left, once its lifetime is over", async () => {
    vi.useFakeTimers();
    try {
      const { edits, settle } = await refuse();
      const detach = edits.attach(THREAD);

      edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
      detach();
      await settle(THREAD);

      expect(edits.readState(THREAD).refusal).toMatchObject({ kind: "refused" });
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS / 2);
      expect(edits.readState(THREAD).refusal).not.toBeNull();
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS / 2);
      expect(edits.readState(THREAD).refusal).toBeNull();
      expect(edits.readState(THREAD)).toEqual({ blocked: false, refusal: null, unread: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a refusal that a control attached to before its lifetime ended, and keeps what is unread", async () => {
    vi.useFakeTimers();
    try {
      const { world, edits, queryClient, client } = await refuse();
      world.readsFail = true;

      edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
      await vi.waitFor(() => {
        expect(edits.readState(THREAD).unread).toEqual({ saved: false });
      });
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS / 2);
      const detach = edits.attach(THREAD);
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS * 2);
      expect(edits.readState(THREAD).refusal).not.toBeNull();

      detach();
      vi.advanceTimersByTime(DETACHED_REFUSAL_LIFETIME_MS);

      // The refusal is gone, the obligation to read the list again is not.
      expect(edits.readState(THREAD)).toMatchObject({
        blocked: true,
        refusal: null,
        unread: { saved: false },
      });
      world.readsFail = false;
      await queryClient.fetchQuery({
        queryKey: SESSION_KEY,
        queryFn: () => client.session.read(),
        staleTime: 0,
      });
      expect(edits.readState(THREAD).blocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a refused write", () => {
  it("keeps the controller's reason until it is dismissed or a new edit is made", async () => {
    const { world, client, edits, settle } = await setup();
    world.refuseWith = new ApiError("forbidden", "No grant mcp.manage");

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await settle(THREAD);

    const refused = edits.readState(THREAD);
    expect(refused.refusal).toEqual({ kind: "refused", message: "No grant mcp.manage" });
    expect(edits.readState(THREAD)).toBe(refused);

    edits.clearRefusal(THREAD);
    expect(edits.readState(THREAD).refusal).toBeNull();

    world.refuseWith = null;
    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    expect(edits.readState(THREAD).refusal).toBeNull();
    await settle(THREAD);
    expect(client.session.update).toHaveBeenCalledTimes(2);
  });

  it("reads the servers again when the controller refuses the list as invalid, whether or not a panel is open", async () => {
    const {
      world,
      world: { catalogueReads: before },
      edits,
      settle,
    } = await setup();
    world.refuseWith = new ApiError("validation", "The list names a server that no longer exists.");

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await settle(THREAD);

    expect(world.catalogueReads).toBe(before + 1);
  });

  it("reads the servers after the refusal, not in a read that began before it", async () => {
    const { world, client, queryClient, edits, settle } = await setup();
    let releaseOld!: () => void;
    // A read of the servers began before the write was refused. It still holds a server that is deleted now.
    client.mcpServer.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = () => {
            resolve([...VIEWS.map((view) => view.server), { ...LINEAR, id: "s-deleted" }]);
          };
        }),
    );
    const old = queryClient
      .fetchQuery({
        queryKey: SERVERS_KEY,
        queryFn: () => client.mcpServer.query(),
        staleTime: 0,
      })
      .catch(() => {});
    world.refuseWith = new ApiError("validation", "The list names a server that no longer exists.");

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await settle(THREAD);
    releaseOld();
    await old;

    expect(queryClient.getQueryData(SERVERS_KEY)).toEqual(VIEWS.map((view) => view.server));
    expect(edits.readState(THREAD).refusal).toMatchObject({ kind: "refused" });
  });

  it("leaves the servers alone when the refusal is another one", async () => {
    const { world, edits, settle } = await setup();
    world.refuseWith = new ApiError("forbidden", "No grant mcp.manage");

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await settle(THREAD);

    expect(world.catalogueReads).toBe(0);
  });
});

describe("a choice of a name", () => {
  it("is refused as taken, naming the occupant, when the list names another account than the one the control showed", async () => {
    const { client, edits } = await setup({ threadIds: ["s-linear", "s-hobby"] });

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));

    expect(client.session.update).not.toHaveBeenCalled();
    expect(edits.readState(THREAD).refusal).toMatchObject({
      kind: "taken",
      occupant: { server: { id: "s-hobby" } },
      serverId: "s-work",
    });
    expect(edits.readState(THREAD).blocked).toBe(false);
  });

  it("is refused as taken for an off of an account the list no longer names", async () => {
    const { client, edits } = await setup({ threadIds: ["s-linear", "s-hobby"] });

    edits.apply(THREAD, choose("sentry", null, "s-work"));

    expect(client.session.update).not.toHaveBeenCalled();
    expect(edits.readState(THREAD).refusal).toMatchObject({ kind: "taken", serverId: "s-work" });
  });

  it("swaps the account the control showed, in the same place", async () => {
    const { client, edits, settle } = await setup({ threadIds: ["s-work", "s-linear"] });

    edits.apply(THREAD, choose("sentry", "s-hobby", "s-work"));
    await settle(THREAD);

    expect(client.session.update).toHaveBeenCalledWith({
      params: { id: "se-1" },
      payload: { mcpServerIds: ["s-hobby", "s-linear"] },
    });
  });

  it("decides from the catalogue's records alone, so it needs no Connections or plugins", async () => {
    const { client, edits, settle } = await setup({}, { readViews: () => undefined });

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await settle(THREAD);

    expect(client.session.update).toHaveBeenCalledWith({
      params: { id: "se-1" },
      payload: { mcpServerIds: ["s-linear", "s-work"] },
    });
  });

  it("names the occupant by its record when the joined views are not read", async () => {
    const { edits } = await setup({ threadIds: ["s-hobby"] }, { readViews: () => undefined });

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));

    expect(edits.readState(THREAD).refusal).toMatchObject({
      kind: "taken",
      occupant: { server: { id: "s-hobby" } },
    });
    expect(describeMcpListProblem(edits.readState(THREAD))).toBe(
      "The list already names sentry, so nothing was changed.",
    );
  });

  it("skips an account that is gone before it looks at who holds the name, so it is not refused as taken", async () => {
    const { client, edits } = await setup({ threadIds: ["s-linear", "s-hobby"] });

    // The user asked for s-gone, and the list names s-hobby now: nothing to refuse, the account no longer exists.
    edits.apply(THREAD, choose("sentry", "s-gone", "s-work"));

    expect(client.session.update).not.toHaveBeenCalled();
    expect(edits.readState(THREAD)).toEqual({ blocked: false, refusal: null, unread: null });
  });

  it("keeps the ids the catalogue does not know", async () => {
    const { client, edits, settle } = await setup({ threadIds: ["s-new", "s-linear"] });

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));
    await settle(THREAD);

    expect(client.session.update).toHaveBeenCalledWith({
      params: { id: "se-1" },
      payload: { mcpServerIds: ["s-new", "s-linear", "s-work"] },
    });
  });

  it("writes nothing for an off whose account is gone, an account the catalogue does not know, or a list that would not change", async () => {
    const { client, edits } = await setup();

    edits.apply(THREAD, choose("sentry", null, "s-gone"));
    edits.apply(THREAD, choose("sentry", "s-gone", "s-work"));
    edits.apply(THREAD, choose("sentry", null, "s-work"));
    edits.apply(THREAD, choose("linear", "s-linear", "s-linear"));

    expect(client.session.update).not.toHaveBeenCalled();
    expect(edits.readState(THREAD)).toEqual({ blocked: false, refusal: null, unread: null });
  });
});

describe("a press on a box", () => {
  it("refuses a swap the user confirmed for another account than the list names now, and names that one", async () => {
    const { client, edits } = await setup({ projectIds: ["s-hobby"] });

    // The user confirmed a swap for an account the list no longer names: it names s-hobby now.
    edits.apply(PROJECT, { kind: "box", serverId: "s-work", action: { swapFrom: "s-other" } });

    expect(client.project.update).not.toHaveBeenCalled();
    expect(edits.readState(PROJECT).refusal).toMatchObject({
      kind: "taken",
      occupant: { server: { id: "s-hobby" } },
      serverId: "s-work",
    });
  });

  it("marks the list stale when it refuses, because the cache may be older than the controller's list", async () => {
    const { queryClient, edits } = await setup({ projectIds: ["s-hobby"] });

    edits.apply(PROJECT, { kind: "box", serverId: "s-work", action: "tick" });

    expect(queryClient.getQueryState(PROJECTS_KEY)?.isInvalidated).toBe(true);
  });

  it("refuses a tick when the list names another account, and swaps when the user confirmed that account", async () => {
    const { client, edits, settle } = await setup({ projectIds: ["s-hobby"] });

    edits.apply(PROJECT, { kind: "box", serverId: "s-work", action: "tick" });
    expect(edits.readState(PROJECT).refusal?.kind).toBe("taken");

    edits.apply(PROJECT, { kind: "box", serverId: "s-work", action: { swapFrom: "s-hobby" } });
    await settle(PROJECT);

    expect(client.project.update).toHaveBeenCalledWith({
      params: { id: "p-shop" },
      payload: { mcpServerIds: ["s-work"] },
    });
    expect(edits.readState(PROJECT).refusal).toBeNull();
  });

  it("unticks only the server of the page, and marks the project's other read stale", async () => {
    const { client, queryClient, edits, settle } = await setup({
      projectIds: ["s-work", "s-linear"],
    });
    await queryClient.fetchQuery({
      queryKey: PROJECT_KEY,
      queryFn: () => client.project.read(),
    });

    edits.apply(PROJECT, { kind: "box", serverId: "s-work", action: "untick" });
    await settle(PROJECT);

    expect(client.project.update).toHaveBeenCalledWith({
      params: { id: "p-shop" },
      payload: { mcpServerIds: ["s-linear"] },
    });
    expect(queryClient.getQueryState(PROJECT_KEY)?.isInvalidated).toBe(true);
  });

  it("is refused with the reason when the project is gone, and writes nothing", async () => {
    const { client, edits } = await setup({}, { readList: () => undefined });

    edits.apply(PROJECT, { kind: "box", serverId: "s-work", action: "tick" });

    expect(client.project.update).not.toHaveBeenCalled();
    expect(edits.readState(PROJECT).refusal).toEqual({
      kind: "refused",
      message: "This project no longer exists, so its list was not changed.",
    });
  });
});

describe("the servers and the list not being read yet", () => {
  it("refuses a press on a box of a server the list of servers does not hold yet, and says so", async () => {
    const { client, edits } = await setup();

    edits.apply(PROJECT, { kind: "box", serverId: "s-just-made", action: "tick" });

    expect(client.project.update).not.toHaveBeenCalled();
    expect(edits.readState(PROJECT).refusal).toMatchObject({ kind: "refused" });
  });

  it("refuses an edit while the servers are not read, with a problem a control can show", async () => {
    const { client, edits } = await setup({}, { readServers: () => undefined });

    edits.apply(THREAD, choose("sentry", "s-work", "s-work"));

    expect(client.session.update).not.toHaveBeenCalled();
    expect(describeMcpListProblem(edits.readState(THREAD))).toBe(
      "The servers are not read yet, so the list was not changed. Try again.",
    );
  });
});

describe("going back to the start list", () => {
  it("writes the project's list, as the records hold it when the user presses", async () => {
    const { client, edits, settle } = await setup({ threadIds: ["s-linear", "s-work"] });

    edits.apply(THREAD, { kind: "reset" });
    await settle(THREAD);

    expect(client.session.update).toHaveBeenCalledWith({
      params: { id: "se-1" },
      payload: { mcpServerIds: ["s-work"] },
    });
  });

  it("writes exactly when the foot of the menu offers the way back", async () => {
    const start = {
      mcpServerIds: ["s-work"],
      source: { kind: "project", projectName: "webshop" },
      complete: true,
    } as const;
    for (const [threadIds, offered] of [
      [["s-work"], false],
      [["s-linear"], true],
    ] as const) {
      const { client, edits } = await setup({ threadIds: [...threadIds] });

      edits.apply(THREAD, { kind: "reset" });

      expect(describeThreadStartFoot({ kind: "start", start }, threadIds).reset !== null).toBe(
        offered,
      );
      expect(client.session.update.mock.calls.length > 0).toBe(offered);
    }
  });

  it("does nothing while the start list holds a server the catalogue does not know, and says so", async () => {
    const { client, edits } = await setup(
      {},
      {
        readStartRecords: () => ({
          project: {
            kind: "read",
            value: { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-work", "s-new"] },
          },
          defaultIds: { kind: "read", value: [] },
        }),
      },
    );

    edits.apply(THREAD, { kind: "reset" });

    expect(client.session.update).not.toHaveBeenCalled();
    expect(describeMcpListProblem(edits.readState(THREAD), "")).toBe(
      "The servers are not fully read yet, so the list cannot be reset. Try again.",
    );
  });

  it.each([
    [{ kind: "pending" } as const, "The list this thread started from is not read yet. Try again."],
    [
      { kind: "failed", message: "offline" } as const,
      "Where this list started could not be read (offline).",
    ],
    [
      { kind: "missing" } as const,
      "This thread's project no longer exists, so there is no list to go back to.",
    ],
  ])("writes nothing and says why while the project record is %j", async (project, message) => {
    const { client, edits } = await setup(
      {},
      {
        readStartRecords: () => ({ project, defaultIds: { kind: "read", value: [] } }),
      },
    );

    edits.apply(THREAD, { kind: "reset" });

    expect(client.session.update).not.toHaveBeenCalled();
    expect(edits.readState(THREAD).refusal).toEqual({ kind: "refused", message });
  });

  it("does nothing for the list of a project or the default list, which have no start list", async () => {
    const { client, edits } = await setup();

    edits.apply(PROJECT, { kind: "reset" });
    edits.apply(DEFAULT, { kind: "reset" });

    expect(client.project.update).not.toHaveBeenCalled();
    expect(client.settings.update).not.toHaveBeenCalled();
  });
});

describe("decideMcpListChoice", () => {
  it("decides on a list for a Draft Thread the same way, with no write", () => {
    expect(
      decideMcpListChoice({
        ids: ["s-linear"],
        servers: SERVERS,
        choice: choose("sentry", "s-work", "s-work"),
      }),
    ).toEqual({ kind: "write", mcpServerIds: ["s-linear", "s-work"] });
  });

  it("goes back to a complete start list, and not to one that is incomplete or unknown", () => {
    const start = {
      mcpServerIds: ["s-work"],
      source: { kind: "default" },
      complete: true,
    } as const;

    expect(
      decideMcpListChoice({ ids: [], servers: SERVERS, choice: { kind: "reset" }, start }),
    ).toEqual({
      kind: "write",
      mcpServerIds: ["s-work"],
    });
    expect(
      decideMcpListChoice({
        ids: [],
        servers: SERVERS,
        choice: { kind: "reset" },
        start: { ...start, complete: false },
      }),
    ).toEqual({ kind: "unchanged" });
    expect(decideMcpListChoice({ ids: [], servers: SERVERS, choice: { kind: "reset" } })).toEqual({
      kind: "unchanged",
    });
  });
});
