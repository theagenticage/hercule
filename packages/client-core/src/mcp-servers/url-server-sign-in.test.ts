import { describe, expect, it, vi } from "vitest";
import { buildServer } from "./testing";
import type { UrlServerAttempt } from "./url-server-attempt";
import {
  ADDRESS,
  AUTHORIZATION_HOST,
  CONNECTION_ID,
  DOCS_ID,
  OTHER_ID,
  ROUTES,
  buildCallbackQuery,
  flush,
  hold,
  oauthServer,
  setupUrlServers,
} from "./url-server-attempt.testing";

const TOKEN_OF_DOCS = { kind: "token", mcpServerId: DOCS_ID, name: "docs" } as const;
const ADD = { kind: "add" } as const;

type Setup = Awaited<ReturnType<typeof setupUrlServers>>;

/** Returns the address the fake controller gave the sign-in that waits. */
const waitingAuthorizationUrl = (world: Setup["world"]): string =>
  world.signIns.get(DOCS_ID)!.authorizationUrl;

/** Starts the sign-in of the token form and waits until the step waits for the browser. */
const startWaiting = async ({ open, waitForStep }: Setup): Promise<UrlServerAttempt> => {
  const attempt = open(TOKEN_OF_DOCS);
  await attempt.startSignIn();
  await waitForStep(attempt, "waiting");
  return attempt;
};

