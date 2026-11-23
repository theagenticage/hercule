import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { ApiError } from "../errors";
import { buildMcpListQuery } from "./list-edits";
import {
  createMcpUrlServerFlows,
  decideFollowing,
  describeClosing,
  describeFailedCheck,
  describeOpenServerAction,
  findOrCreateMcpUrlServerFlows,
  type McpUrlServerFlows,
  type ServerOutcome,
  type UrlServerFlowState,
} from "./url-server-flows";
import { SENTRY_WORK, buildServer } from "./testing";

// Conflict details are decoded, so their ids must be real ones.
const OTHER_ID = "01a1fbc5-06ef-74bd-8d5f-998d787ac50e";
const CONNECTION_ID = "01a1fbc5-06ef-74bd-8d5f-998d787ac50f";
const ADDRESS = "https://mcp.docs.example/mcp";

const SERVERS_KEY = ["mcp-servers"];
const DETAIL_KEY = (id: string) => ["mcp-server", id];

/** Returns a server added by URL, named `docs`, in `status`. */
const urlServer = (id: string, overrides: Partial<McpServer> = {}): McpServer =>
  buildServer(id, "docs", "", {
    source: { kind: "url", url: ADDRESS, signIn: "none", signInOffered: null },
    status: "checking",
    tools: [],
    checkedAt: null,
    ...overrides,
  });

/** A promise the test settles by hand. */
const hold = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/**
 * A controller that holds records, with a stub client whose create and token
 * write wait for the test, and whose reads answer from the records at the time
 * they run.
 */
const setup = async () => {
  const world = {
    records: new Map<string, McpServer>(),
    /** The reads of one server, in the order they started. */
    reads: [] as string[],
    /** Makes the next reads fail with this error, or `null`. */
    readFails: null as Error | null,
    /** Holds the next read until it is released, or `null`. The read answers with the record as it was when it started. */
    holdNextRead: null as Promise<void> | null,
    /** One entry for each create the client was asked for, to settle by hand. */
    creates: [] as ReturnType<typeof hold<McpServer>>[],
    tokenWrites: [] as ReturnType<typeof hold<McpServer>>[],
  };
  const client = {
    mcpServer: {
      query: vi.fn(() => Promise.resolve([...world.records.values()])),
      read: vi.fn(async ({ params }: { params: { id: string } }) => {
        world.reads.push(params.id);
        const record = world.records.get(params.id);
        const gate = world.holdNextRead;
        world.holdNextRead = null;
        if (gate !== null) await gate;
        if (world.readFails !== null) throw world.readFails;
        if (record === undefined) throw new ApiError("not_found", "No such server.");
        return { ...record };
      }),
      create: vi.fn(() => {
        const held = hold<McpServer>();
        world.creates.push(held);
        return held.promise;
      }),
      setToken: vi.fn(() => {
        const held = hold<McpServer>();
        world.tokenWrites.push(held);
        return held.promise;
      }),
      check: vi.fn(() => Promise.resolve()),
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const catalogue = buildMcpListQuery(queryClient, {
    queryKey: SERVERS_KEY,
    queryFn: () => client.mcpServer.query(),
  });
  await catalogue.fetch();
  client.mcpServer.query.mockClear();
  const flows = createMcpUrlServerFlows({
    queryClient,
    client: client as unknown as HerculeClient,
    cache: {
      readServers: () => queryClient.getQueryData<McpServer[]>(SERVERS_KEY),
      readCatalogue: () => catalogue,
      readServerQuery: (id) => ({
        queryKey: DETAIL_KEY(id),
        queryFn: () => client.mcpServer.read({ params: { id } }),
      }),
    },
  });
  /** Changes a record the way the controller does, then pushes on the live topic: the active reads of that server start again. */
  const push = (id: string, change: Partial<McpServer> | null) => {
    if (change === null) world.records.delete(id);
    else world.records.set(id, { ...world.records.get(id)!, ...change });
    void queryClient.invalidateQueries({ queryKey: DETAIL_KEY(id) });
  };
  const stateOf = (attempt: string) => flows.readState(attempt);
  /** Waits for the attempt to be in a state of `kind`, and returns it. */
  const waitFor = async <K extends UrlServerFlowState["kind"]>(attempt: string, kind: K) => {
    await vi.waitFor(() => {
      expect(flows.readState(attempt).kind).toBe(kind);
    });
    return flows.readState(attempt) as Extract<UrlServerFlowState, { kind: K }>;
  };
  /** Waits for a following attempt to show an outcome of `kind`. */
  const waitForOutcome = async (attempt: string, kind: string) => {
    await vi.waitFor(() => {
      const state = flows.readState(attempt);
      expect(state.kind === "following" && state.outcome.kind).toBe(kind);
    });
    return flows.readState(attempt) as Extract<UrlServerFlowState, { kind: "following" }>;
  };
  /** Reads the list of servers from the controller, as a live push of the list does. */
  const readList = () => catalogue.fetch();
  return {
    world,
    client,
    queryClient,
    flows,
    readList,
    push,
    stateOf,
    waitFor,
    waitForOutcome,
  };
};

describe("Add by URL: sending", () => {
  it("sends the trimmed address with no name while the name is untouched, and the typed name when there is one", async () => {
    const { flows, client } = await setup();
    const untouched = flows.openAdd();
    const typed = flows.openAdd();

    flows.submitAdd(untouched, { address: `  ${ADDRESS} `, typedName: null });
    flows.submitAdd(typed, { address: ADDRESS, typedName: "wiki" });

    expect(client.mcpServer.create).toHaveBeenNthCalledWith(1, {
      payload: { source: { kind: "url", url: ADDRESS } },
    });
    expect(client.mcpServer.create).toHaveBeenNthCalledWith(2, {
      payload: { source: { kind: "url", url: ADDRESS, name: "wiki" } },
    });
    expect(flows.readState(untouched)).toEqual({ kind: "writing", write: "create" });
  });

  it("sends nothing for a form that cannot be sent", async () => {
    const { flows, client } = await setup();
    const attempt = flows.openAdd();

    flows.submitAdd(attempt, { address: "  ", typedName: null });
    flows.submitAdd(attempt, { address: ADDRESS, typedName: "Not Valid" });

    expect(client.mcpServer.create).not.toHaveBeenCalled();
    expect(flows.readState(attempt)).toEqual({ kind: "form", problem: null });
  });

  it("sends one create for one attempt, however often the form is submitted", async () => {
    const { flows, client } = await setup();
    const attempt = flows.openAdd();

    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    flows.submitAdd(attempt, { address: ADDRESS, typedName: "again" });

    expect(client.mcpServer.create).toHaveBeenCalledTimes(1);
  });

  it("does not submit a token attempt as an address", async () => {
    const { flows, client } = await setup();
    const attempt = flows.openToken("s-docs", "docs");

    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });

    expect(client.mcpServer.create).not.toHaveBeenCalled();
  });
});

