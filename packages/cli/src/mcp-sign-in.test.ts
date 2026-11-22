import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./index";
import { buildErrorEnvelope, buildId, stubFetch, stubIo, type StubRequest } from "./testing";

const SERVER_ID = buildId("aaaaaaa1");
const STATE = "state-of-this-attempt";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-mcp-sign-in-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const buildServer = (status: string) => ({
  id: SERVER_ID,
  name: "notion",
  source: { kind: "url", url: "https://mcp.notion.com/mcp", signIn: "oauth", signInOffered: null },
  enabled: true,
  status,
  statusDetail: null,
  tools: [],
  checkedAt: null,
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T10:00:00.000Z",
});

/** What the browser did at the listener: its status and the headers that matter. */
interface BrowserRequest {
  readonly status: number;
  readonly headers: Headers;
}

/**
 * Returns a stub controller for the sign-in, and a log of what the test's
 * browser got from the listener. `whenStarted` is the browser's part: it runs
 * after the controller has answered `startSignIn`, with the address the
 * attempt was told to return to.
 */
const stubController = (options: {
  readonly expiresInMs?: number;
  readonly whenStarted?: (redirectUri: string) => Promise<void>;
  readonly finish?: (request: StubRequest) => unknown;
}) => {
  const browser: Array<BrowserRequest> = [];
  let redirectUri = "";
  let authorizationUrl = "";
  let listenerClosedWhenFinishing: boolean | undefined;
  let browserDone: Promise<void> = Promise.resolve();
  const stub = stubFetch((request) => {
    if (request.method === "GET" && request.path === "/api/v1/mcp-servers") {
      return { items: [buildServer("needs-sign-in")] };
    }
    if (request.path === `/api/v1/mcp-servers/${SERVER_ID}/sign-in`) {
      redirectUri = (request.body as { redirectUri: string }).redirectUri;
      // The browser acts after this answer is returned, as a person would.
      browserDone = new Promise((resolve) => {
        setTimeout(() => {
          void (options.whenStarted?.(redirectUri) ?? Promise.resolve()).finally(resolve);
        }, 20);
      });
      authorizationUrl = `https://auth.test/authorize?client_id=c&state=${STATE}`;
      return {
        authorizationUrl,
        expiresAt: new Date(Date.now() + (options.expiresInMs ?? 60_000)).toISOString(),
      };
    }
    if (request.path === `/api/v1/mcp-servers/${SERVER_ID}/sign-in/finish`) {
      return options.finish?.(request) ?? buildServer("checking");
    }
    return {};
  });
  // Looks at the listener at the moment the CLI asks the controller to finish.
  const fetch = Object.assign(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/sign-in/finish")) {
        listenerClosedWhenFinishing = await isClosed(redirectUri);
      }
      return stub(url, init);
    },
    { calls: stub.calls },
  );
  return {
    fetch,
    browser,
    getRedirectUri: () => redirectUri,
    /** The `state` of the attempt, as the controller's answer to `startSignIn` carried it. */
    getState: () => new URL(authorizationUrl).searchParams.get("state") ?? "",
    /** Whether nothing listened any more when the CLI asked the controller to finish. */
    wasListenerClosedWhenFinishing: () => listenerClosedWhenFinishing,
    /** Resolves when the browser's part has ended, so a test reads what it recorded. */
    settleBrowser: () => browserDone,
  };
};

/** Requests `path` on the listener the way a browser would, and records the answer. */
const visit = async (
  browser: Array<BrowserRequest>,
  redirectUri: string,
  path: string,
  method = "GET",
): Promise<void> => {
  const answer = await globalThis.fetch(new URL(path, redirectUri), { method });
  await answer.text();
  browser.push({ status: answer.status, headers: answer.headers });
};

const run = (io: ReturnType<typeof stubIo>, ...argv: ReadonlyArray<string>) =>
  main(["--home", home, "mcp-server", "sign-in", ...argv], io);

const ioFor = (fetch: ReturnType<typeof stubFetch>, options: { stdin?: string } = {}) =>
  stubIo({
    env: { HERCULE_TOKEN: "test-token", HERCULE_API_URL: "http://controller.test" },
    fetch,
    ...options,
  });

/** Returns true when nothing listens at the address any more. */
const isClosed = async (redirectUri: string): Promise<boolean> =>
  globalThis.fetch(redirectUri).then(
    () => false,
    () => true,
  );