describe("the browser sign-in of the desktop app", () => {
  it("listens first, starts the sign-in with the listener's address, shows who approves, opens the browser only on the user's press, and finishes with what the browser sent", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { open, port, spies, world, change, waitForStep, waitForOutcome } = context;
    const attempt = open(TOKEN_OF_DOCS);

    const starting = attempt.startSignIn();
    expect(attempt.read()).toMatchObject({ kind: "signing-in", step: { kind: "starting" } });
    await starting;

    const waiting = (await waitForStep(attempt, "waiting")).step;
    expect(waiting).toMatchObject({
      approvalHost: AUTHORIZATION_HOST,
      returnBy: "listener",
      authorizationUrl: waitingAuthorizationUrl(world),
      opened: false,
      openError: null,
    });
    expect(port.listen.mock.invocationCallOrder[0]).toBeLessThan(
      spies.startSignIn.mock.invocationCallOrder[0]!,
    );
    expect(spies.startSignIn).toHaveBeenCalledWith({
      params: { id: DOCS_ID },
      payload: { redirectUri: "http://127.0.0.1:4937/callback" },
    });
    // The step waits for the return, and the browser stays shut until the user presses the button.
    expect(port.waits).toHaveLength(1);
    expect(port.open).not.toHaveBeenCalled();
    await attempt.openSignInPage();
    expect(port.open).toHaveBeenCalledWith(waitingAuthorizationUrl(world));
    expect(attempt.read()).toMatchObject({ step: { kind: "waiting", opened: true } });

    port.waits[0]!.resolve({
      kind: "received",
      callbackQuery: buildCallbackQuery(waitingAuthorizationUrl(world)),
    });
    await waitForOutcome(attempt, "checking");
    change(DOCS_ID, { status: "ready", tools: [{ name: "search", description: "Searches." }] });
    await waitForOutcome(attempt, "ready");
    expect(attempt.read()).toMatchObject({
      kind: "following",
      outcome: { kind: "ready", toolCount: 1, newServer: false },
    });
  });

  it("offers only the paste when the listener is unavailable, and opens the browser when the user presses the button", async () => {
    const { open, port, spies, waitForStep } = await setupUrlServers({
      servers: [oauthServer()],
      listens: false,
    });
    const attempt = open(TOKEN_OF_DOCS);

    await attempt.startSignIn();

    expect((await waitForStep(attempt, "waiting")).step).toMatchObject({ returnBy: "paste" });
    expect(port.waits).toHaveLength(0);
    expect(port.open).not.toHaveBeenCalled();
    await attempt.openSignInPage();
    expect(port.open).toHaveBeenCalledTimes(1);
    const sent = spies.startSignIn.mock.calls[0] as unknown as [
      { payload: { redirectUri: string } },
    ];
    expect(sent[0].payload.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("finishes with a pasted address, closes the listener, and ignores the wait it ended", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, spies, world, waitForOutcome } = context;
    const attempt = await startWaiting(context);
    const pasted = `http://127.0.0.1:4937/callback?${buildCallbackQuery(waitingAuthorizationUrl(world))}`;

    await attempt.finishSignInByPaste(`  ${pasted}  `);
    port.waits[0]!.resolve({ kind: "cancelled" });

    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(spies.finishSignIn).toHaveBeenCalledExactlyOnceWith({
      params: { id: DOCS_ID },
      payload: { callbackQuery: pasted },
    });
    await waitForOutcome(attempt, "checking");
  });

  it("sends one finish when the paste is double, or when the paste races the return", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, spies, world, waitForOutcome } = context;
    const attempt = await startWaiting(context);
    const query = buildCallbackQuery(waitingAuthorizationUrl(world));

    const first = attempt.finishSignInByPaste(query);
    const second = attempt.finishSignInByPaste(query);
    port.waits[0]!.resolve({ kind: "received", callbackQuery: query });
    await Promise.all([first, second]);

    await waitForOutcome(attempt, "checking");
    expect(spies.finishSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows why the browser could not be opened, and opens it again on request", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port } = context;
    port.open.mockRejectedValueOnce(new Error("no browser"));
    const attempt = await startWaiting(context);

    await attempt.openSignInPage();
    expect(attempt.read()).toMatchObject({
      step: { kind: "waiting", opened: true, openError: "no browser" },
    });
    await attempt.openSignInPage();

    expect(port.open).toHaveBeenCalledTimes(2);
    expect(attempt.read()).toMatchObject({ step: { opened: true, openError: null } });
  });

  it("finishes a browser return that comes the moment the step waits, before the user pressed anything", async () => {
    const { open, port, spies, waitForOutcome } = await setupUrlServers({
      servers: [oauthServer()],
      returnsAtOnce: true,
    });
    const attempt = open(TOKEN_OF_DOCS);

    await attempt.startSignIn();

    await waitForOutcome(attempt, "checking");
    expect(spies.finishSignIn).toHaveBeenCalledTimes(1);
    expect(port.open).not.toHaveBeenCalled();
  });

  it("never opens the browser by itself, and ignores a press before the sign-in waits", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { open, port } = context;
    const attempt = open(TOKEN_OF_DOCS);

    await attempt.openSignInPage();
    await attempt.startSignIn();
    await context.waitForStep(attempt, "waiting");
    await flush();

    expect(port.open).not.toHaveBeenCalled();
  });

  it("marks the page as opened before the browser answers, so a second press reads Open again at once", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port } = context;
    const opening = hold();
    port.open.mockImplementationOnce(() => opening.promise);
    const attempt = await startWaiting(context);

    const pending = attempt.openSignInPage();

    expect(attempt.read()).toMatchObject({ step: { kind: "waiting", opened: true } });
    opening.resolve();
    await pending;
  });

  it("retires the attempt at the close request: a return that arrives in the same tick finishes nothing, and a late open failure shows nothing", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, spies } = context;
    let failOpen!: (error: unknown) => void;
    port.open.mockImplementationOnce(
      () =>
        new Promise<void>((_done, fail) => {
          failOpen = fail;
        }),
    );
    const attempt = await startWaiting(context);
    const pending = attempt.openSignInPage();

    // The result lands and the close request comes in one tick, before any continuation runs.
    port.waits[0]!.resolve({ kind: "received", callbackQuery: "code=x&state=y" });
    attempt.close();
    expect(attempt.read().kind).toBe("ended");
    failOpen(new Error("no browser"));
    await pending;
    await flush();

    expect(spies.finishSignIn).not.toHaveBeenCalled();
    expect(attempt.read()).toMatchObject({ kind: "ended", reason: "closed" });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
  });

  it("goes back to the form on Cancel, closes the listener, and ignores a return that comes late", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, spies } = context;
    const attempt = await startWaiting(context);

    attempt.cancelSignIn();
    port.waits[0]!.resolve({ kind: "received", callbackQuery: "code=x&state=y" });
    await flush();

    expect(attempt.read()).toEqual({ kind: "form", problem: null });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(spies.finishSignIn).not.toHaveBeenCalled();
  });

  it("closes the listener when the dialog closes, and a return that comes late finishes nothing", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, spies, open } = context;
    const first = await startWaiting(context);
    const second = open(TOKEN_OF_DOCS);

    first.close();
    port.waits[0]!.resolve({ kind: "received", callbackQuery: "code=x&state=y" });
    await flush();

    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(spies.finishSignIn).not.toHaveBeenCalled();
    // A dialog opened afterwards is not reached by the closed one's return.
    expect(second.read()).toEqual({ kind: "form", problem: null });
  });

  it("says the browser did not come back in time, and starts again on request", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, waitForStep } = context;
    const attempt = await startWaiting(context);

    port.waits[0]!.resolve({ kind: "timed-out" });

    expect((await waitForStep(attempt, "refused")).step).toMatchObject({
      reason: "timed-out",
      message: "The browser did not come back within 10 minutes. Start again.",
    });
    await attempt.startSignIn();
    await waitForStep(attempt, "waiting");
    expect(port.listen).toHaveBeenCalledTimes(2);
  });

  it("ends the sign-in when the listener was ended by someone else", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, waitForStep } = context;
    const attempt = await startWaiting(context);

    port.waits[0]!.resolve({ kind: "cancelled" });

    expect((await waitForStep(attempt, "refused")).step).toMatchObject({ reason: "failed" });
  });

  it("goes back to what it showed before, after a refusal and a second start, when the user cancels", async () => {
    const context = await setupUrlServers();
    const { open, refuse, change, waitForOutcome, waitForStep } = context;
    const attempt = open(ADD);
    attempt.submitAdd({ address: ADDRESS, typedName: null });
    await waitForOutcome(attempt, "checking");
    change(DOCS_ID, oauthServer());
    await waitForOutcome(attempt, "needs-token");
    refuse(ROUTES.startSignIn(DOCS_ID), "internal", "The network is down.");
    await attempt.startSignIn();
    await waitForStep(attempt, "refused");

    await attempt.startSignIn();
    await waitForStep(attempt, "waiting");
    attempt.cancelSignIn();

    expect(attempt.read()).toMatchObject({
      kind: "following",
      outcome: { kind: "needs-token", refusedWrite: null },
    });
  });
});