describe("Add by URL: following the created server", () => {
  it("follows the id of the acknowledged create, and reads the record by it", async () => {
    const { world, flows, waitForOutcome } = await setup();
    const attempt = flows.openAdd();
    world.records.set("s-docs", urlServer("s-docs"));

    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));

    const state = await waitForOutcome(attempt, "checking");
    expect(state.mcpServerId).toBe("s-docs");
    expect(world.reads).toEqual(["s-docs"]);
  });

  it("shows a server that became ready before the create's reply arrived, not the checking record the reply carries", async () => {
    const { world, queryClient, flows, waitForOutcome } = await setup();
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    // The controller committed, checked and wrote the result while the reply was on its way.
    world.records.set(
      "s-docs",
      urlServer("s-docs", {
        status: "ready",
        tools: SENTRY_WORK.tools,
        checkedAt: SENTRY_WORK.checkedAt,
      }),
    );

    world.creates[0]!.resolve(urlServer("s-docs", { status: "checking" }));

    const state = await waitForOutcome(attempt, "ready");
    expect(state.outcome).toEqual({ kind: "ready", toolCount: 2, newServer: true });
    // The reply is not cached: the cache holds what a read returned.
    expect(queryClient.getQueryData<McpServer>(DETAIL_KEY("s-docs"))?.status).toBe("ready");
  });

  it("ends the attempt when the server was deleted before the first read", async () => {
    const { world, flows, waitFor } = await setup();
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });

    // Deleted already: the record is not in the controller when the first read runs.
    world.creates[0]!.resolve(urlServer("s-docs"));

    expect(await waitFor(attempt, "ended")).toEqual({
      kind: "ended",
      reason: "gone",
      mcpServerId: "s-docs",
      name: "docs",
      message: null,
    });
  });

  it("ends the attempt when the server moved onto a plugin's Connection before the first read, though its id survived", async () => {
    const { world, flows, waitFor } = await setup();
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.records.set("s-docs", buildServer("s-docs", "docs", "c-work"));

    world.creates[0]!.resolve(urlServer("s-docs"));

    expect(await waitFor(attempt, "ended")).toMatchObject({
      reason: "moved",
      mcpServerId: "s-docs",
      name: "docs",
    });
  });

  it("follows the live topic: a push that changes the record changes the outcome, until the server is deleted", async () => {
    const { world, flows, push, waitForOutcome, waitFor } = await setup();
    const attempt = flows.openAdd();
    world.records.set("s-docs", urlServer("s-docs"));
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));
    await waitForOutcome(attempt, "checking");

    push("s-docs", { status: "needs-sign-in", statusDetail: "Sign in." });
    const needsToken = await waitForOutcome(attempt, "needs-token");
    expect(needsToken.outcome).toEqual({
      kind: "needs-token",
      detail: "Sign in.",
      refusedAgain: false,
    });
    expect(needsToken.server?.id).toBe("s-docs");

    push("s-docs", null);
    expect(await waitFor(attempt, "ended")).toMatchObject({ reason: "gone" });
  });

  it("decides the other statuses from the record", () => {
    const decide = (overrides: Partial<McpServer>) =>
      decideFollowing({
        reading: { kind: "found", server: urlServer("s-docs", overrides) },
        origin: "create",
        mcpServerId: "s-docs",
        problem: null,
      });

    expect(decide({ status: "unreachable", statusDetail: "refused" })).toMatchObject({
      outcome: { kind: "failed", status: "unreachable", detail: "refused" },
    });
    expect(decide({ status: "error", statusDetail: null })).toMatchObject({
      outcome: { kind: "failed", status: "error", detail: null },
    });
    // A switched-off server is not checked: its status is from before it was switched off.
    expect(decide({ enabled: false, status: "ready" })).toMatchObject({
      outcome: { kind: "off", saved: null },
    });
  });

  it("says a failed read apart from a failed check, and reads again on request", async () => {
    const { world, flows, waitForOutcome } = await setup();
    const attempt = flows.openAdd();
    world.records.set("s-docs", urlServer("s-docs", { status: "ready" }));
    world.readFails = new Error("offline");
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));

    const failed = await waitForOutcome(attempt, "read-failed");
    expect(failed.outcome).toEqual({ kind: "read-failed", message: "offline" });
    expect(failed.server).toBeNull();

    world.readFails = null;
    flows.retryRead(attempt);
    expect(flows.readState(attempt)).toMatchObject({ outcome: { kind: "reading" } });
    await waitForOutcome(attempt, "ready");
  });

  it("reads the catalogue again, so the list shows the server", async () => {
    const { world, client, flows, waitForOutcome } = await setup();
    const attempt = flows.openAdd();
    world.records.set("s-docs", urlServer("s-docs"));
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));
    await waitForOutcome(attempt, "checking");

    await vi.waitFor(() => {
      expect(client.mcpServer.query).toHaveBeenCalled();
    });
  });
});

