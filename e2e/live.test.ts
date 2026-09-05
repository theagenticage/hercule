/**
 * Live topics out of the release binary.
 *
 * The socket is the one part of the live overlay that no unit test can prove:
 * `client-core`'s tests drive a stub `WebSocket` and the controller's drive an
 * in-process RPC client. This suite runs `./hydra` as the controller and as the
 * CLI, and puts a real `client-core` live client - real ticket fetch, real
 * WebSocket, real greeting - between them, so a `hydra task create` in one
 * process has to reach a subscriber in another. `pnpm build:binary` first, then
 * `pnpm test:binary`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, createLive, queryKeysFor } from "../packages/client-core/src/index";
import type { LiveQueryKey } from "../packages/client-core/src/index";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  cli,
  completeSetup,
  jsonOf,
  startController,
  temporaryHome,
  type Controller,
} from "./harness";

const state = temporaryHome();
const binary = join(ROOT, "hydra");

let controller: Controller;
let url: string;
/** The token `hydra login` wrote, which is what a client of the same home holds. */
let token: string;

/** The CLI, as the binary, under the credential file the login wrote. */
const hydra = (args: ReadonlyArray<string>, stdin?: string) =>
  cli(args, { home: state.home, binary, stdin });

/** Fails with the command's own output rather than on an undefined field. */
const ok = (ran: { code: number; stdout: string; stderr: string }): unknown => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return jsonOf(ran);
};

/** Waits for something a socket delivers, and says what it was waiting for. */
const until = async (what: string, done: () => boolean): Promise<void> => {
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

  const login = await hydra(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-live"],
    PASSWORD,
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

  const credentials = JSON.parse(readFileSync(join(state.home, "credentials.json"), "utf8")) as {
    readonly url: string;
    readonly apiKey: string;
  };
  token = credentials.apiKey;
}, 90_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state.remove();
});

describe("the binary serving live topics", () => {
  it("stops when it is told to, although a socket is still open", async () => {
    // A watched controller always has an open socket, and the listener's drain
    // waits for every connection, so without a deadline `hydra serve` could not
    // be stopped while anybody was looking at it.
    const home = temporaryHome();
    let its: Controller | undefined;
    try {
      its = await startController({ home: home.home, binary });
      const completed = await completeSetup({ home: home.home, url: its.url, binary });
      expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

      // Nothing is said on it: an upgraded connection is enough to hold a drain,
      // and one that never greets is the worst case.
      const socket = new WebSocket(`${its.url.replace(/^http/, "ws")}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("the socket never opened")), {
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

  it("prints a ws ticket", async () => {
    const ran = await hydra(["auth", "wsTicket", "--json"]);
    const ticket = ok(ran) as { readonly ticket: string };
    expect(typeof ticket.ticket).toBe("string");
    expect(ticket.ticket.length).toBeGreaterThanOrEqual(43);
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
      // The greeting sweeps every mutable subscription, so the first call is
      // how this test knows the socket is up before the CLI mutates anything.
      await until("the connection to greet", () => calls.length > 0);
      const greeted = calls.length;

      const created = ok(
        await hydra([
          "task",
          "create",
          "--title",
          "live from the binary",
          "--description",
          "",
          "--json",
        ]),
      ) as { readonly id: string };

      await until("the task invalidation", () => calls.length > greeted);
      expect(calls[greeted]).toEqual(queryKeysFor("task", [created.id]));
    } finally {
      unsubscribe();
      await live.stop();
    }
  }, 60_000);
});
