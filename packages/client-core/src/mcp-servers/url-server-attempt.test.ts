import { QueryObserver } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@hercule/contract";
import { buildQueryKeys } from "../live/keys";
import { invalidateWithoutCancelling } from "../live/invalidation";
import { buildServer, SENTRY_WORK } from "./testing";
import { CHECK_ANSWER_WAIT_MILLIS, createAttemptSlot, decideFollowing } from "./url-server-attempt";
import {
  ADDRESS,
  CONNECTION_ID,
  DOCS_ID,
  OTHER_ID,
  ROUTES,
  buildRefusal,
  detailKey,
  flush,
  hold,
  oauthServer,
  setupUrlServers,
  urlServer,
} from "./url-server-attempt.testing";

const ADD = { kind: "add" } as const;
const TOKEN_OF_DOCS = { kind: "token", mcpServerId: DOCS_ID, name: "docs" } as const;
const FIELDS = { address: ADDRESS, typedName: null };
const TOKEN = "abcd1234efgh";

/** A server that holds a pasted token, which the check refused. */
const holdsOldToken = (overrides: Partial<McpServer> = {}): McpServer =>
  urlServer({
    source: { kind: "url", url: ADDRESS, signIn: "token", signInOffered: "token" },
    status: "needs-sign-in",
    statusDetail: "The server refused the token.",
    ...overrides,
  });

/** Returns a server that is reached with a plugin's Connection, as Replace leaves it. */
const onConnection = (): McpServer => buildServer(DOCS_ID, "docs", CONNECTION_ID);

describe("Add by URL: sending", () => {
  it("sends the trimmed address with no name while the name is untouched, and the typed name when there is one", async () => {
    const { open, spies } = await setupUrlServers();
    const untouched = open(ADD);
    const typed = open(ADD);

    untouched.submitAdd({ address: `  ${ADDRESS} `, typedName: null });
    typed.submitAdd({ address: "https://mcp.wiki.example/mcp", typedName: "wiki" });

    expect(spies.create).toHaveBeenNthCalledWith(1, {
      payload: { source: { kind: "url", url: ADDRESS } },
    });
    expect(spies.create).toHaveBeenNthCalledWith(2, {
      payload: { source: { kind: "url", url: "https://mcp.wiki.example/mcp", name: "wiki" } },
    });
    expect(untouched.read()).toEqual({ kind: "writing", write: "create" });
  });

  it("sends nothing for a form that cannot be sent", async () => {
    const { open, spies } = await setupUrlServers();
    const attempt = open(ADD);

    attempt.submitAdd({ address: "  ", typedName: null });
    attempt.submitAdd({ address: ADDRESS, typedName: "Not Valid" });

    expect(spies.create).not.toHaveBeenCalled();
    expect(attempt.read()).toEqual({ kind: "form", problem: null });
  });

  it("sends one create for one attempt, however often the form is submitted", async () => {
    const { open, spies } = await setupUrlServers();
    const attempt = open(ADD);

    attempt.submitAdd(FIELDS);
    attempt.submitAdd(FIELDS);
    attempt.submitAdd({ address: ADDRESS, typedName: "again" });

    expect(spies.create).toHaveBeenCalledTimes(1);
  });

  it("does not submit a token attempt as an address", async () => {
    const { open, spies } = await setupUrlServers({ servers: [oauthServer()] });

    open(TOKEN_OF_DOCS).submitAdd(FIELDS);

    expect(spies.create).not.toHaveBeenCalled();
  });

  it("sends whatever the address looks like, because the controller decides what an address is", async () => {
    const { open, spies } = await setupUrlServers();

    for (const address of ["https://MCP.docs.example/mcp", "https://mcp.docs.example:443/mcp"]) {
      open(ADD).submitAdd({ address, typedName: null });
    }

    expect(spies.create).toHaveBeenCalledTimes(2);
  });
});