describe("Add by URL: closing", () => {
  it("never lets the reply of a closed dialog advance a dialog opened afterwards, and still leaves the server in the list", async () => {
    const { world, client, queryClient, flows } = await setup();
    const first = flows.openAdd();
    flows.submitAdd(first, { address: ADDRESS, typedName: null });
    expect(describeClosing(flows.readState(first))).toBe(
      "The check creates the server. Closing now leaves it in the list, whatever the check finds.",
    );
    flows.close(first);
    const second = flows.openAdd();
    world.records.set("s-docs", urlServer("s-docs"));

    world.creates[0]!.resolve(urlServer("s-docs"));

    await vi.waitFor(() => {
      expect(client.mcpServer.query).toHaveBeenCalled();
    });
    expect(flows.readState(second)).toEqual({ kind: "form", problem: null });
    expect(flows.readState(first)).toMatchObject({ kind: "ended", reason: "closed" });
    // The closed attempt follows nothing.
    expect(client.mcpServer.read).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(DETAIL_KEY("s-docs"))).toBeUndefined();
  });

  it("stops following when the dialog closes", async () => {
    const { world, client, flows, push, waitForOutcome } = await setup();
    const attempt = flows.openAdd();
    world.records.set("s-docs", urlServer("s-docs"));
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));
    await waitForOutcome(attempt, "checking");
    expect(describeClosing(flows.readState(attempt))).toBe("The server stays in the list.");

    flows.close(attempt);
    client.mcpServer.read.mockClear();
    push("s-docs", { status: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.mcpServer.read).not.toHaveBeenCalled();
  });

  it("gives a stable state until something changes, and tells subscribers of every change", async () => {
    const { world, flows, waitForOutcome } = await setup();
    const listener = vi.fn();
    const stop = flows.subscribe(listener);
    const attempt = flows.openAdd();

    expect(flows.readState(attempt)).toBe(flows.readState(attempt));
    world.records.set("s-docs", urlServer("s-docs"));
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    expect(listener).toHaveBeenCalled();
    world.creates[0]!.resolve(urlServer("s-docs"));
    const state = await waitForOutcome(attempt, "checking");
    expect(flows.readState(attempt)).toBe(state);
    stop();
  });

  it("shares one set of attempts per query client", async () => {
    const { queryClient, client } = await setup();
    const options = {
      queryClient,
      client: client as unknown as HerculeClient,
      cache: {
        readServers: () => [],
        readCatalogue: () =>
          buildMcpListQuery(queryClient, { queryKey: SERVERS_KEY, queryFn: () => [] }),
        readServerQuery: (id: string) => ({
          queryKey: DETAIL_KEY(id),
          queryFn: () => Promise.reject(new Error("unused")),
        }),
      },
    };

    const flows: McpUrlServerFlows = findOrCreateMcpUrlServerFlows(options);
    expect(findOrCreateMcpUrlServerFlows(options)).toBe(flows);
  });
});

