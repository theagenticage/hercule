import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { ApiError } from "../errors";
import { buildMcpListQuery } from "./list-edits";
import {
  createMcpUrlServerFlows,
  type BrowserSignInPort,
  type SignInStep,
  type UrlServerFlowState,
} from "./url-server-flows";
import { buildServer } from "./testing";

const ADDRESS = "https://mcp.docs.example/mcp";
const AUTHORIZATION_URL = "https://auth.docs.example/authorize?state=abc123&client_id=x";
const CALLBACK = "code=the-code&state=abc123";
const SERVERS_KEY = ["mcp-servers"];
const DETAIL_KEY = (id: string) => ["mcp-server", id];

/** Returns a server added by URL that offers OAuth and needs sign-in. */
const oauthServer = (overrides: Partial<McpServer> = {}): McpServer =>
  buildServer("s-docs", "docs", "", {
    source: { kind: "url", url: ADDRESS, signIn: "none", signInOffered: "oauth" },
    status: "needs-sign-in",
    statusDetail: "The server asks for a sign-in",
    tools: [],
    checkedAt: null,
    ...overrides,
  });

/** A promise the test settles by hand. */
const hold = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type WaitOutcome = Awaited<ReturnType<BrowserSignInPort["wait"]>>;

/**
 * A controller that holds one record, a client whose sign-in calls the test
 * can fail, and, when `withPort`, a port to the desktop's listener whose
 * `wait` the test settles.
 */
const setup = async ({ withPort = true, listens = true } = {}) => {
  const world = { record: oauthServer(), gone: false };
  const client = {
    mcpServer: {
      query: vi.fn(() => Promise.resolve(world.gone ? [] : [world.record])),
      read: vi.fn(() => Promise.resolve({ ...world.record })),
      create: vi.fn(),
      setToken: vi.fn(),
      startSignIn: vi.fn((): Promise<{ authorizationUrl: string; expiresAt: string }> =>
        Promise.resolve({ authorizationUrl: AUTHORIZATION_URL, expiresAt: "2026-11-23T10:10:00Z" }),
      ),
      finishSignIn: vi.fn((): Promise<McpServer> => {
        world.record = { ...world.record, status: "checking" };
        return Promise.resolve(world.record);
      }),
    },
  };
  const waits: ReturnType<typeof hold<WaitOutcome>>[] = [];
  const port = {
    listen: vi.fn(() =>
      Promise.resolve(
        listens
          ? {
              kind: "listening" as const,
              listenerId: "l-1",
              redirectUri: "http://127.0.0.1:4937/callback",
            }
          : { kind: "unavailable" as const },
      ),
    ),
    wait: vi.fn(() => {
      const held = hold<WaitOutcome>();
      waits.push(held);
      return held.promise;
    }),
    cancel: vi.fn(() => Promise.resolve()),
    open: vi.fn(() => Promise.resolve()),
  } satisfies BrowserSignInPort;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const catalogue = buildMcpListQuery(queryClient, {
    queryKey: SERVERS_KEY,
    queryFn: () => client.mcpServer.query(),
  });
  await catalogue.fetch();
  const flows = createMcpUrlServerFlows({
    queryClient,
    client: client as unknown as HerculeClient,
    browserSignIn: withPort ? port : undefined,
    cache: {
      readServers: () => queryClient.getQueryData<McpServer[]>(SERVERS_KEY),
      readCatalogue: () => catalogue,
      readServerQuery: (id) => ({
        queryKey: DETAIL_KEY(id),
        queryFn: () => client.mcpServer.read(),
      }),
    },
  });
  /** Changes the record and pushes on the live topic. */
  const push = (change: Partial<McpServer>) => {
    world.record = { ...world.record, ...change };
    void queryClient.invalidateQueries({ queryKey: DETAIL_KEY(world.record.id) });
  };
  /** Waits until the attempt shows a sign-in step of `kind`, and returns the step. */
  const waitForStep = async <K extends SignInStep["kind"]>(attempt: string, kind: K) => {
    await vi.waitFor(() => {
      const state = flows.readState(attempt);
      expect(state.kind === "signing-in" && state.step.kind).toBe(kind);
    });
    const state = flows.readState(attempt) as Extract<UrlServerFlowState, { kind: "signing-in" }>;
    return state.step as Extract<SignInStep, { kind: K }>;
  };
  const waitForOutcome = async (attempt: string, kind: string) => {
    await vi.waitFor(() => {
      const state = flows.readState(attempt);
      expect(state.kind === "following" && state.outcome.kind).toBe(kind);
    });
  };
  /** Reads the list of servers again from the controller, as a live push of the list does. */
  const readList = () => catalogue.fetch();
  return { world, client, port, waits, flows, push, readList, waitForStep, waitForOutcome };
};