describe("a sign-in whose server changes while it runs", () => {
  it("ends a waiting sign-in when the list shows the server deleted, retires the listener, and finishes nothing when the browser returns after it", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, spies, world, readList } = context;
    const attempt = await startWaiting(context);

    world.servers = [];
    await readList();

    expect(attempt.read()).toEqual({
      kind: "ended",
      reason: "gone",
      mcpServerId: DOCS_ID,
      name: "docs",
      message: null,
    });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    port.waits[0]!.resolve({ kind: "received", callbackQuery: "code=x&state=y" });
    await flush();
    expect(spies.finishSignIn).not.toHaveBeenCalled();
    expect(attempt.read()).toMatchObject({ kind: "ended", reason: "gone" });
  });

  it("does the same for an Add whose create was acknowledged, and for a server that moved onto a Connection", async () => {
    const context = await setupUrlServers();
    const { open, change, port, spies, world, readList, waitForOutcome, waitForStep } = context;
    const attempt = open(ADD);
    attempt.submitAdd({ address: ADDRESS, typedName: null });
    await waitForOutcome(attempt, "checking");
    change(DOCS_ID, oauthServer());
    await waitForOutcome(attempt, "needs-token");
    await attempt.startSignIn();
    await waitForStep(attempt, "waiting");

    world.servers = [buildServer(DOCS_ID, "docs", CONNECTION_ID)];
    await readList();

    expect(attempt.read()).toMatchObject({ kind: "ended", reason: "moved", name: "docs" });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    port.waits[0]!.resolve({ kind: "received", callbackQuery: "code=x&state=y" });
    await flush();
    expect(spies.finishSignIn).not.toHaveBeenCalled();
    // Cancel does not lead back to a form of a server that has no token form now.
    attempt.cancelSignIn();
    expect(attempt.read()).toMatchObject({ kind: "ended", reason: "moved" });
  });

  it("keeps waiting when the list shows the server under another name", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { world, readList } = context;
    const attempt = await startWaiting(context);

    world.servers = [oauthServer({ name: "renamed" })];
    await readList();

    expect(attempt.read()).toMatchObject({ kind: "signing-in", step: { kind: "waiting" } });
  });

  it("ends a sign-in that is still starting, and closes the listener that was opened for it", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { open, port, world, readList, holdAnswer, waitForStep } = context;
    const answer = holdAnswer(ROUTES.startSignIn(DOCS_ID));
    const attempt = open(TOKEN_OF_DOCS);
    const starting = attempt.startSignIn();
    await waitForStep(attempt, "starting");
    await answer.answered;

    world.servers = [];
    await readList();
    answer.release();
    await starting;

    expect(attempt.read()).toMatchObject({ kind: "ended", reason: "gone" });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(port.waits).toHaveLength(0);
  });

  it("leaves a sign-in that is being finished to its own write", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, world, readList, holdAnswer, waitForStep } = context;
    const attempt = await startWaiting(context);
    const finish = holdAnswer(ROUTES.finishSignIn(DOCS_ID));
    port.waits[0]!.resolve({
      kind: "received",
      callbackQuery: buildCallbackQuery(waitingAuthorizationUrl(world)),
    });
    await waitForStep(attempt, "finishing");

    world.servers = [];
    await readList();

    expect(attempt.read()).toMatchObject({ kind: "signing-in", step: { kind: "finishing" } });
    finish.release();
  });

  it("reads the server again when the dialog closed during the finish, and shows nothing of it", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, world, queryClient, holdAnswer, waitForStep } = context;
    queryClient.setQueryData(["mcp-server", DOCS_ID], oauthServer());
    const attempt = await startWaiting(context);
    const finish = holdAnswer(ROUTES.finishSignIn(DOCS_ID));
    port.waits[0]!.resolve({
      kind: "received",
      callbackQuery: buildCallbackQuery(waitingAuthorizationUrl(world)),
    });
    await waitForStep(attempt, "finishing");

    attempt.close();
    finish.release();

    await vi.waitFor(() => {
      expect(queryClient.getQueryState(["mcp-server", DOCS_ID])?.isInvalidated).toBe(true);
    });
    expect(attempt.read()).toMatchObject({ kind: "ended", reason: "closed" });
  });
});