describe("Add by URL: following the created server", () => {
  it("follows the id of the acknowledged create, and reads the record by it", async () => {
    const { open, spies, waitForOutcome } = await setupUrlServers();
    const attempt = open(ADD);

    attempt.submitAdd(FIELDS);

    const state = await waitForOutcome(attempt, "checking");
    expect(state.mcpServerId).toBe(DOCS_ID);
    expect(spies.read).toHaveBeenCalledWith({ params: { id: DOCS_ID } });
  });

  it("shows a server that became ready before the create's reply arrived, not the checking record the reply carries", async () => {
    const { open, change, queryClient, holdAnswer, waitForOutcome } = await setupUrlServers();
    const reply = holdAnswer(ROUTES.create);
    const attempt = open(ADD);
    attempt.submitAdd(FIELDS);
    // The controller committed, checked and wrote the result while the reply was on its way.
    await reply.answered;
    change(DOCS_ID, {
      status: "ready",
      tools: SENTRY_WORK.tools,
      checkedAt: SENTRY_WORK.checkedAt,
    });

    reply.release();

    const state = await waitForOutcome(attempt, "ready");
    expect(state.outcome).toEqual({ kind: "ready", toolCount: 2, newServer: true });
    // The reply is not cached: the cache holds what a read returned.
    expect(queryClient.getQueryData<McpServer>(detailKey(DOCS_ID))?.status).toBe("ready");
  });

  it("ends the attempt, keeping the name, when the server was deleted before the first read", async () => {
    const { open, change, holdAnswer, waitForKind } = await setupUrlServers();
    const reply = holdAnswer(ROUTES.create);
    const attempt = open(ADD);
    attempt.submitAdd(FIELDS);
    await reply.answered;
    change(DOCS_ID, null);

    reply.release();

    expect(await waitForKind(attempt, "ended")).toEqual({
      kind: "ended",
      reason: "gone",
      mcpServerId: DOCS_ID,
      name: "docs",
      message: null,
    });
  });

  it("ends the attempt when the server moved onto a plugin's Connection before the first read, though its id survived", async () => {
    const { open, change, holdAnswer, waitForKind } = await setupUrlServers();
    const reply = holdAnswer(ROUTES.create);
    const attempt = open(ADD);
    attempt.submitAdd(FIELDS);
    await reply.answered;
    change(DOCS_ID, {
      source: { kind: "plugin", contributionId: "sentry/sentry", connectionId: CONNECTION_ID },
    });

    reply.release();

    expect(await waitForKind(attempt, "ended")).toMatchObject({
      reason: "moved",
      mcpServerId: DOCS_ID,
      name: "docs",
    });
  });

  it("follows the live topic: a push that changes the record changes the outcome, until the server is deleted", async () => {
    const { open, change, waitForOutcome, waitForKind } = await setupUrlServers();
    const attempt = open(ADD);
    attempt.submitAdd(FIELDS);
    await waitForOutcome(attempt, "checking");

    change(DOCS_ID, { status: "needs-sign-in", statusDetail: "Sign in." });
    const needsToken = await waitForOutcome(attempt, "needs-token");
    expect(needsToken.outcome).toEqual({
      kind: "needs-token",
      detail: "Sign in.",
      refusedWrite: null,
    });
    expect(needsToken.server?.id).toBe(DOCS_ID);

    change(DOCS_ID, null);
    expect(await waitForKind(attempt, "ended")).toMatchObject({ reason: "gone" });
  });

  it("says a failed read apart from a failed check, and reads again on request", async () => {
    const { open, refuse, waitForOutcome } = await setupUrlServers();
    refuse(ROUTES.read(DOCS_ID), "internal", "offline");
    const attempt = open(ADD);
    attempt.submitAdd(FIELDS);

    const failed = await waitForOutcome(attempt, "read-failed");
    expect(failed.outcome).toEqual({ kind: "read-failed", message: "offline" });
    expect(failed.server).toBeNull();

    attempt.retryRead();
    expect(attempt.read()).toMatchObject({ outcome: { kind: "reading" } });
    await waitForOutcome(attempt, "checking");
  });

  it("reads the list again, so the list shows the server", async () => {
    const { open, count, waitForOutcome } = await setupUrlServers();
    const listReads = count(ROUTES.list);
    const attempt = open(ADD);

    attempt.submitAdd(FIELDS);
    await waitForOutcome(attempt, "checking");

    await vi.waitFor(() => {
      expect(count(ROUTES.list)).toBeGreaterThan(listReads);
    });
  });

  it("decides the statuses of the record, and ends the attempt for a record that is gone or reached with a Connection", () => {
    const decide = (overrides: Partial<McpServer>, createdHere = false) =>
      decideFollowing({
        reading: { kind: "found", server: urlServer(overrides) },
        origin: "create",
        createdHere,
        mcpServerId: DOCS_ID,
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
    expect(
      decideFollowing({
        reading: { kind: "found", server: onConnection() },
        origin: "create",
        createdHere: true,
        mcpServerId: DOCS_ID,
        problem: null,
      }),
    ).toEqual({ kind: "ended", reason: "moved", name: "docs" });
    expect(
      decideFollowing({
        reading: { kind: "gone" },
        origin: "token",
        createdHere: false,
        mcpServerId: DOCS_ID,
        problem: null,
      }),
    ).toEqual({ kind: "ended", reason: "gone", name: null });
  });

  it("names the way this attempt signed in as the write the check refused, and none for a new server that asks for sign-in", () => {
    const decide = (origin: "create" | "token" | "sign-in") =>
      decideFollowing({
        reading: {
          kind: "found",
          server: urlServer({ status: "needs-sign-in", statusDetail: "No." }),
        },
        origin,
        createdHere: false,
        mcpServerId: DOCS_ID,
        problem: null,
      });

    expect(decide("create")).toMatchObject({ outcome: { refusedWrite: null } });
    expect(decide("token")).toMatchObject({ outcome: { refusedWrite: "token" } });
    expect(decide("sign-in")).toMatchObject({ outcome: { refusedWrite: "sign-in" } });
  });
});

describe("closing", () => {
  it("never lets the reply of a closed dialog advance, and still leaves the server in the list", async () => {
    const { open, count, holdAnswer, spies, queryClient } = await setupUrlServers();
    const reply = holdAnswer(ROUTES.create);
    const listReads = count(ROUTES.list);
    const first = open(ADD);
    first.submitAdd(FIELDS);
    first.close();
    const second = open(ADD);

    reply.release();

    await vi.waitFor(() => {
      expect(count(ROUTES.list)).toBeGreaterThan(listReads);
    });
    await flush();
    expect(first.read()).toMatchObject({ kind: "ended", reason: "closed" });
    expect(second.read()).toEqual({ kind: "form", problem: null });
    // The closed attempt follows nothing.
    expect(spies.read).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(detailKey(DOCS_ID))).toBeUndefined();
  });

  it("stops following when the dialog closes", async () => {
    const { open, change, count, settled, waitForOutcome } = await setupUrlServers();
    const attempt = open(ADD);
    attempt.submitAdd(FIELDS);
    await waitForOutcome(attempt, "checking");
    const reads = count(ROUTES.read(DOCS_ID));

    attempt.close();
    change(DOCS_ID, { status: "ready" });
    await settled();

    expect(count(ROUTES.read(DOCS_ID))).toBe(reads);
  });

  it("closes twice without a second change", async () => {
    const { open } = await setupUrlServers();
    const attempt = open(ADD);
    const listener = vi.fn();
    attempt.subscribe(listener);

    attempt.close();
    attempt.close();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("gives a stable state until something changes, and tells subscribers of every change", async () => {
    const { open, waitForOutcome } = await setupUrlServers();
    const attempt = open(ADD);
    const listener = vi.fn();
    const stop = attempt.subscribe(listener);

    expect(attempt.read()).toBe(attempt.read());
    attempt.submitAdd(FIELDS);
    expect(listener).toHaveBeenCalled();
    const state = await waitForOutcome(attempt, "checking");
    expect(attempt.read()).toBe(state);
    stop();
  });

  it("holds an inert attempt that shows the empty form until the dialog's own is put in", async () => {
    const { open } = await setupUrlServers();
    const slot = createAttemptSlot();
    const listener = vi.fn();
    slot.subscribe(listener);
    const unopened = slot.read();

    unopened.submitAdd(FIELDS);
    await unopened.startSignIn();
    expect(unopened.read()).toEqual({ kind: "form", problem: null });
    expect(await unopened.checkNow()).toBeNull();

    const opened = open(ADD);
    slot.hold(opened);
    expect(slot.read()).toBe(opened);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("Add by URL: refusals", () => {
  const addTwice = (context: Awaited<ReturnType<typeof setupUrlServers>>) => {
    const attempt = context.open(ADD);
    attempt.submitAdd(FIELDS);
    return attempt;
  };

  it("returns to the form with the duplicate's name, and lets the form be sent again", async () => {
    const context = await setupUrlServers({ servers: [urlServer({ name: "wiki" }, OTHER_ID)] });
    const attempt = addTwice(context);

    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({
        kind: "form",
        problem: {
          kind: "exists",
          mcpServerId: OTHER_ID,
          existing: { kind: "found", name: "wiki" },
        },
      });
    });
    attempt.submitAdd(FIELDS);
    expect(context.spies.create).toHaveBeenCalledTimes(2);
  });

  it("reads the record the refusal names by its id, whatever the list holds", async () => {
    const context = await setupUrlServers({ servers: [urlServer({ name: "wiki" }, OTHER_ID)] });
    // The list the cache holds is older than the duplicate: it lacks it.
    context.queryClient.setQueryData(["mcp-servers"], []);
    const attempt = addTwice(context);

    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({
        problem: { existing: { kind: "found", name: "wiki" } },
      });
    });
    expect(context.spies.read).toHaveBeenCalledExactlyOnceWith({ params: { id: OTHER_ID } });
  });

  it("says the duplicate is gone when its record answers 404, though the list still holds it", async () => {
    const context = await setupUrlServers({ servers: [urlServer({ name: "wiki" }, OTHER_ID)] });
    const read = context.holdRequest(ROUTES.read(OTHER_ID));
    const attempt = addTwice(context);
    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({ kind: "form", problem: { kind: "exists" } });
    });
    context.world.servers = [];

    read.release();

    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({ problem: { existing: { kind: "gone" } } });
    });
    expect(context.queries.readServers()?.some((server) => server.id === OTHER_ID)).toBe(true);
  });

  it("says the record is unknown when it could not be read", async () => {
    const context = await setupUrlServers({ servers: [urlServer({ name: "wiki" }, OTHER_ID)] });
    context.queryClient.setQueryData(["mcp-servers"], []);
    context.refuse(ROUTES.read(OTHER_ID), "internal", "offline");
    const attempt = addTwice(context);

    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({ problem: { existing: { kind: "unknown" } } });
    });
  });

  it("follows a deletion push that arrives while the first read of the duplicate is held", async () => {
    const context = await setupUrlServers({ servers: [urlServer({ name: "wiki" }, OTHER_ID)] });
    context.queryClient.setQueryData(["mcp-servers"], []);
    // The first read finds the duplicate, and its answer is held.
    const firstRead = context.holdAnswer(ROUTES.read(OTHER_ID));
    const attempt = addTwice(context);
    await firstRead.answered;

    context.change(OTHER_ID, null);
    firstRead.release();

    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({ problem: { existing: { kind: "gone" } } });
    });
    await context.settled();
    expect(attempt.read()).toMatchObject({ problem: { existing: { kind: "gone" } } });
  });

  it("stops reading the duplicate once the fields change, and the refusal goes with them", async () => {
    const context = await setupUrlServers({ servers: [urlServer({ name: "wiki" }, OTHER_ID)] });
    const attempt = addTwice(context);
    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({ kind: "form", problem: { kind: "exists" } });
    });
    await context.settled();
    const reads = context.count(ROUTES.read(OTHER_ID));

    // The same fields keep the refusal. Other fields drop it.
    attempt.changeFields(FIELDS);
    expect(attempt.read()).toMatchObject({ problem: { kind: "exists" } });
    attempt.changeFields({ address: `${ADDRESS}2`, typedName: null });
    expect(attempt.read()).toEqual({ kind: "form", problem: null });
    context.change(OTHER_ID, null);
    await context.settled();

    expect(context.count(ROUTES.read(OTHER_ID))).toBe(reads);
  });

  it("returns to the form with the plugin's origin refusal and the controller's own words", async () => {
    const { open, refuse } = await setupUrlServers();
    refuse(ROUTES.create, "conflict", "The Sentry plugin offers this.", {
      reason: "mcp-server-on-plugin-origin",
      contributionId: "sentry/sentry",
      connectionId: OTHER_ID,
      pluginState: "active",
    });
    const attempt = open(ADD);

    attempt.submitAdd(FIELDS);

    await vi.waitFor(() => {
      expect(attempt.read()).toEqual({
        kind: "form",
        problem: {
          kind: "plugin-origin",
          refusal: { contributionId: "sentry/sentry", connectionId: OTHER_ID },
          message: "The Sentry plugin offers this.",
        },
      });
    });
  });

  it("puts the controller's issues at the fields, and any other failure in the form as it is", async () => {
    const { open, lose } = await setupUrlServers();
    const invalid = open(ADD);
    invalid.submitAdd({ address: "nope", typedName: null });
    await vi.waitFor(() => {
      expect(invalid.read()).toMatchObject({
        kind: "form",
        problem: { kind: "invalid", issues: { name: null, token: null, other: null } },
      });
    });
    expect(invalid.read()).toMatchObject({
      problem: { issues: { address: expect.any(String) as string } },
    });

    lose(ROUTES.create);
    const offline = open(ADD);
    offline.submitAdd(FIELDS);
    await vi.waitFor(() => {
      expect(offline.read()).toMatchObject({ kind: "form", problem: { kind: "failed" } });
    });
  });
});

