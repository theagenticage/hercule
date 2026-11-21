/**
 * Runs proof.ts end to end against the local fake. Run with `bun test .scratch/oauth-proof/`.
 * Each test starts its own fake, so tests do not share clients or tokens.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeHandle, startFake } from "./fake-as.ts";

const proof = join(import.meta.dir, "proof.ts");

let fake: FakeHandle;
let dir: string;
let catchers: Catcher[];
const stateFile = () => join(dir, "attempt.json");
const clientFile = () => join(dir, "client.json");

beforeEach(() => {
  fake = startFake();
  dir = mkdtempSync(join(tmpdir(), "oauth-proof-test-"));
  catchers = [];
});

afterEach(async () => {
  for (const catcher of catchers) catcher.process.kill();
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs `bun proof.ts <args>` and collects what it printed. */
async function run(args: string[], stdin?: string): Promise<Run> {
  const process = Bun.spawn(["bun", proof, ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code: await process.exited, out, err };
}

interface Catcher {
  port: number;
  process: ReturnType<typeof Bun.spawn>;
  /** Waits for the catcher to exit and returns the query string it printed. */
  query(): Promise<string>;
}

/** Starts `catch` on an ephemeral port and waits until it prints that port. */
async function startCatcher(): Promise<Catcher> {
  const process = Bun.spawn(["bun", proof, "catch"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const reader = (process.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let output = "";
  let port = 0;
  while (!port) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`catch exited early: ${output}`);
    output += decoder.decode(value, { stream: true });
    port = Number(/^(\d+)$/m.exec(output)?.[1] ?? 0);
  }
  const rest = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      output += decoder.decode(value, { stream: true });
    }
  })();
  const catcher: Catcher = {
    port,
    process,
    async query() {
      await rest;
      await process.exited;
      const match = /=====\n(.*)\n===== END =====/s.exec(output);
      if (!match) throw new Error("the catcher printed no query");
      return match[1]!;
    },
  };
  catchers.push(catcher);
  return catcher;
}

interface Attempt {
  startRun: Run;
  authorizeUrl: string;
  catcher: Catcher;
}

/** Runs `start` against the fake, with a catcher on a fresh port. */
async function startAttempt(extra: string[] = []): Promise<Attempt> {
  const catcher = await startCatcher();
  const startRun = await run([
    "start", "--server", fake.serverUrl, "--redirect-port", String(catcher.port),
    "--state-file", stateFile(), "--client-file", clientFile(), ...extra,
  ]);
  expect(startRun.err).toBe("");
  expect(startRun.code).toBe(0);
  const authorizeUrl = /^(http\S+\/authorize\?\S+)$/m.exec(startRun.out)?.[1];
  if (!authorizeUrl) throw new Error("start printed no authorization URL");
  return { startRun, authorizeUrl, catcher };
}

/** Plays the browser: opens the authorization URL, then follows the redirect to the catcher. */
async function browse(attempt: Attempt): Promise<{ status: number; query?: string }> {
  const authorized = await fetch(attempt.authorizeUrl, { redirect: "manual" });
  if (authorized.status !== 302) return { status: authorized.status };
  const landed = await fetch(authorized.headers.get("location")!);
  expect(await landed.text()).toContain("Sign-in received. You can close this tab.");
  return { status: 302, query: await attempt.catcher.query() };
}

function parseReport(out: string): any {
  return JSON.parse(out.slice(out.indexOf("=== REPORT ===") + "=== REPORT ===".length));
}