describe("the browser sign-in of the web app", () => {
  it("starts the sign-in with an address nothing listens on and waits for the pasted address", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()], withPort: false });
    const { open, spies, waitForStep } = context;
    const attempt = open(TOKEN_OF_DOCS);

    await attempt.startSignIn();

    expect((await waitForStep(attempt, "waiting")).step).toMatchObject({
      returnBy: "paste",
      approvalHost: AUTHORIZATION_HOST,
    });
    const sent = spies.startSignIn.mock.calls[0] as unknown as [
      { payload: { redirectUri: string } },
    ];
    expect(sent[0].payload.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("records the press on the sign-in link, which the browser opens itself", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()], withPort: false });
    const attempt = await startWaiting(context);

    await attempt.openSignInPage();

    expect(attempt.read()).toMatchObject({ step: { kind: "waiting", opened: true } });
  });

  it("refuses a pasted text that is not a redirect answer without sending it, and keeps waiting", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()], withPort: false });
    const { spies } = context;
    const attempt = await startWaiting(context);

    await attempt.finishSignInByPaste("https://example.com/nothing");

    expect(spies.finishSignIn).not.toHaveBeenCalled();
    expect(attempt.read()).toMatchObject({
      step: {
        kind: "waiting",
        pasteProblem: expect.stringContaining("That is not what the browser ended on") as string,
      },
    });
  });

  it("keeps waiting, with the controller's words, when it finds the pasted address is for another redirect", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()], withPort: false });
    const { world } = context;
    const attempt = await startWaiting(context);
    const state = buildCallbackQuery(waitingAuthorizationUrl(world));

    await attempt.finishSignInByPaste(`http://127.0.0.1:9/elsewhere?${state}`);

    expect(attempt.read()).toMatchObject({
      step: {
        kind: "waiting",
        pasteProblem: expect.stringContaining("not the redirect address") as string,
      },
    });
  });

  it("follows the server after a pasted address, and ends an Add with the new server's footer", async () => {
    const context = await setupUrlServers({ withPort: false });
    const { open, change, world, waitForOutcome, waitForStep } = context;
    const attempt = open(ADD);
    attempt.submitAdd({ address: ADDRESS, typedName: null });
    await waitForOutcome(attempt, "checking");
    change(DOCS_ID, oauthServer());
    await waitForOutcome(attempt, "needs-token");
    await attempt.startSignIn();
    await waitForStep(attempt, "waiting");

    await attempt.finishSignInByPaste(buildCallbackQuery(waitingAuthorizationUrl(world)));
    await waitForOutcome(attempt, "checking");
    change(DOCS_ID, { status: "ready", tools: [{ name: "search", description: "Searches." }] });
    await waitForOutcome(attempt, "ready");

    expect(attempt.read()).toMatchObject({
      outcome: { kind: "ready", toolCount: 1, newServer: true },
    });
  });
});