describe("Add by URL: refusals", () => {
  it("returns to the form with the duplicate's name when the cache holds the server, and lets the form be sent again", async () => {
    const { world, queryClient, client, flows, waitFor } = await setup();
    queryClient.setQueryData(SERVERS_KEY, [urlServer(OTHER_ID)]);
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });

    world.creates[0]!.reject(
      new ApiError("conflict", "Exists.", { reason: "mcp-server-exists", mcpServerId: OTHER_ID }),
    );

    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toMatchObject({
        kind: "form",
        problem: {
          kind: "exists",
          mcpServerId: OTHER_ID,
          existing: { kind: "found", name: "docs" },
        },
      });
    });
    // Not in the cache: no read of the record was needed.
    expect(client.mcpServer.read).not.toHaveBeenCalled();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    expect(client.mcpServer.create).toHaveBeenCalledTimes(2);
    void waitFor;
  });

  it("reads the referenced record by its id when the cache lacks it, and says when it is gone", async () => {
    const { world, client, flows } = await setup();
    world.records.set(OTHER_ID, urlServer(OTHER_ID, { name: "wiki" }));
    const conflict = () =>
      new ApiError("conflict", "Exists.", { reason: "mcp-server-exists", mcpServerId: OTHER_ID });

    const found = flows.openAdd();
    flows.submitAdd(found, { address: ADDRESS, typedName: null });
    world.creates[0]!.reject(conflict());
    await vi.waitFor(() => {
      expect(flows.readState(found)).toMatchObject({
        problem: { existing: { kind: "found", name: "wiki" } },
      });
    });
    expect(client.mcpServer.read).toHaveBeenCalledWith({ params: { id: OTHER_ID } });

    world.records.delete(OTHER_ID);
    const gone = flows.openAdd();
    flows.submitAdd(gone, { address: ADDRESS, typedName: null });
    world.creates[1]!.reject(conflict());
    await vi.waitFor(() => {
      expect(flows.readState(gone)).toMatchObject({ problem: { existing: { kind: "gone" } } });
    });
  });

  it("says the record is unknown when it could not be read", async () => {
    const { world, flows } = await setup();
    world.readFails = new Error("offline");
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });

    world.creates[0]!.reject(
      new ApiError("conflict", "Exists.", { reason: "mcp-server-exists", mcpServerId: OTHER_ID }),
    );

    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toMatchObject({
        problem: { existing: { kind: "unknown" } },
      });
    });
  });

  it("returns to the form with the plugin's origin refusal and the controller's own words", async () => {
    const { world, flows } = await setup();
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });

    world.creates[0]!.reject(
      new ApiError("conflict", "The Sentry plugin offers this.", {
        reason: "mcp-server-on-plugin-origin",
        contributionId: "sentry/sentry",
        connectionId: CONNECTION_ID,
        pluginState: "active",
      }),
    );

    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toEqual({
        kind: "form",
        problem: {
          kind: "plugin-origin",
          refusal: { contributionId: "sentry/sentry", connectionId: CONNECTION_ID },
          message: "The Sentry plugin offers this.",
        },
      });
    });
  });

  it("puts the controller's issues at the fields, and any other failure in the form as it is", async () => {
    const { world, flows } = await setup();
    const invalid = flows.openAdd();
    flows.submitAdd(invalid, { address: "nope", typedName: null });
    world.creates[0]!.reject(
      new ApiError("validation", "Invalid.", {
        issues: [{ path: ["source", "url"], message: "Not an address." }],
      }),
    );
    await vi.waitFor(() => {
      expect(flows.readState(invalid)).toEqual({
        kind: "form",
        problem: {
          kind: "invalid",
          issues: { address: "Not an address.", name: null, token: null, other: null },
        },
      });
    });

    const offline = flows.openAdd();
    flows.submitAdd(offline, { address: ADDRESS, typedName: null });
    world.creates[1]!.reject(new Error("offline"));
    await vi.waitFor(() => {
      expect(flows.readState(offline)).toEqual({
        kind: "form",
        problem: { kind: "failed", message: "offline" },
      });
    });
  });
});