/** Fails if any secret the fake issued, or the PKCE verifier, shows up in the given output. */
function expectNoSecrets(texts: string[], verifier: string) {
  const secrets = [...fake.issued.codes, ...fake.issued.accessTokens, ...fake.issued.refreshTokens, verifier];
  expect(secrets.length).toBeGreaterThan(1);
  for (const text of texts) for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("sign-in split over catch, start and finish", () => {
  for (const registration of ["dcr-portless", "dcr-exact"] as const) {
    test(`succeeds with ${registration}, every verdict true, no secret printed`, async () => {
      const attempt = await startAttempt(["--registration", registration]);
      const saved = JSON.parse(readFileSync(stateFile(), "utf8"));
      expect(statSync(stateFile()).mode & 0o777).toBe(0o600);
      expect(statSync(clientFile()).mode & 0o777).toBe(0o600);

      const browsed = await browse(attempt);
      expect(browsed.query).toContain("code=");
      expect(browsed.query).toContain("iss=");

      const finished = await run(["finish", "--state-file", stateFile()], browsed.query);
      expect(finished.err).toBe("");
      expect(finished.code).toBe(0);
      const report = parseReport(finished.out);
      expect(report.verdicts).toEqual({
        discovery: true,
        registration: true,
        authorizationRedirectAccepted: true,
        issChecked: true,
        codeExchangedOnController: true,
        toolsListed: true,
        refreshWorked: true,
      });
      expect(report.mcp.toolCount).toBe(3);
      expect(report.mcp.toolPageFormats).toEqual(["json", "sse"]);
      expect(report.mcp.protocolVersion).toBe("2025-11-25");
      expect(report.mcp.deleteStatus).toBe(204);
      expect(report.refresh.refreshTokenRotated).toBe(true);
      expect(report.refresh.toolCountAfterRefresh).toBe(3);
      expect(report.registrationMode).toBe(registration);
      expect(report.redirectUriUsed).toBe(`http://127.0.0.1:${attempt.catcher.port}/callback`);
      expect(report.registeredRedirectUris).toEqual([
        registration === "dcr-portless" ? "http://127.0.0.1/callback" : report.redirectUriUsed,
      ]);
      expect(report.clientReused).toBe(false);
      expect(existsSync(stateFile())).toBe(false);

      expectNoSecrets([attempt.startRun.out, attempt.startRun.err, finished.out, finished.err], saved.codeVerifier);
    });
  }

  test("a second run on another port reuses the client; one portless registration covers both ports", async () => {
    const first = await startAttempt();
    const firstQuery = (await browse(first)).query!;
    expect((await run(["finish", "--state-file", stateFile()], firstQuery)).code).toBe(0);

    const second = await startAttempt();
    expect(second.catcher.port).not.toBe(first.catcher.port);
    expect(second.startRun.out).toContain("reusing the client");
    const secondBrowse = await browse(second);
    expect(secondBrowse.status).toBe(302);
    const finished = await run(["finish", "--state-file", stateFile()], secondBrowse.query);
    expect(finished.code).toBe(0);
    const report = parseReport(finished.out);
    expect(report.clientReused).toBe(true);
    expect(report.redirectUriUsed).toBe(`http://127.0.0.1:${second.catcher.port}/callback`);
    expect(report.registeredRedirectUris).toEqual(["http://127.0.0.1/callback"]);
    expect(Object.values(report.verdicts).every((v) => v === true)).toBe(true);
  });

  describe("when the server matches redirect URIs exactly", () => {
    beforeEach(() => {
      fake.redirectMatching = "exact";
    });

    test("a portless registration is refused at the authorization step", async () => {
      const attempt = await startAttempt(["--registration", "dcr-portless"]);
      expect((await browse(attempt)).status).toBe(400);
    });

    test("an exact registration works on its own port but run 2 on another port is refused", async () => {
      const first = await startAttempt(["--registration", "dcr-exact"]);
      const query = (await browse(first)).query!;
      expect((await run(["finish", "--state-file", stateFile()], query)).code).toBe(0);

      const second = await startAttempt();
      expect(second.startRun.out).toContain("reusing the client");
      expect((await browse(second)).status).toBe(400);
    });
  });

  test("a client file registered in one mode refuses the other mode", async () => {
    await startAttempt(["--registration", "dcr-exact"]);
    const catcher = await startCatcher();
    const again = await run([
      "start", "--server", fake.serverUrl, "--redirect-port", String(catcher.port),
      "--state-file", stateFile(), "--client-file", clientFile(), "--registration", "dcr-portless",
    ]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("client file was registered as dcr-exact");
  });

  test("a wrong state is refused before anything is sent to the server", async () => {
    const attempt = await startAttempt();
    const query = (await browse(attempt)).query!.replace(/state=[^&]*/, "state=not-the-state");
    const finished = await run(["finish", "--state-file", stateFile()], query);
    expect(finished.code).toBe(1);
    expect(finished.err).toContain("state does not match");
    expect(fake.issued.accessTokens).toEqual([]);
  });

  test("a wrong iss is refused before anything is sent to the server", async () => {
    fake.issMode = "wrong";
    const attempt = await startAttempt();
    const query = (await browse(attempt)).query!;
    const finished = await run(["finish", "--state-file", stateFile()], query);
    expect(finished.code).toBe(1);
    expect(finished.err).toContain("iss does not equal");
    expect(fake.issued.accessTokens).toEqual([]);
  });

  test("a missing iss is refused when the server promised it", async () => {
    fake.issMode = "absent";
    const attempt = await startAttempt();
    const query = (await browse(attempt)).query!;
    const finished = await run(["finish", "--state-file", stateFile()], query);
    expect(finished.code).toBe(1);
    expect(finished.err).toContain("iss is missing");
    expect(fake.issued.accessTokens).toEqual([]);
  });

  test("an error answer from the authorization server is printed and ends the attempt", async () => {
    await startAttempt();
    const finished = await run(["finish", "--state-file", stateFile(), "--query", "error=access_denied&error_description=The+user+said+no&state=x"]);
    expect(finished.code).toBe(1);
    expect(finished.out).toContain("access_denied");
    expect(finished.out).toContain("The user said no");
    expect(existsSync(stateFile())).toBe(false);
  });

  test("finish accepts a whole pasted URL", async () => {
    const attempt = await startAttempt();
    const query = (await browse(attempt)).query!;
    const finished = await run(["finish", "--state-file", stateFile()], `http://127.0.0.1:${attempt.catcher.port}/callback?${query}`);
    expect(finished.code).toBe(0);
  });

  test("the catcher answers 404 on other paths and keeps waiting", async () => {
    const catcher = await startCatcher();
    expect((await fetch(`http://127.0.0.1:${catcher.port}/other`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${catcher.port}/callback?code=a&state=b`)).status).toBe(200);
    expect(await catcher.query()).toBe("code=a&state=b");
  });
});