describe("the authorization address", () => {
  it.each([
    ["not an address", "not an address"],
    ["not a web address", "javascript:alert(1)"],
    ["an address with a password", "https://user:secret@auth.docs.example/authorize"],
  ])("refuses %s before anything opens, and closes the listener", async (_name, address) => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { open, onNext, port } = context;
    onNext(ROUTES.startSignIn(DOCS_ID), () =>
      Promise.resolve({
        body: { authorizationUrl: address, expiresAt: "2026-11-23T10:10:00.000Z" },
      }),
    );
    const attempt = open(TOKEN_OF_DOCS);

    await attempt.startSignIn();
    await attempt.openSignInPage();

    expect(attempt.read()).toMatchObject({ step: { kind: "refused", reason: "failed" } });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    expect(port.waits).toHaveLength(0);
    expect(port.open).not.toHaveBeenCalled();
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
    const { open, port, refuse, waitForStep } = await setupUrlServers({
      servers: [oauthServer()],
    });
    refuse(ROUTES.startSignIn(DOCS_ID), "invalid_state", "The controller's words.", { reason });
    const attempt = open(TOKEN_OF_DOCS);

    await attempt.startSignIn();

    expect((await waitForStep(attempt, "refused")).step).toMatchObject({ reason, message });
    expect(port.cancel).toHaveBeenCalledWith("l-1");
    await attempt.startSignIn();
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
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, refuse, waitForStep } = context;
    const attempt = await startWaiting(context);
    refuse(ROUTES.finishSignIn(DOCS_ID), "invalid_state", "The controller's words.", { reason });

    port.waits[0]!.resolve({ kind: "received", callbackQuery: "code=x&state=y" });

    expect((await waitForStep(attempt, "refused")).step).toMatchObject({ reason, message });
  });

  it("says the sign-in ran out when the controller no longer knows its state", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, waitForStep } = context;
    const attempt = await startWaiting(context);

    port.waits[0]!.resolve({ kind: "received", callbackQuery: "code=x&state=another" });

    expect((await waitForStep(attempt, "refused")).step).toMatchObject({
      reason: "sign-in-expired",
    });
  });

  it("goes back to the token form, saying only a token works, when the controller finds no sign-in through the browser works", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()] });
    const { port, refuse } = context;
    const attempt = await startWaiting(context);
    refuse(ROUTES.finishSignIn(DOCS_ID), "invalid_state", "x", { reason: "sign-in-unsupported" });

    port.waits[0]!.resolve({ kind: "received", callbackQuery: "code=x&state=y" });

    await vi.waitFor(() => {
      expect(attempt.read()).toEqual({
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
    const context = await setupUrlServers({ withPort: false });
    const { open, change, waitForOutcome } = context;
    const attempt = open(ADD);
    attempt.submitAdd({ address: ADDRESS, typedName: null });
    await waitForOutcome(attempt, "checking");
    // The server offers a token only, which the controller's own rule refuses to sign in through the browser.
    change(DOCS_ID, {
      status: "needs-sign-in",
      source: { kind: "url", url: ADDRESS, signIn: "none", signInOffered: "token" },
    });
    await waitForOutcome(attempt, "needs-token");

    await attempt.startSignIn();

    await vi.waitFor(() => {
      expect(attempt.read()).toMatchObject({
        kind: "following",
        outcome: { kind: "needs-token" },
        problem: { kind: "sign-in-unsupported" },
      });
    });
  });

  it("ends the attempt when the server is gone or reached with a Connection now", async () => {
    const { open } = await setupUrlServers({
      servers: [buildServer(DOCS_ID, "docs", CONNECTION_ID)],
      withPort: false,
    });
    const gone = open({ kind: "token", mcpServerId: OTHER_ID, name: "docs" });
    await gone.startSignIn();
    expect(gone.read()).toMatchObject({ kind: "ended", reason: "gone" });

    const moved = open(TOKEN_OF_DOCS);
    await moved.startSignIn();
    expect(moved.read()).toMatchObject({
      kind: "ended",
      reason: "moved",
      message: expect.stringContaining("reached with") as string,
    });
  });

  it("says another failure in the controller's words", async () => {
    const { open, refuse, waitForStep } = await setupUrlServers({
      servers: [oauthServer()],
      withPort: false,
    });
    refuse(ROUTES.startSignIn(DOCS_ID), "internal", "The network is down.");
    const attempt = open(TOKEN_OF_DOCS);

    await attempt.startSignIn();

    expect((await waitForStep(attempt, "refused")).step).toMatchObject({
      reason: "failed",
      message: "The network is down.",
    });
  });

  it("starts nothing while another sign-in of the attempt runs", async () => {
    const context = await setupUrlServers({ servers: [oauthServer()], withPort: false });
    const attempt = await startWaiting(context);

    await attempt.startSignIn();

    expect(context.spies.startSignIn).toHaveBeenCalledTimes(1);
  });
});