describe("the token form", () => {
  const TOKEN = "abcd1234efgh";
  const holdsOldToken = (overrides: Partial<McpServer> = {}) =>
    urlServer("s-docs", {
      source: { kind: "url", url: ADDRESS, signIn: "token", signInOffered: "token" },
      status: "needs-sign-in",
      statusDetail: "The server refused the token.",
      ...overrides,
    });

  it("refuses a token the contract would refuse without sending it", async () => {
    const { flows, client } = await setup();
    const attempt = flows.openToken("s-docs", "docs");

    flows.submitToken(attempt, "Bearer abc");

    expect(client.mcpServer.setToken).not.toHaveBeenCalled();
    const state = flows.readState(attempt);
    const issues =
      state.kind === "form" && state.problem?.kind === "invalid" ? state.problem.issues : null;
    expect(issues?.token).toContain("A token is at least 8 printable characters");
  });

  it("sends the token once, and shows the record read after the acknowledgement, never the one from before it", async () => {
    const { world, queryClient, client, flows, waitForOutcome } = await setup();
    // The page read the server before the write: it still needs sign-in.
    queryClient.setQueryData(DETAIL_KEY("s-docs"), holdsOldToken());
    world.records.set("s-docs", holdsOldToken());
    const attempt = flows.openToken("s-docs", "docs");

    flows.submitToken(attempt, TOKEN);
    flows.submitToken(attempt, TOKEN);
    expect(client.mcpServer.setToken).toHaveBeenCalledExactlyOnceWith({
      params: { id: "s-docs" },
      payload: { token: TOKEN },
    });
    expect(flows.readState(attempt)).toEqual({ kind: "writing", write: "token" });

    // The controller puts the server back to checking and acknowledges.
    world.records.set("s-docs", holdsOldToken({ status: "checking", statusDetail: null }));
    world.tokenWrites[0]!.resolve(holdsOldToken({ status: "needs-sign-in" }));

    const checking = await waitForOutcome(attempt, "checking");
    expect(checking.server?.status).toBe("checking");
    expect(flows.readState(attempt)).not.toMatchObject({ outcome: { kind: "needs-token" } });
  });

  it("ignores a read that started before the write was acknowledged and answers after it", async () => {
    const { world, queryClient, client, flows, waitForOutcome } = await setup();
    world.records.set("s-docs", holdsOldToken());
    const attempt = flows.openToken("s-docs", "docs");
    flows.submitToken(attempt, TOKEN);
    // A read of the old record starts before the acknowledgement and answers after it.
    const gate = hold();
    world.holdNextRead = gate.promise;
    void queryClient
      .fetchQuery({
        queryKey: DETAIL_KEY("s-docs"),
        queryFn: () => client.mcpServer.read({ params: { id: "s-docs" } }),
        staleTime: 0,
      })
      .catch(() => {});
    world.records.set("s-docs", holdsOldToken({ status: "checking" }));

    world.tokenWrites[0]!.resolve(holdsOldToken());
    await waitForOutcome(attempt, "checking");
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(flows.readState(attempt)).toMatchObject({ outcome: { kind: "checking" } });
  });

  it("shows the token refused again with the controller's reason, and saves a second token from the same form", async () => {
    const { world, flows, push, waitForOutcome, client } = await setup();
    world.records.set("s-docs", holdsOldToken());
    const attempt = flows.openToken("s-docs", "docs");
    flows.submitToken(attempt, TOKEN);
    world.records.set("s-docs", holdsOldToken({ status: "checking", statusDetail: null }));
    world.tokenWrites[0]!.resolve(holdsOldToken());
    await waitForOutcome(attempt, "checking");

    push("s-docs", { status: "needs-sign-in", statusDetail: "The token was refused." });

    const refused = await waitForOutcome(attempt, "needs-token");
    expect(refused.outcome).toEqual({
      kind: "needs-token",
      detail: "The token was refused.",
      refusedAgain: true,
    });
    flows.submitToken(attempt, "another-token-1");
    expect(client.mcpServer.setToken).toHaveBeenCalledTimes(2);
  });

  it("ends in ready without the new-server footer", async () => {
    const { world, flows, waitForOutcome } = await setup();
    world.records.set("s-docs", holdsOldToken({ status: "ready", statusDetail: null }));
    const attempt = flows.openToken("s-docs", "docs");

    flows.submitToken(attempt, TOKEN);
    world.tokenWrites[0]!.resolve(holdsOldToken());

    const ready = await waitForOutcome(attempt, "ready");
    expect(ready.outcome).toMatchObject({ kind: "ready", newServer: false });
  });

  it("says the token is saved for a server that is switched off, and checks nothing", async () => {
    const { world, flows, waitForOutcome } = await setup();
    world.records.set("s-docs", holdsOldToken({ enabled: false, status: "checking" }));
    const attempt = flows.openToken("s-docs", "docs");

    flows.submitToken(attempt, TOKEN);
    world.tokenWrites[0]!.resolve(holdsOldToken());

    const off = await waitForOutcome(attempt, "off");
    expect(off.outcome).toEqual({ kind: "off", saved: "token" });
  });

  it("shows an unreachable or erroring server with the controller's detail", async () => {
    const { world, flows, waitForOutcome } = await setup();
    world.records.set(
      "s-docs",
      holdsOldToken({ status: "unreachable", statusDetail: "timed out" }),
    );
    const attempt = flows.openToken("s-docs", "docs");

    flows.submitToken(attempt, TOKEN);
    world.tokenWrites[0]!.resolve(holdsOldToken());

    expect((await waitForOutcome(attempt, "failed")).outcome).toEqual({
      kind: "failed",
      status: "unreachable",
      detail: "timed out",
    });
  });

  it("ends the attempt when the server was deleted before the write, or reads as deleted after it", async () => {
    const { world, flows, waitFor } = await setup();
    const deleted = flows.openToken("s-docs", "docs");
    flows.submitToken(deleted, TOKEN);
    world.tokenWrites[0]!.reject(new ApiError("not_found", "No such server."));

    expect(await waitFor(deleted, "ended")).toEqual({
      kind: "ended",
      reason: "gone",
      mcpServerId: "s-docs",
      name: "docs",
      message: null,
    });

    const goneAfter = flows.openToken("s-other", "other");
    flows.submitToken(goneAfter, TOKEN);
    world.tokenWrites[1]!.resolve(holdsOldToken());
    expect(await waitFor(goneAfter, "ended")).toMatchObject({ reason: "gone", name: "other" });
  });

  it("ends the attempt with the controller's words when the server now uses a Connection, and keeps its name to open it", async () => {
    const { world, flows, waitFor } = await setup();
    const attempt = flows.openToken("s-docs", "docs");
    flows.submitToken(attempt, TOKEN);

    world.tokenWrites[0]!.reject(
      new ApiError("invalid_state", "This server is reached with the Connection work."),
    );

    expect(await waitFor(attempt, "ended")).toEqual({
      kind: "ended",
      reason: "moved",
      mcpServerId: "s-docs",
      name: "docs",
      message: "This server is reached with the Connection work.",
    });
  });

  it("returns to the form with the controller's reason when it refuses the token, or the write fails", async () => {
    const { world, flows, waitFor } = await setup();
    world.records.set("s-docs", holdsOldToken());
    const attempt = flows.openToken("s-docs", "docs");
    flows.submitToken(attempt, TOKEN);
    world.tokenWrites[0]!.reject(
      new ApiError("validation", "Invalid.", {
        issues: [{ path: ["token"], message: "Refused." }],
      }),
    );

    expect((await waitFor(attempt, "form")).problem).toEqual({
      kind: "invalid",
      issues: { address: null, name: null, token: "Refused.", other: null },
    });

    flows.submitToken(attempt, TOKEN);
    world.tokenWrites[1]!.reject(new Error("offline"));
    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toMatchObject({
        kind: "form",
        problem: { kind: "failed", message: "offline" },
      });
    });
  });

  it("is the same form after an Add: a failed token write returns to the server that needs a token", async () => {
    const { world, flows, waitForOutcome } = await setup();
    world.records.set("s-docs", urlServer("s-docs", { status: "needs-sign-in" }));
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));
    await waitForOutcome(attempt, "needs-token");

    flows.submitToken(attempt, TOKEN);
    world.tokenWrites[0]!.reject(new Error("offline"));

    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toMatchObject({
        kind: "following",
        outcome: { kind: "needs-token", refusedAgain: false },
        problem: { kind: "failed", message: "offline" },
      });
    });
  });

  it("does not take a token while the server is still being checked", async () => {
    const { world, client, flows, waitForOutcome } = await setup();
    world.records.set("s-docs", urlServer("s-docs"));
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));
    await waitForOutcome(attempt, "checking");

    flows.submitToken(attempt, TOKEN);

    expect(client.mcpServer.setToken).not.toHaveBeenCalled();
  });

  it("leaves the written server read again when the dialog closed during the write", async () => {
    const { world, queryClient, flows } = await setup();
    queryClient.setQueryData(DETAIL_KEY("s-docs"), holdsOldToken());
    const attempt = flows.openToken("s-docs", "docs");
    flows.submitToken(attempt, TOKEN);
    flows.close(attempt);

    world.tokenWrites[0]!.resolve(holdsOldToken());

    await vi.waitFor(() => {
      expect(queryClient.getQueryState(DETAIL_KEY("s-docs"))?.isInvalidated).toBe(true);
    });
  });
});