describe("the token form", () => {
  it("refuses a token the contract would refuse without sending it", async () => {
    const { open, spies } = await setupUrlServers({ servers: [oauthServer()] });
    const attempt = open(TOKEN_OF_DOCS);

    attempt.submitToken("Bearer abc");

    expect(spies.setToken).not.toHaveBeenCalled();
    const state = attempt.read();
    const issues =
      state.kind === "form" && state.problem?.kind === "invalid" ? state.problem.issues : null;
    expect(issues?.token).toContain("A token is at least 8 printable characters");
  });

  it("sends the token once, and shows the record read after the acknowledgement, never the one from before it", async () => {
    const { open, queryClient, spies, holdAnswer, waitForOutcome } = await setupUrlServers({
      servers: [holdsOldToken()],
    });
    // The page read the server before the write: it still needs sign-in.
    queryClient.setQueryData(detailKey(DOCS_ID), holdsOldToken());
    const reply = holdAnswer(ROUTES.setToken(DOCS_ID));
    const attempt = open(TOKEN_OF_DOCS);

    attempt.submitToken(TOKEN);
    attempt.submitToken(TOKEN);
    expect(spies.setToken).toHaveBeenCalledExactlyOnceWith({
      params: { id: DOCS_ID },
      payload: { token: TOKEN },
    });
    expect(attempt.read()).toEqual({ kind: "writing", write: "token" });

    reply.release();

    const checking = await waitForOutcome(attempt, "checking");
    expect(checking.server?.status).toBe("checking");
  });

  it("ignores a read that started before the write was acknowledged and answers after it", async () => {
    const { open, queryClient, client, holdAnswer, settled, waitForOutcome } =
      await setupUrlServers({ servers: [holdsOldToken()] });
    const attempt = open(TOKEN_OF_DOCS);
    // A read of the old record starts before the write and answers after the acknowledgement.
    const oldRead = holdAnswer(ROUTES.read(DOCS_ID));
    void queryClient
      .fetchQuery({
        queryKey: detailKey(DOCS_ID),
        queryFn: () => client.mcpServer.read({ params: { id: DOCS_ID } }),
        staleTime: 0,
      })
      .catch(() => {});
    await oldRead.answered;
    attempt.submitToken(TOKEN);
    await waitForOutcome(attempt, "checking");

    oldRead.release();
    await settled();
    await flush();

    expect(attempt.read()).toMatchObject({ outcome: { kind: "checking" } });
  });

  it("shows the token refused again with the controller's reason, and saves a second token from the same form", async () => {
    const { open, change, spies, waitForOutcome } = await setupUrlServers({
      servers: [holdsOldToken()],
    });
    const attempt = open(TOKEN_OF_DOCS);
    attempt.submitToken(TOKEN);
    await waitForOutcome(attempt, "checking");

    change(DOCS_ID, { status: "needs-sign-in", statusDetail: "The token was refused." });

    const refused = await waitForOutcome(attempt, "needs-token");
    expect(refused.outcome).toEqual({
      kind: "needs-token",
      detail: "The token was refused.",
      refusedWrite: "token",
    });
    attempt.submitToken("another-token-1");
    expect(spies.setToken).toHaveBeenCalledTimes(2);
  });

  it("ends in ready without the new-server footer", async () => {
    const { open, change, waitForOutcome } = await setupUrlServers({ servers: [holdsOldToken()] });
    const attempt = open(TOKEN_OF_DOCS);
    attempt.submitToken(TOKEN);
    await waitForOutcome(attempt, "checking");

    change(DOCS_ID, { status: "ready", statusDetail: null });

    const ready = await waitForOutcome(attempt, "ready");
    expect(ready.outcome).toMatchObject({ kind: "ready", newServer: false });
  });

  it("says the token is saved for a server that is switched off, and checks nothing", async () => {
    const { open, waitForOutcome } = await setupUrlServers({
      servers: [holdsOldToken({ enabled: false })],
    });
    const attempt = open(TOKEN_OF_DOCS);

    attempt.submitToken(TOKEN);

    expect((await waitForOutcome(attempt, "off")).outcome).toEqual({ kind: "off", saved: "token" });
  });

  it("shows an unreachable server with the controller's detail", async () => {
    const { open, change, waitForOutcome } = await setupUrlServers({ servers: [holdsOldToken()] });
    const attempt = open(TOKEN_OF_DOCS);
    attempt.submitToken(TOKEN);
    await waitForOutcome(attempt, "checking");

    change(DOCS_ID, { status: "unreachable", statusDetail: "timed out" });

    expect((await waitForOutcome(attempt, "failed")).outcome).toEqual({
      kind: "failed",
      status: "unreachable",
      detail: "timed out",
    });
  });

  it("ends the attempt when the server was deleted before the write, or reads as deleted after it", async () => {
    const { open, change, holdAnswer, waitForKind } = await setupUrlServers({
      servers: [holdsOldToken()],
    });
    const deleted = open({ kind: "token", mcpServerId: OTHER_ID, name: "other" });
    deleted.submitToken(TOKEN);
    expect(await waitForKind(deleted, "ended")).toMatchObject({ reason: "gone", name: "other" });

    const reply = holdAnswer(ROUTES.setToken(DOCS_ID));
    const goneAfter = open(TOKEN_OF_DOCS);
    goneAfter.submitToken(TOKEN);
    await reply.answered;
    change(DOCS_ID, null);
    reply.release();
    expect(await waitForKind(goneAfter, "ended")).toEqual({
      kind: "ended",
      reason: "gone",
      mcpServerId: DOCS_ID,
      name: "docs",
      message: null,
    });
  });

  it("ends the attempt with the controller's words when the server now uses a Connection, and keeps its name to open it", async () => {
    const { open, waitForKind } = await setupUrlServers({ servers: [onConnection()] });
    const attempt = open(TOKEN_OF_DOCS);

    attempt.submitToken(TOKEN);

    expect(await waitForKind(attempt, "ended")).toMatchObject({
      reason: "moved",
      mcpServerId: DOCS_ID,
      name: "docs",
      message: expect.stringContaining("reached with") as string,
    });
  });

  it("returns to the form with the controller's reason when it refuses the token, or the write fails", async () => {
    const { open, refuse, lose, waitForKind } = await setupUrlServers({
      servers: [holdsOldToken()],
    });
    refuse(ROUTES.setToken(DOCS_ID), "validation", "Invalid.", {
      issues: [{ path: ["token"], message: "Refused." }],
    });
    const attempt = open(TOKEN_OF_DOCS);
    attempt.submitToken(TOKEN);

    expect((await waitForKind(attempt, "form")).problem).toEqual({
      kind: "invalid",
      issues: { address: null, name: null, token: "Refused.", other: null },
    });

    lose(ROUTES.setToken(DOCS_ID));
    attempt.submitToken(TOKEN);
    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({ kind: "form", problem: { kind: "failed" } });
    });
  });

  it("is the same form after an Add: a failed token write returns to the server that needs a token", async () => {
    const { open, change, lose, waitForOutcome } = await setupUrlServers();
    const attempt = open(ADD);
    attempt.submitAdd(FIELDS);
    await waitForOutcome(attempt, "checking");
    change(DOCS_ID, { status: "needs-sign-in" });
    await waitForOutcome(attempt, "needs-token");

    lose(ROUTES.setToken(DOCS_ID));
    attempt.submitToken(TOKEN);

    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({
        kind: "following",
        outcome: { kind: "needs-token", refusedWrite: null },
        problem: { kind: "failed" },
      });
    });
  });

  it("does not take a token while the server is still being checked", async () => {
    const { open, spies, waitForOutcome } = await setupUrlServers();
    const attempt = open(ADD);
    attempt.submitAdd(FIELDS);
    await waitForOutcome(attempt, "checking");

    attempt.submitToken(TOKEN);

    expect(spies.setToken).not.toHaveBeenCalled();
  });

  it("marks the written server stale when the dialog closed during the write", async () => {
    const { open, queryClient, holdAnswer } = await setupUrlServers({ servers: [holdsOldToken()] });
    queryClient.setQueryData(detailKey(DOCS_ID), holdsOldToken());
    const reply = holdAnswer(ROUTES.setToken(DOCS_ID));
    const attempt = open(TOKEN_OF_DOCS);
    attempt.submitToken(TOKEN);
    attempt.close();

    reply.release();

    await vi.waitFor(() => {
      expect(queryClient.getQueryState(detailKey(DOCS_ID))?.isInvalidated).toBe(true);
    });
  });
});