const invalidState = (reason: string, message = "The controller's words.") =>
  new ApiError("invalid_state", message, { reason });

describe("the browser sign-in of the desktop app", () => {
  it("listens first, starts the sign-in with the listener's address, shows who approves, opens the browser, and finishes with what the browser sent", async () => {
    const { flows, client, port, waits, waitForStep, waitForOutcome, push } = await setup();
    const attempt = flows.openToken("s-docs", "docs");

    const starting = flows.startSignIn(attempt);
    expect(flows.readState(attempt)).toMatchObject({
      kind: "signing-in",
      step: { kind: "starting" },
    });
    await starting;

    const waiting = await waitForStep(attempt, "waiting");
    expect(waiting).toMatchObject({
      approvalHost: "auth.docs.example",
      returnBy: "listener",
      authorizationUrl: AUTHORIZATION_URL,
      openError: null,
    });
    expect(port.listen.mock.invocationCallOrder[0]).toBeLessThan(
      client.mcpServer.startSignIn.mock.invocationCallOrder[0]!,
    );
    expect(client.mcpServer.startSignIn).toHaveBeenCalledWith({
      params: { id: "s-docs" },
      payload: { redirectUri: "http://127.0.0.1:4937/callback" },
    });
    // The waiting step is on screen, the return is awaited, and the browser has not opened yet.
    expect(port.wait).toHaveBeenCalledWith("l-1", AUTHORIZATION_URL);
    expect(port.open).not.toHaveBeenCalled();
    await flows.openSignInPage(attempt);
    expect(port.open).toHaveBeenCalledWith(AUTHORIZATION_URL);
    expect(port.wait.mock.invocationCallOrder[0]).toBeLessThan(
      port.open.mock.invocationCallOrder[0]!,
    );

    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
    await vi.waitFor(() => {
      expect(client.mcpServer.finishSignIn).toHaveBeenCalledWith({
        params: { id: "s-docs" },
        payload: { callbackQuery: CALLBACK },
      });
    });
    await waitForOutcome(attempt, "checking");
    push({ status: "ready", tools: [{ name: "search", description: "Searches." }] });
    await waitForOutcome(attempt, "ready");
    expect(flows.readState(attempt)).toMatchObject({
      kind: "following",
      outcome: { kind: "ready", toolCount: 1, newServer: false },
    });
  });

  it("offers only the paste when the listener is unavailable, and opens the browser when the app asks", async () => {
    const { flows, client, port, waitForStep } = await setup({ listens: false });
    const attempt = flows.openToken("s-docs", "docs");

    await flows.startSignIn(attempt);

    const waiting = await waitForStep(attempt, "waiting");
    expect(waiting.returnBy).toBe("paste");
    expect(port.wait).not.toHaveBeenCalled();
    expect(port.open).not.toHaveBeenCalled();
    await flows.openSignInPage(attempt);
    expect(port.open).toHaveBeenCalledWith(AUTHORIZATION_URL);
    const sent = client.mcpServer.startSignIn.mock.calls[0] as unknown as [
      { payload: { redirectUri: string } },
    ];
    expect(sent[0].payload.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("finishes with a pasted address, closes the listener, and ignores the wait it ended", async () => {
    const { flows, client, port, waits, waitForStep, waitForOutcome } = await setup();
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    await flows.finishSignInByPaste(attempt, `  http://127.0.0.1:4937/callback?${CALLBACK}  `);
    waits[0]!.resolve({ kind: "cancelled" });

    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(client.mcpServer.finishSignIn).toHaveBeenCalledTimes(1);
    expect(client.mcpServer.finishSignIn).toHaveBeenCalledWith({
      params: { id: "s-docs" },
      payload: { callbackQuery: `http://127.0.0.1:4937/callback?${CALLBACK}` },
    });
    await waitForOutcome(attempt, "checking");
  });

  it("shows why the browser could not be opened, and opens it again on request", async () => {
    const { flows, port, waitForStep } = await setup();
    port.open.mockRejectedValueOnce(new Error("no browser"));
    const attempt = flows.openToken("s-docs", "docs");

    await flows.startSignIn(attempt);
    expect(await waitForStep(attempt, "waiting")).toMatchObject({ opened: false, openError: null });
    await flows.openSignInPage(attempt);
    expect(await waitForStep(attempt, "waiting")).toMatchObject({
      opened: true,
      openError: "no browser",
    });
    await flows.openSignInPage(attempt);

    expect(port.open).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect(await waitForStep(attempt, "waiting")).toMatchObject({ openError: null });
    });
  });

  it("finishes a browser return that comes at once, before the app has opened the browser", async () => {
    const { flows, client, port, waitForOutcome } = await setup();
    // The browser (or a fast redirect) answers the moment the wait is armed.
    port.wait.mockImplementationOnce(() =>
      Promise.resolve({ kind: "received" as const, callbackQuery: CALLBACK }),
    );
    const attempt = flows.openToken("s-docs", "docs");

    await flows.startSignIn(attempt);

    await vi.waitFor(() => {
      expect(client.mcpServer.finishSignIn).toHaveBeenCalledWith({
        params: { id: "s-docs" },
        payload: { callbackQuery: CALLBACK },
      });
    });
    expect(port.open).not.toHaveBeenCalled();
    await waitForOutcome(attempt, "checking");
  });

  it("never opens the browser by itself, and ignores a request to open before the sign-in waits", async () => {
    const { flows, port, waitForStep } = await setup();
    const attempt = flows.openToken("s-docs", "docs");

    await flows.openSignInPage(attempt);
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(port.open).not.toHaveBeenCalled();
  });

  it("marks the page as opened before the browser answers, so an effect opens it once", async () => {
    const { flows, port, waitForStep } = await setup();
    const opening = hold();
    port.open.mockImplementationOnce(() => opening.promise);
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    const pending = flows.openSignInPage(attempt);

    expect(await waitForStep(attempt, "waiting")).toMatchObject({ opened: true });
    opening.resolve();
    await pending;
  });

  it("retires the attempt at the close request: a return that arrives in the same tick finishes nothing, and a late open failure shows nothing", async () => {
    const { flows, client, port, waits, waitForStep } = await setup();
    let failOpen!: (error: unknown) => void;
    port.open.mockImplementationOnce(
      () =>
        new Promise<void>((_done, fail) => {
          failOpen = fail;
        }),
    );
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");
    const pending = flows.openSignInPage(attempt);

    // The result lands and the close request comes in one tick, before any continuation runs.
    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
    flows.close(attempt);
    expect(flows.readState(attempt).kind).toBe("ended");
    failOpen(new Error("no browser"));
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(client.mcpServer.finishSignIn).not.toHaveBeenCalled();
    expect(flows.readState(attempt)).toMatchObject({ kind: "ended", reason: "closed" });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
  });

  it("goes back to the form on Cancel, closes the listener, and ignores a return that comes late", async () => {
    const { flows, client, port, waits, waitForStep } = await setup();
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    flows.cancelSignIn(attempt);
    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
    await Promise.resolve();

    expect(flows.readState(attempt)).toEqual({ kind: "form", problem: null });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(client.mcpServer.finishSignIn).not.toHaveBeenCalled();
  });

  it("closes the listener when the dialog closes, and a return that comes late for the closed attempt finishes nothing", async () => {
    const { flows, client, port, waits, waitForStep } = await setup();
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    flows.close(attempt);
    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
    await Promise.resolve();

    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(client.mcpServer.finishSignIn).not.toHaveBeenCalled();
  });

  it("does not let a late return of a closed attempt reach a dialog opened afterwards", async () => {
    const { flows, client, waits, waitForStep } = await setup();
    const first = flows.openToken("s-docs", "docs");
    await flows.startSignIn(first);
    await waitForStep(first, "waiting");
    flows.close(first);
    const second = flows.openToken("s-docs", "docs");

    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
    await Promise.resolve();

    expect(flows.readState(second)).toEqual({ kind: "form", problem: null });
    expect(client.mcpServer.finishSignIn).not.toHaveBeenCalled();
  });

  it("says the browser did not come back in time, and starts again on request", async () => {
    const { flows, port, waits, waitForStep } = await setup();
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    waits[0]!.resolve({ kind: "timed-out" });

    expect(await waitForStep(attempt, "refused")).toMatchObject({
      reason: "timed-out",
      message: "The browser did not come back within 10 minutes. Start again.",
    });
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");
    expect(port.listen).toHaveBeenCalledTimes(2);
  });

  it("ends the sign-in when the listener was ended by someone else", async () => {
    const { flows, waits, waitForStep } = await setup();
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    waits[0]!.resolve({ kind: "cancelled" });

    expect(await waitForStep(attempt, "refused")).toMatchObject({ reason: "failed" });
  });
});

describe("a sign-in whose server changes while it runs", () => {
  it("ends a waiting sign-in when the list shows the server deleted, retires the listener, and finishes nothing when the browser returns after it", async () => {
    const { world, flows, client, port, waits, readList, waitForStep } = await setup();
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    world.gone = true;
    await readList();

    expect(flows.readState(attempt)).toEqual({
      kind: "ended",
      reason: "gone",
      mcpServerId: "s-docs",
      name: "docs",
      message: null,
    });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.mcpServer.finishSignIn).not.toHaveBeenCalled();
    expect(flows.readState(attempt)).toMatchObject({ kind: "ended", reason: "gone" });
  });

  describe("an Add whose create was acknowledged", () => {
    /** Adds the server, waits until it asks for a sign-in, and starts the browser sign-in. */
    const startAddSignIn = async (context: Awaited<ReturnType<typeof setup>>) => {
      const { world, client, flows, waitForOutcome, waitForStep } = context;
      client.mcpServer.create.mockImplementationOnce(() => Promise.resolve(world.record));
      const attempt = flows.openAdd();
      flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
      await waitForOutcome(attempt, "needs-token");
      await flows.startSignIn(attempt);
      await waitForStep(attempt, "waiting");
      return attempt;
    };

    /** Holds the next read of the server, which then fails as the deleted server's read does. */
    const holdNextDetailRead = (context: Awaited<ReturnType<typeof setup>>) => {
      const gate = hold();
      context.client.mcpServer.read.mockImplementationOnce(async () => {
        await gate.promise;
        throw new ApiError("not_found", "No such server.");
      });
      return gate;
    };

    it("ends the sign-in at the list that shows the server deleted, though the read of the server is still held, and finishes nothing when the browser returns", async () => {
      const context = await setup();
      const { world, flows, client, port, waits, readList, push } = context;
      const attempt = await startAddSignIn(context);

      const gate = holdNextDetailRead(context);
      world.gone = true;
      push({});
      await readList();

      expect(flows.readState(attempt)).toMatchObject({ kind: "ended", reason: "gone" });
      expect(port.cancel).toHaveBeenCalledWith("l-1");
      waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
      await new Promise((resolve) => setTimeout(resolve, 10));
      gate.resolve();
      expect(client.mcpServer.finishSignIn).not.toHaveBeenCalled();
    });

    it("ends the sign-in at the list that shows the server on a Connection, though the read of the server is still held", async () => {
      const context = await setup();
      const { world, flows, client, port, waits, readList, push } = context;
      const attempt = await startAddSignIn(context);

      const gate = holdNextDetailRead(context);
      push({});
      world.record = buildServer("s-docs", "docs", "c-work");
      await readList();

      expect(flows.readState(attempt)).toMatchObject({ kind: "ended", reason: "moved" });
      expect(port.cancel).toHaveBeenCalledWith("l-1");
      waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
      await new Promise((resolve) => setTimeout(resolve, 10));
      gate.resolve();
      expect(client.mcpServer.finishSignIn).not.toHaveBeenCalled();
    });
  });

  it("ends a waiting sign-in when the server moved onto a Connection, and never goes back to the form on Cancel", async () => {
    const { world, flows, readList, waitForStep } = await setup();
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    world.record = buildServer("s-docs", "docs", "c-work");
    await readList();
    flows.cancelSignIn(attempt);

    expect(flows.readState(attempt)).toMatchObject({
      kind: "ended",
      reason: "moved",
      mcpServerId: "s-docs",
      name: "docs",
    });
  });

  it("ends a sign-in that is still starting, and closes the listener that was opened for it", async () => {
    const { world, flows, client, port, readList, waitForStep } = await setup();
    let release!: (started: { authorizationUrl: string; expiresAt: string }) => void;
    client.mcpServer.startSignIn.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const attempt = flows.openToken("s-docs", "docs");
    const starting = flows.startSignIn(attempt);
    await waitForStep(attempt, "starting");
    await vi.waitFor(() => {
      expect(client.mcpServer.startSignIn).toHaveBeenCalled();
    });

    world.gone = true;
    await readList();
    release({ authorizationUrl: AUTHORIZATION_URL, expiresAt: "2026-11-23T10:10:00Z" });
    await starting;

    expect(flows.readState(attempt)).toMatchObject({ kind: "ended", reason: "gone" });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(port.wait).not.toHaveBeenCalled();
  });

  it("leaves a sign-in that is being finished to its own write", async () => {
    const { world, flows, client, waits, readList, waitForStep } = await setup();
    let finish!: (server: McpServer) => void;
    client.mcpServer.finishSignIn.mockImplementationOnce(
      () =>
        new Promise<McpServer>((done) => {
          finish = done;
        }),
    );
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");
    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });
    await waitForStep(attempt, "finishing");

    world.gone = true;
    await readList();

    expect(flows.readState(attempt)).toMatchObject({
      kind: "signing-in",
      step: { kind: "finishing" },
    });
    finish(world.record);
  });
});