describe("Add by URL: the proof that a stale reply never shows", () => {
  it("delivers the live push before the reply and the read, and never shows or caches the checking record the reply carries", async () => {
    const { world, queryClient, flows } = await setup();
    const seenInCache: (string | undefined)[] = [];
    queryClient.getQueryCache().subscribe((event) => {
      const queryKey = event.query.queryKey as readonly unknown[];
      if (event.type === "updated" && queryKey[0] === "mcp-server") {
        seenInCache.push((event.query.state.data as McpServer | undefined)?.status);
      }
    });
    const seenInDialog: string[] = [];
    flows.subscribe(() => {
      const state = flows.readState(attempt);
      if (state.kind === "following") {
        seenInDialog.push(`${state.outcome.kind}:${state.server?.status ?? "none"}`);
      }
    });
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    // Hold the read that follows the acknowledgement.
    const gate = hold();
    world.holdNextRead = gate.promise;

    // The controller commits, checks and pushes the ready record before the create's reply arrives.
    world.records.set(
      "s-docs",
      urlServer("s-docs", { status: "ready", tools: SENTRY_WORK.tools, checkedAt: "2026-11-20" }),
    );
    void queryClient.invalidateQueries({ queryKey: DETAIL_KEY("s-docs") });
    world.creates[0]!.resolve(urlServer("s-docs", { status: "checking" }));
    await vi.waitFor(() => {
      expect(world.reads).toEqual(["s-docs"]);
    });
    // The reply is released, and the held read has not answered: nothing of the reply shows.
    expect(flows.readState(attempt)).toMatchObject({ outcome: { kind: "reading" } });
    expect(seenInCache).not.toContain("checking");

    gate.resolve();
    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toMatchObject({ outcome: { kind: "ready" } });
    });
    expect(seenInCache).not.toContain("checking");
    expect(seenInDialog.some((seen) => seen.endsWith(":checking"))).toBe(false);
  });

  it("sends every submission to the controller, whatever the address looks like", async () => {
    const { flows, client } = await setup();
    const first = flows.openAdd();
    const second = flows.openAdd();
    const otherPath = flows.openAdd();

    flows.submitAdd(first, { address: "https://MCP.docs.example/mcp", typedName: null });
    flows.submitAdd(second, { address: "https://mcp.docs.example:443/mcp", typedName: null });
    flows.submitAdd(otherPath, { address: "https://mcp.docs.example/v2/mcp", typedName: null });

    expect(client.mcpServer.create).toHaveBeenCalledTimes(3);
    for (const [n, url] of [
      [1, "https://MCP.docs.example/mcp"],
      [2, "https://mcp.docs.example:443/mcp"],
      [3, "https://mcp.docs.example/v2/mcp"],
    ] as const) {
      expect(client.mcpServer.create).toHaveBeenNthCalledWith(n, {
        payload: { source: { kind: "url", url } },
      });
    }
  });
});