describe("the proof that a stale reply never shows", () => {
  it("delivers a real live push to a mounted list before the reply and the read, and never shows or caches the checking record the reply carries", async () => {
    const { open, change, queryClient, client, holdAnswer, waitForOutcome } =
      await setupUrlServers();
    // The list screen is mounted: its observer keeps the list active, so a push reads it again.
    const stopList = new QueryObserver(queryClient, {
      queryKey: ["mcp-servers"],
      queryFn: async () => (await client.mcpServer.query()).items,
    }).subscribe(() => {});
    const seenInCache: string[] = [];
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const queryKey = event.query.queryKey as readonly unknown[];
      const data: unknown = event.query.state.data;
      if (queryKey[0] === "mcp-server") {
        seenInCache.push(`detail:${(data as McpServer | undefined)?.status}`);
      } else if (queryKey[0] === "mcp-servers") {
        const record = (data as McpServer[] | undefined)?.find((server) => server.id === DOCS_ID);
        if (record !== undefined) seenInCache.push(`list:${record.status}`);
      }
    });
    const attempt = open(ADD);
    const seenInDialog: string[] = [];
    attempt.subscribe(() => {
      const state = attempt.read();
      if (state.kind === "following") {
        seenInDialog.push(`${state.outcome.kind}:${state.server?.status ?? "none"}`);
      }
    });
    const reply = holdAnswer(ROUTES.create);
    attempt.submitAdd(FIELDS);
    await reply.answered;

    // The controller commits, checks and pushes the ready record before the create's reply arrives.
    change(DOCS_ID, {
      status: "ready",
      tools: SENTRY_WORK.tools,
      checkedAt: "2026-11-20T09:00:00.000Z",
    });
    for (const queryKey of buildQueryKeys(
      "mcpServer",
      [DOCS_ID],
      undefined,
      undefined,
      "created",
    )) {
      invalidateWithoutCancelling(queryClient, queryKey);
    }
    await vi.waitFor(() => {
      expect(
        queryClient.getQueryData<McpServer[]>(["mcp-servers"])?.find((s) => s.id === DOCS_ID)
          ?.status,
      ).toBe("ready");
    });
    // No page of the server was open, so the push left nothing in its own cache.
    expect(queryClient.getQueryData(detailKey(DOCS_ID))).toBeUndefined();

    // Hold the read that follows the acknowledgement.
    const read = holdAnswer(ROUTES.read(DOCS_ID));
    reply.release();
    await read.answered;
    // The reply is released, and the held read has not answered: nothing of the reply shows, in either cache.
    expect(attempt.read()).toMatchObject({ outcome: { kind: "reading" } });
    expect(queryClient.getQueryData(detailKey(DOCS_ID))).toBeUndefined();

    read.release();
    await waitForOutcome(attempt, "ready");
    // The ready record was read by the id of the acknowledged create.
    expect(queryClient.getQueryData<McpServer>(detailKey(DOCS_ID))?.status).toBe("ready");
    expect(seenInCache.some((seen) => seen.endsWith(":checking"))).toBe(false);
    expect(seenInDialog.some((seen) => seen.endsWith(":checking"))).toBe(false);
    stopList();
  });
});