describe("the browser sign-in of the web app", () => {
  it("starts the sign-in with an address nothing listens on and waits for the pasted address", async () => {
    const { flows, client, waitForStep } = await setup({ withPort: false });
    const attempt = flows.openToken("s-docs", "docs");

    await flows.startSignIn(attempt);

    const waiting = await waitForStep(attempt, "waiting");
    expect(waiting).toMatchObject({ returnBy: "paste", approvalHost: "auth.docs.example" });
    const sent = client.mcpServer.startSignIn.mock.calls[0] as unknown as [
      { payload: { redirectUri: string } },
    ];
    expect(sent[0].payload.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("refuses a pasted text that is not a redirect answer without sending it, and keeps waiting", async () => {
    const { flows, client, waitForStep } = await setup({ withPort: false });
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    await flows.finishSignInByPaste(attempt, "https://example.com/nothing");

    expect(client.mcpServer.finishSignIn).not.toHaveBeenCalled();
    expect(await waitForStep(attempt, "waiting")).toMatchObject({
      pasteProblem: expect.stringContaining("That is not what the browser ended on") as string,
    });
  });

  it("keeps waiting, with the controller's words, when it finds the pasted address is for another redirect", async () => {
    const { flows, client, waitForStep } = await setup({ withPort: false });
    client.mcpServer.finishSignIn.mockRejectedValueOnce(
      new ApiError("validation", "The address is for another sign-in."),
    );
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    await flows.finishSignInByPaste(attempt, CALLBACK);

    expect(await waitForStep(attempt, "waiting")).toMatchObject({
      pasteProblem: "The address is for another sign-in.",
    });
  });

  it("follows the server after a pasted address, and ends an Add with the new server's footer", async () => {
    const { flows, client, push, waitForOutcome } = await setup({ withPort: false });
    client.mcpServer.create.mockResolvedValueOnce(oauthServer({ status: "checking" }));
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    await waitForOutcome(attempt, "needs-token");
    await flows.startSignIn(attempt);

    await flows.finishSignInByPaste(attempt, CALLBACK);
    await waitForOutcome(attempt, "checking");
    push({ status: "ready", tools: [{ name: "search", description: "Searches." }] });
    await waitForOutcome(attempt, "ready");

    expect(flows.readState(attempt)).toMatchObject({
      outcome: { kind: "ready", toolCount: 1, newServer: true },
    });
  });
});

describe("a sign-in the controller refuses", () => {
  it.each([
    [
      "sign-in-expired",
      "This sign-in ran out, or another one for this server replaced it. Start again.",
    ],
    [
      "source-unreadable",
      "The server or its sign-in service could not be reached. Try again later.",
    ],
  ])("says %s when the start is refused, and starts again on request", async (reason, message) => {
    const { flows, client, port, waitForStep } = await setup();
    client.mcpServer.startSignIn.mockRejectedValueOnce(invalidState(reason));
    const attempt = flows.openToken("s-docs", "docs");

    await flows.startSignIn(attempt);

    expect(await waitForStep(attempt, "refused")).toMatchObject({ reason, message });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");
  });

  it.each([
    [
      "sign-in-expired",
      "This sign-in ran out, or another one for this server replaced it. Start again.",
    ],
    [
      "sign-in-refused",
      "The browser or the provider refused the sign-in. Nothing was changed. You can start again.",
    ],
    [
      "source-unreadable",
      "The server or its sign-in service could not be reached. Try again later.",
    ],
  ])("says %s when the finish is refused", async (reason, message) => {
    const { flows, client, waits, waitForStep } = await setup();
    client.mcpServer.finishSignIn.mockRejectedValueOnce(invalidState(reason));
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });

    expect(await waitForStep(attempt, "refused")).toMatchObject({ reason, message });
  });

  it("goes back to the token form, saying only a token works, when the controller finds no sign-in through the browser works", async () => {
    const { flows, client, waits, waitForStep } = await setup();
    client.mcpServer.finishSignIn.mockRejectedValueOnce(invalidState("sign-in-unsupported"));
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    waits[0]!.resolve({ kind: "received", callbackQuery: CALLBACK });

    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toEqual({
        kind: "form",
        problem: {
          kind: "sign-in-unsupported",
          message:
            "This server does not allow a sign-in through the browser. Paste a token instead.",
        },
      });
    });
  });

  it("goes back to the token form of an Add when the start finds no sign-in through the browser works", async () => {
    const { flows, client, waitForOutcome } = await setup({ withPort: false });
    client.mcpServer.create.mockResolvedValueOnce(oauthServer({ status: "checking" }));
    client.mcpServer.startSignIn.mockRejectedValueOnce(invalidState("sign-in-unsupported"));
    const attempt = flows.openAdd();
    flows.submitAdd(attempt, { address: ADDRESS, typedName: null });
    await waitForOutcome(attempt, "needs-token");

    await flows.startSignIn(attempt);

    await vi.waitFor(() => {
      expect(flows.readState(attempt)).toMatchObject({
        kind: "following",
        outcome: { kind: "needs-token" },
        problem: { kind: "sign-in-unsupported" },
      });
    });
  });

  it("ends the attempt when the server is gone or reached with a Connection now", async () => {
    const { flows, client } = await setup({ withPort: false });
    client.mcpServer.startSignIn.mockRejectedValueOnce(
      new ApiError("not_found", "No such server."),
    );
    client.mcpServer.startSignIn.mockRejectedValueOnce(
      new ApiError("invalid_state", "This server is reached with a Connection."),
    );
    const first = flows.openToken("s-docs", "docs");
    await flows.startSignIn(first);
    expect(flows.readState(first)).toMatchObject({ kind: "ended", reason: "gone" });

    const second = flows.openToken("s-docs", "docs");
    await flows.startSignIn(second);
    expect(flows.readState(second)).toMatchObject({
      kind: "ended",
      reason: "moved",
      message: "This server is reached with a Connection.",
    });
  });

  it("says another failure in the controller's words", async () => {
    const { flows, client, waitForStep } = await setup({ withPort: false });
    client.mcpServer.startSignIn.mockRejectedValueOnce(new Error("The network is down."));
    const attempt = flows.openToken("s-docs", "docs");

    await flows.startSignIn(attempt);

    expect(await waitForStep(attempt, "refused")).toMatchObject({
      reason: "failed",
      message: "The network is down.",
    });
  });

  it("starts nothing while another sign-in of the attempt runs", async () => {
    const { flows, client, waitForStep } = await setup({ withPort: false });
    const attempt = flows.openToken("s-docs", "docs");
    await flows.startSignIn(attempt);
    await waitForStep(attempt, "waiting");

    await flows.startSignIn(attempt);

    expect(client.mcpServer.startSignIn).toHaveBeenCalledTimes(1);
  });
});