describe("the duplicate an Add refusal points at, kept current", () => {
  const conflict = () =>
    new ApiError("conflict", "Exists.", { reason: "mcp-server-exists", mcpServerId: OTHER_ID });

  it("turns to gone when a read of the list no longer holds it, and back to found when it returns", async () => {
    const { world, flows, readList } = await setup();
    world.records.set(OTHER_ID, urlServer(OTHER_ID, { name: "wiki" }));
    await readList();
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.reject(conflict());
    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toMatchObject({
        problem: { existing: { kind: "found", name: "wiki" } },
      });
    });

    world.records.delete(OTHER_ID);
    await readList();
    expect(flows.readState(attempt)).toMatchObject({
      kind: "form",
      problem: { kind: "exists", existing: { kind: "gone" } },
    });

    world.records.set(OTHER_ID, urlServer(OTHER_ID, { name: "wiki2" }));
    await readList();
    expect(flows.readState(attempt)).toMatchObject({
      problem: { existing: { kind: "found", name: "wiki2" } },
    });
  });
});

describe("a token dialog kept by id", () => {
  it("ends with gone when a read of the list shows the server deleted, before the dialog closes", async () => {
    const { world, flows, readList } = await setup();
    world.records.set("s-docs", urlServer("s-docs", { status: "needs-sign-in" }));
    await readList();
    const attempt = flows.openToken("s-docs", "docs");
    expect(flows.readState(attempt).kind).toBe("form");

    world.records.delete("s-docs");
    await readList();

    expect(flows.readState(attempt)).toEqual({
      kind: "ended",
      reason: "gone",
      mcpServerId: "s-docs",
      name: "docs",
      message: null,
    });
  });

  it("ends with moved when a Replace put the server on a Connection, keeping its name", async () => {
    const { world, flows, readList } = await setup();
    world.records.set("s-docs", urlServer("s-docs"));
    await readList();
    const attempt = flows.openToken("s-docs", "docs");

    world.records.set("s-docs", buildServer("s-docs", "docs", "c-work"));
    await readList();

    expect(flows.readState(attempt)).toMatchObject({
      kind: "ended",
      reason: "moved",
      mcpServerId: "s-docs",
      name: "docs",
    });
  });

  it("stays a form while the list still holds the server added by URL", async () => {
    const { world, flows, readList } = await setup();
    world.records.set("s-docs", urlServer("s-docs"));
    await readList();
    const attempt = flows.openToken("s-docs", "docs");

    world.records.set("s-docs", urlServer("s-docs", { status: "ready" }));
    await readList();

    expect(flows.readState(attempt)).toEqual({ kind: "form", problem: null });
  });

  it("stops watching when the dialog closes", async () => {
    const { world, flows, readList } = await setup();
    world.records.set("s-docs", urlServer("s-docs"));
    await readList();
    const attempt = flows.openToken("s-docs", "docs");
    flows.close(attempt);

    world.records.delete("s-docs");
    await readList();

    expect(flows.readState(attempt)).toMatchObject({ kind: "ended", reason: "closed" });
  });
});