describe("hercule mcp-server sign-in", () => {
  it("catches the browser's return on a listener, finishes the sign-in with its query and closes the listener", async () => {
    const controller = stubController({
      whenStarted: async (redirectUri) => {
        // A stray path, a wrong method and another attempt's state do not end the wait.
        await visit(controller.browser, redirectUri, "/favicon.ico");
        await visit(controller.browser, redirectUri, "/callback?code=c&state=state-of-another");
        await visit(controller.browser, redirectUri, "/callback");
        await visit(controller.browser, redirectUri, `/callback?code=c&state=${STATE}`, "POST");
        // A return that is not one state and one of code and error is no answer.
        await visit(controller.browser, redirectUri, `/callback?state=${STATE}`);
        await visit(
          controller.browser,
          redirectUri,
          `/callback?code=c&state=${STATE}&state=${STATE}`,
        );
        await visit(controller.browser, redirectUri, `/callback?code=c&code=d&state=${STATE}`);
        await visit(controller.browser, redirectUri, `/callback?code=c&error=x&state=${STATE}`);
        await visit(controller.browser, redirectUri, `/callback?code=the-code&state=${STATE}`);
      },
    });
    const io = ioFor(controller.fetch);

    expect(await run(io, SERVER_ID)).toBe(0);
    await controller.settleBrowser();

    expect(controller.browser.map((request) => request.status)).toEqual([
      404, 404, 404, 404, 404, 404, 404, 404, 200,
    ]);
    const answered = controller.browser[8]!.headers;
    expect(answered.get("cache-control")).toBe("no-store");
    expect(answered.get("referrer-policy")).toBe("no-referrer");

    const calls = controller.fetch.calls.filter((call) => call.method === "POST");
    expect(calls.map((call) => call.path)).toEqual([
      `/api/v1/mcp-servers/${SERVER_ID}/sign-in`,
      `/api/v1/mcp-servers/${SERVER_ID}/sign-in/finish`,
    ]);
    expect(controller.getRedirectUri()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(calls[1]?.body).toEqual({ callbackQuery: `code=the-code&state=${STATE}` });

    const out = io.stdout.join("\n");
    expect(out).toContain(`https://auth.test/authorize?client_id=c&state=${STATE}`);
    expect(out).toContain("Press Ctrl-C to cancel");
    expect(out).toContain("--paste");
    expect(out).toContain("Signed in. notion is checking.");
    expect(out).toContain("hercule mcp-server read aaaaaaa1");
    expect(await isClosed(controller.getRedirectUri())).toBe(true);
    expect(controller.wasListenerClosedWhenFinishing()).toBe(true);
  });

  it("prints the server as JSON on stdout, and the instructions on stderr, with --json", async () => {
    const controller = stubController({
      whenStarted: (redirectUri) =>
        visit(controller.browser, redirectUri, `/callback?code=c&state=${STATE}`),
    });
    const io = ioFor(controller.fetch);

    expect(await run(io, SERVER_ID, "--json")).toBe(0);

    expect(JSON.parse(io.stdout.join("\n"))).toMatchObject({ id: SERVER_ID, status: "checking" });
    expect(io.stderr.join("\n")).toContain("Open this address in your browser");
  });

  it("fails when the time runs out, says to run the command again, and closes the listener", async () => {
    const controller = stubController({ expiresInMs: 150 });
    const io = ioFor(controller.fetch);

    expect(await run(io, SERVER_ID)).toBe(1);

    expect(io.stderr.join("\n")).toContain(
      `hercule: The sign-in expired before your browser came back. Run \`hercule mcp-server sign-in ${SERVER_ID}\` again.`,
    );
    expect(controller.fetch.calls.some((call) => call.path.endsWith("/finish"))).toBe(false);
    expect(await isClosed(controller.getRedirectUri())).toBe(true);
  });

  it("prints the controller's refusal and exits 1, closing the listener", async () => {
    const controller = stubController({
      whenStarted: (redirectUri) =>
        visit(controller.browser, redirectUri, `/callback?error=access_denied&state=${STATE}`),
      finish: () =>
        buildErrorEnvelope("invalid_state", 409, "The authorization server refused the sign-in.", {
          reason: "sign-in-refused",
        }),
    });
    const io = ioFor(controller.fetch);

    expect(await run(io, SERVER_ID)).toBe(1);

    expect(io.stderr).toEqual(["hercule: The authorization server refused the sign-in."]);
    expect(await isClosed(controller.getRedirectUri())).toBe(true);
  });

  it("adds the advice to run the command again when the controller says the sign-in expired", async () => {
    const controller = stubController({
      whenStarted: (redirectUri) =>
        visit(controller.browser, redirectUri, `/callback?code=c&state=${STATE}`),
      finish: () =>
        buildErrorEnvelope("invalid_state", 409, "The sign-in expired.", {
          reason: "sign-in-expired",
        }),
    });
    const io = ioFor(controller.fetch);

    expect(await run(io, SERVER_ID)).toBe(1);

    expect(io.stderr).toEqual([
      `hercule: The sign-in expired. Run \`hercule mcp-server sign-in ${SERVER_ID}\` again.`,
    ]);
  });

  it("resolves a tail of the id through the server list", async () => {
    const controller = stubController({
      whenStarted: (redirectUri) =>
        visit(controller.browser, redirectUri, `/callback?code=c&state=${STATE}`),
    });
    const io = ioFor(controller.fetch);

    expect(await run(io, "aaaaaaa1")).toBe(0);

    expect(controller.fetch.calls[0]?.path).toBe("/api/v1/mcp-servers");
    expect(controller.fetch.calls[1]?.path).toBe(`/api/v1/mcp-servers/${SERVER_ID}/sign-in`);
  });
});

describe("hercule mcp-server sign-in --paste", () => {
  it("reads the pasted address from stdin, with no listener, and finishes the sign-in with it", async () => {
    const controller = stubController({});
    // The user's browser ends on the redirect URI the attempt was started
    // with, carrying the state of the address it was sent to.
    const io = {
      ...ioFor(controller.fetch),
      stdin: () =>
        Promise.resolve(
          `${controller.getRedirectUri()}?code=the-code&state=${controller.getState()}\n`,
        ),
    };

    expect(await run(io, SERVER_ID, "--paste")).toBe(0);

    const calls = controller.fetch.calls.filter((call) => call.method === "POST");
    const redirectUri = (calls[0]?.body as { redirectUri: string }).redirectUri;
    const port = Number(new URL(redirectUri).port);
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
    expect(calls[1]?.body).toEqual({
      callbackQuery: `${redirectUri}?code=the-code&state=${STATE}`,
    });
    expect(io.stdout.join("\n")).toContain("fails to load a page on 127.0.0.1");
    expect(io.stdout.join("\n")).toContain("Signed in. notion is checking.");
  });

  it("gives up waiting for the address when the attempt expires, and says to run the command again", async () => {
    const controller = stubController({ expiresInMs: 150 });
    // Stdin never ends, as a terminal that nobody types into.
    const io = { ...ioFor(controller.fetch), stdin: () => new Promise<string>(() => undefined) };

    expect(await run(io, SERVER_ID, "--paste")).toBe(1);

    expect(io.stderr.join("\n")).toContain(
      `hercule: The sign-in expired before you gave the address. Run \`hercule mcp-server sign-in ${SERVER_ID} --paste\` again.`,
    );
    expect(controller.fetch.calls.some((call) => call.path.endsWith("/finish"))).toBe(false);
  });

  it("refuses at a terminal before anything is sent, never prompting", async () => {
    const controller = stubController({});
    const io = stubIo({
      env: { HERCULE_TOKEN: "test-token", HERCULE_API_URL: "http://controller.test" },
      fetch: controller.fetch,
      tty: true,
    });

    expect(await run(io, SERVER_ID, "--paste")).toBe(2);

    expect(controller.fetch.calls).toEqual([]);
    expect(io.prompts).toEqual([]);
    expect(io.stderr.join("\n")).toContain("cat | hercule mcp-server sign-in <id> --paste");
  });

  it("refuses an empty stdin as a usage error", async () => {
    const controller = stubController({});
    const io = ioFor(controller.fetch, { stdin: "\n" });

    expect(await run(io, SERVER_ID, "--paste")).toBe(2);

    expect(io.stderr.join("\n")).toContain("no address was given on stdin");
    expect(controller.fetch.calls.some((call) => call.path.endsWith("/finish"))).toBe(false);
  });
});

describe("hercule mcp-server sign-in --help", () => {
  it("lists --paste with the flags and keeps the table's help and operation line", async () => {
    const io = stubIo();

    expect(await main(["--home", home, "mcp-server", "sign-in", "--help"], io)).toBe(0);

    const help = io.stdout.join("\n");
    expect(help).toContain("usage: hercule mcp-server sign-in <id> [flags]");
    expect(help).toContain("--paste");
    expect(help).toContain("cat | hercule mcp-server sign-in <id> --paste");
    expect(help).toContain("operation mcpServer.startSignIn");
    // It says what the command prints, not what `startSignIn` answers.
    expect(help.replace(/\s+/g, " ")).toContain("Signed in. <name> is <status>.");
    expect(help).not.toContain("authorizationUrl");
    expect(help).not.toContain("expiresAt");
    expect(help).not.toContain("redirectUri");
  });

  it("refuses an unknown flag as a usage error", async () => {
    const io = ioFor(stubFetch(() => ({})));
    expect(await run(io, SERVER_ID, "--browser")).toBe(2);
    expect(io.stderr.join("\n")).toContain("unknown flag --browser");
  });
});