describe("a token dialog kept by the server's id", () => {
  const openOnNeedsSignIn = async () => {
    const context = await setupUrlServers({ servers: [urlServer({ status: "needs-sign-in" })] });
    await context.readList();
    return { ...context, attempt: context.open(TOKEN_OF_DOCS) };
  };

  it("ends with gone when a read of the list shows the server deleted, before the dialog closes", async () => {
    const { world, readList, attempt } = await openOnNeedsSignIn();
    expect(attempt.read().kind).toBe("form");

    world.servers = [];
    await readList();

    expect(attempt.read()).toEqual({
      kind: "ended",
      reason: "gone",
      mcpServerId: DOCS_ID,
      name: "docs",
      message: null,
    });
  });

  it("ends with moved when a Replace put the server on a Connection, keeping its name", async () => {
    const { world, readList, attempt } = await openOnNeedsSignIn();

    world.servers = [onConnection()];
    await readList();

    expect(attempt.read()).toMatchObject({
      kind: "ended",
      reason: "moved",
      mcpServerId: DOCS_ID,
      name: "docs",
    });
  });

  it("stays a form, whatever the server is called now, while the list still holds the server added by URL", async () => {
    const { world, readList, attempt } = await openOnNeedsSignIn();

    world.servers = [urlServer({ status: "ready", name: "renamed" })];
    await readList();

    expect(attempt.read()).toEqual({ kind: "form", problem: null });
  });

  it("stops watching when the dialog closes", async () => {
    const { world, readList, attempt } = await openOnNeedsSignIn();
    attempt.close();

    world.servers = [];
    await readList();

    expect(attempt.read()).toMatchObject({ kind: "ended", reason: "closed" });
  });
});