describe("Check now", () => {
  it("asks for the check, then reads the server and the list at once, without waiting for a push", async () => {
    const { world, client, flows, waitForOutcome } = await setup();
    world.records.set("s-docs", urlServer("s-docs", { status: "unreachable", statusDetail: "x" }));
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));
    await waitForOutcome(attempt, "failed");
    client.mcpServer.query.mockClear();

    // The controller starts the check; no push is delivered.
    world.records.set("s-docs", urlServer("s-docs", { status: "checking" }));
    const reason = await flows.checkNow(attempt);

    expect(reason).toBeNull();
    expect(client.mcpServer.check).toHaveBeenCalledWith({ params: { id: "s-docs" } });
    await waitForOutcome(attempt, "checking");
    await vi.waitFor(() => {
      expect(client.mcpServer.query).toHaveBeenCalled();
    });
  });

  it("returns the controller's reason when it refuses the check, and still reads again", async () => {
    const { world, client, flows, waitForOutcome } = await setup();
    world.records.set("s-docs", urlServer("s-docs", { status: "error", statusDetail: "x" }));
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    world.creates[0]!.resolve(urlServer("s-docs"));
    await waitForOutcome(attempt, "failed");
    client.mcpServer.check.mockRejectedValueOnce(new ApiError("invalid_state", "Switched off."));
    const readsBefore = world.reads.length;

    expect(await flows.checkNow(attempt)).toBe("Switched off.");
    await vi.waitFor(() => {
      expect(world.reads.length).toBeGreaterThan(readsBefore);
    });
  });
});

describe("what a dialog says and offers after the check", () => {
  it("words a failed check with the host of the address, for both statuses", () => {
    const server = urlServer("s-docs");
    expect(describeFailedCheck({ status: "unreachable", detail: "timed out", server })).toEqual({
      headline: "mcp.docs.example could not be reached.",
      detail: "timed out",
    });
    expect(describeFailedCheck({ status: "error", detail: null, server })).toEqual({
      headline: "mcp.docs.example answered in a way Hercule could not use.",
      detail: null,
    });
    expect(describeFailedCheck({ status: "error", detail: null, server: null }).headline).toBe(
      "the server answered in a way Hercule could not use.",
    );
  });

  const following = (outcome: ServerOutcome): UrlServerFlowState => ({
    kind: "following",
    mcpServerId: "s-docs",
    server: urlServer("s-docs"),
    outcome,
    problem: null,
  });

  it("offers Open on a failed check wherever the dialog was opened from, even a thread, but never on the server's own page", () => {
    const failed = following({ kind: "failed", status: "unreachable", detail: null });

    expect(describeOpenServerAction(failed, "elsewhere")).toEqual({
      mcpServerId: "s-docs",
      label: "Open docs",
    });
    expect(describeOpenServerAction(failed, "server-page")).toBeNull();
  });

  it("offers Open for a record that moved onto a Connection, and for a ready server this dialog created, but for no other outcome", () => {
    const moved: UrlServerFlowState = {
      kind: "ended",
      reason: "moved",
      mcpServerId: "s-docs",
      name: "docs",
      message: null,
    };
    expect(describeOpenServerAction(moved, "elsewhere")).toEqual({
      mcpServerId: "s-docs",
      label: "Open docs",
    });
    expect(describeOpenServerAction({ ...moved, reason: "gone" }, "elsewhere")).toBeNull();
    expect(
      describeOpenServerAction(
        following({ kind: "ready", toolCount: 1, newServer: true }),
        "elsewhere",
      ),
    ).not.toBeNull();
    expect(
      describeOpenServerAction(
        following({ kind: "ready", toolCount: 1, newServer: false }),
        "elsewhere",
      ),
    ).toBeNull();
    expect(describeOpenServerAction(following({ kind: "checking" }), "elsewhere")).toBeNull();
  });
});
