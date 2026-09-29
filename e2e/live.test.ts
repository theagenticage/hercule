/**
 * Tests live topics through the release binary.
 *
 * The socket is the only part of the live overlay that no unit test can prove:
 * `client-core`'s tests use a stub `WebSocket` and the controller's tests use
 * an in-process RPC client. This suite runs `./hercule` as the controller and
 * as the CLI, and puts a real `client-core` live client - real ticket fetch,
 * real WebSocket, real greeting - between them, so a `hercule task create` in
 * one process has to reach a subscriber in another. `pnpm build:binary` first,
 * then `pnpm test:binary`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, createLive, buildQueryKeys } from "../packages/client-core/src/index";
import type { LiveQueryKey } from "../packages/client-core/src/index";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  runCli,
  completeSetup,
  startController,
  type Controller,
} from "../scripts/controller-process";
import { readApiKey, parseJsonOutput, createTemporaryHome } from "./harness";

const state = createTemporaryHome();
const binary = join(ROOT, "hercule");

let controller: Controller;
let url: string;
/** The token `hercule login` wrote, which a client using the same home holds. */
let token: string;

/** Runs the CLI binary with the credential file the login wrote. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/**
 * Parses a command's JSON output. Fails with the command's own output, rather
 * than later on an undefined field.
 */
const expectJsonOutput = (ran: { code: number; stdout: string; stderr: string }): unknown => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return parseJsonOutput(ran);
};

/**
 * Waits for something a socket delivers. On timeout, the error includes what
 * it was waiting for.
 */
const waitUntil = async (what: string, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

beforeAll(async () => {
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  controller = await startController({ home: state.home, binary });
  url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

  const login = await runLoggedInCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-live"],
    PASSWORD,
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

  token = readApiKey(state.home);
}, 90_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state.remove();
});

describe("the binary serving live topics", () => {
  it("stops when asked to, even though a socket is still open", async () => {
    // A controller someone is watching always has an open socket, and the
    // listener's drain waits for every connection, so without a deadline
    // `hercule serve` could not be stopped while anybody was watching it.
    const home = createTemporaryHome();
    let its: Controller | undefined;
    try {
      its = await startController({ home: home.home, binary });
      const completed = await completeSetup({ home: home.home, url: its.url, binary });
      expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

      // Nothing is sent on it: an upgraded connection is enough to block a
      // drain, and one that never sends a greeting is the worst case.
      const socket = new WebSocket(`${its.url.replace(/^http/, "ws")}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("the socket did not open")), {
          once: true,
        });
      });

      const stopping = its;
      const began = Date.now();
      const code = await stopping.stop();
      const took = Date.now() - began;
      its = undefined;

      expect(code, stopping.output()).toBe(0);
      expect(took, "the drain never gave up on the open socket").toBeLessThan(25_000);
      expect(stopping.output()).toContain("Connections were still open");
    } finally {
      await its?.stop().catch(() => -1);
      home.remove();
    }
  }, 60_000);

  it("creates a ws ticket over HTTP, and has no command for it", async () => {
    // The ticket is for the web app, so its operation is hidden from the CLI:
    // the route is called the way the web app calls it, with the key the login
    // created.
    const response = await fetch(`${url}/api/v1/auth/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const ticket = (await response.json()) as { readonly ticket: string };
    expect(typeof ticket.ticket).toBe("string");
    expect(ticket.ticket.length).toBeGreaterThanOrEqual(43);

    // Hidden means absent, not just undocumented: the command is unknown.
    const ran = await runLoggedInCli(["auth", "ws-ticket", "--json"]);
    expect(ran.code).toBe(2);
  }, 30_000);

  it("delivers the created task's query keys to a client-core subscriber", async () => {
    const client = createClient({ baseUrl: url, token });
    const live = createLive({ client, baseUrl: url });
    const calls: Array<ReadonlyArray<LiveQueryKey>> = [];

    live.start();
    const unsubscribe = live.subscribe("task", (keys) => {
      calls.push(keys);
    });

    try {
      // The greeting refreshes every mutable subscription, so the first call
      // tells this test that the socket is up before the CLI changes anything.
      await waitUntil("the connection to greet", () => calls.length > 0);
      const greeted = calls.length;

      const created = expectJsonOutput(
        await runLoggedInCli(["task", "create", "--title", "live from the binary", "--json"], ""),
      ) as { readonly id: string };

      await waitUntil("the task invalidation", () => calls.length > greeted);
      expect(calls[greeted]).toEqual(buildQueryKeys("task", [created.id]));
    } finally {
      unsubscribe();
      await live.stop();
    }
  }, 60_000);
});