describe("Check now", () => {
  /**
   * Arms nothing: it only records the timer of `CHECK_ANSWER_WAIT_MILLIS`, so a
   * test fires it by hand. Every other timer runs as it is.
   */
  const captureAnswerTimer = () => {
    const realSetTimeout = globalThis.setTimeout;
    let armed: (() => void) | null = null;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      if (delay === CHECK_ANSWER_WAIT_MILLIS) {
        armed = handler;
        return 0;
      }
      return realSetTimeout(handler, delay);
    }) as typeof setTimeout);
    return {
      isArmed: () => armed !== null,
      fire: () => {
        const handler = armed;
        armed = null;
        handler?.();
      },
      restore: () => {
        spy.mockRestore();
      },
    };
  };

  /** An Add that follows a server whose check failed. */
  const followFailed = async () => {
    const context = await setupUrlServers();
    const reply = context.holdAnswer(ROUTES.create);
    const attempt = context.open(ADD);
    attempt.submitAdd(FIELDS);
    await reply.answered;
    context.change(DOCS_ID, { status: "unreachable", statusDetail: "x" });
    reply.release();
    await context.waitForOutcome(attempt, "failed");
    return { ...context, attempt };
  };

  it("asks for the check, reads the server and the list at once, and stays busy until the record has an answer", async () => {
    const { spies, count, attempt, waitForOutcome } = await followFailed();
    const listReads = count(ROUTES.list);

    // The controller acknowledges and checks later: nothing the record shows has an answer yet.
    expect(await attempt.checkNow()).toBeNull();

    expect(spies.check).toHaveBeenCalledWith({ params: { id: DOCS_ID } });
    await vi.waitFor(() => {
      expect(count(ROUTES.list)).toBeGreaterThan(listReads);
    });
    await waitForOutcome(attempt, "checking");
    expect(attempt.read()).toMatchObject({ check: { busy: true, error: null } });
  });

  it("takes no second press while one is pending, and is idle once the record changes", async () => {
    const { spies, change, attempt } = await followFailed();
    await attempt.checkNow();
    // A second press while the check runs asks for nothing.
    expect(await attempt.checkNow()).toBeNull();
    expect(spies.check).toHaveBeenCalledTimes(1);
    expect(attempt.read()).toMatchObject({ check: { busy: true } });

    // The check ends with another reason, and the push brings the new record.
    change(DOCS_ID, {
      status: "unreachable",
      statusDetail: "timed out",
      updatedAt: "2026-11-24T10:00:00.000Z",
    });
    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({ check: { busy: false, error: null } });
    });
    // A new press asks again.
    await attempt.checkNow();
    expect(spies.check).toHaveBeenCalledTimes(2);
  });

  it("ends the wait at a newer check time, though nothing else of the record changed", async () => {
    const { change, attempt } = await followFailed();
    await attempt.checkNow();

    change(DOCS_ID, { checkedAt: "2026-11-24T10:00:00.000Z" });

    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({ check: { busy: false } });
    });
  });

  it("ends the wait by itself when the check finds what the last one found, since the controller announces nothing then", async () => {
    const { attempt } = await followFailed();
    const timer = captureAnswerTimer();
    try {
      await attempt.checkNow();
      expect(timer.isArmed()).toBe(true);
      expect(attempt.read()).toMatchObject({ check: { busy: true } });

      timer.fire();

      expect(attempt.read()).toMatchObject({ check: { busy: false, error: null } });
    } finally {
      timer.restore();
    }
  });

  it("returns the controller's reason when it refuses the check, is not busy, and still reads again", async () => {
    const { refuse, count, attempt } = await followFailed();
    refuse(ROUTES.check(DOCS_ID), "invalid_state", "Switched off.");
    const reads = count(ROUTES.read(DOCS_ID));

    expect(await attempt.checkNow()).toBe("Switched off.");

    expect(attempt.read()).toMatchObject({ check: { busy: false, error: "Switched off." } });
    await vi.waitFor(() => {
      expect(count(ROUTES.read(DOCS_ID))).toBeGreaterThan(reads);
    });
    // The reason goes with the next press.
    await attempt.checkNow();
    expect(attempt.read()).toMatchObject({ check: { busy: true, error: null } });
  });

  describe("a record that changes before the controller acknowledged the press", () => {
    /** Presses "Check now" with the controller's acknowledgement held, then delivers a record with a newer timestamp. */
    const pressThenChangeRecord = async () => {
      const context = await followFailed();
      const { attempt, change, holdAnswer } = context;
      const acknowledgement = holdAnswer(ROUTES.check(DOCS_ID));
      const press = attempt.checkNow();
      await acknowledgement.answered;
      change(DOCS_ID, {
        status: "unreachable",
        statusDetail: "timed out",
        updatedAt: "2026-11-24T10:00:00.000Z",
      });
      await vi.waitFor(() => {
        expect(attempt.read()).toMatchObject({ server: { statusDetail: "timed out" } });
      });
      return { ...context, acknowledgement, press };
    };

    it("stays busy and takes no second press until its own acknowledgement, which then ends it with no timer left behind", async () => {
      const { spies, attempt, acknowledgement, press } = await pressThenChangeRecord();
      expect(attempt.read()).toMatchObject({ check: { busy: true, error: null } });
      expect(await attempt.checkNow()).toBeNull();
      expect(spies.check).toHaveBeenCalledTimes(1);

      const timer = captureAnswerTimer();
      try {
        acknowledgement.release();
        await press;
        expect(attempt.read()).toMatchObject({ check: { busy: false, error: null } });
        expect(timer.isArmed()).toBe(false);

        // The next press waits for its own timer, whatever the first one left.
        await attempt.checkNow();
        expect(timer.isArmed()).toBe(true);
        expect(attempt.read()).toMatchObject({ check: { busy: true } });
        timer.fire();
        expect(attempt.read()).toMatchObject({ check: { busy: false } });
      } finally {
        timer.restore();
      }
    });

    it("shows the controller's refusal and no other, and the busy state of the press ends with it", async () => {
      const context = await followFailed();
      const { attempt, change, spies, onNext } = context;
      const gate = hold();
      onNext(ROUTES.check(DOCS_ID), async () => {
        await gate.promise;
        return buildRefusal("invalid_state", "Switched off.");
      });
      const press = attempt.checkNow();
      change(DOCS_ID, { statusDetail: "timed out", updatedAt: "2026-11-24T10:00:00.000Z" });
      expect(await attempt.checkNow()).toBeNull();

      gate.resolve();

      expect(await press).toBe("Switched off.");
      expect(attempt.read()).toMatchObject({ check: { busy: false, error: "Switched off." } });
      expect(spies.check).toHaveBeenCalledTimes(1);
    });
  });

  it("lets the reply of a press settle nothing once the attempt ended, and takes no press after it", async () => {
    const { attempt, change, holdAnswer, spies, waitForKind } = await followFailed();
    const acknowledgement = holdAnswer(ROUTES.check(DOCS_ID));
    const press = attempt.checkNow();
    await acknowledgement.answered;
    change(DOCS_ID, null);
    await waitForKind(attempt, "ended");

    acknowledgement.release();
    await press;

    expect(attempt.read()).toMatchObject({ kind: "ended", reason: "gone" });
    expect(await attempt.checkNow()).toBeNull();
    expect(spies.check).toHaveBeenCalledTimes(1);
  });
});
