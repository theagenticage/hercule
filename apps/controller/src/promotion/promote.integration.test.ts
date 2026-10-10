/**
 * `hercule promote` against a live old controller: the whole promotion on the
 * happy path, and what each machine is left with when the transfer comes from
 * another controller than the preview showed, when the switch is refused,
 * when its answer is lost, when another machine switched first, when the old
 * controller cannot be reached after the transfer, when it is interrupted
 * before the transfer arrives, when an answer stalls, and when a controller
 * tries to start in this Home during the promotion.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { buildHomePaths, type HomePaths } from "@hercule/home";
import { openDatabase } from "../db";
import { completeSetup, get, post, readErrorBody, withServer } from "../http/testing";
import { SWITCH_PATH, TRANSFER_PATH } from "./exchange";
import { promote, type PromoteOptions } from "./promote";
import { createPromotionToken, findFreePort } from "./testing";

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * Returns a fetch that hands each request to `intercept` when its path and
 * method match, and every other request to the real fetch.
 */
const interceptFetch = (
  method: string,
  path: string,
  intercept: (input: string, init: RequestInit | undefined) => Promise<Response>,
): typeof fetch =>
  ((input: string, init?: RequestInit) =>
    (init?.method ?? "GET") === method && new URL(input).pathname === path
      ? intercept(input, init)
      : fetch(input, init)) as unknown as typeof fetch;

/** Prepares an empty Home for B and returns the options of a promotion into it. */
const preparePromotion = async (from: string, token: string, fetcher?: typeof fetch) => {
  const home = mkdtempSync(join(tmpdir(), "hercule-promote-b-"));
  homes.push(home);
  const port = await findFreePort();
  const lines: Array<string> = [];
  const options: PromoteOptions = {
    from,
    token,
    address: `http://127.0.0.1:${String(port)}`,
    paths: buildHomePaths(home, "data"),
    bindHost: "127.0.0.1",
    bindPort: port,
    backend: "file",
    confirm: undefined,
    service: undefined,
    out: (line) => lines.push(line),
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  };
  return { options, lines };
};

/** Returns a response that never arrives: it fails only once the request is aborted. */
const waitForAbort = (init: RequestInit | undefined): Promise<Response> =>
  new Promise((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
  );

const isHomeEmpty = (paths: HomePaths): boolean =>
  !existsSync(paths.databaseFile) &&
  !existsSync(join(paths.dataDir, "attachments")) &&
  !existsSync(paths.masterKeyFile);

/** Checks that A answers `controller_sealed` and points at `newAddress`. */
const expectSealed = async (base: string, user: string, newAddress: string): Promise<void> => {
  const read = await get(base, "/api/v1/controller", user);
  expect(read.status).toBe(503);
  const body = await readErrorBody(read);
  expect(body.code).toBe("controller_sealed");
  expect(body.message).toContain(newAddress);
};

/** Checks that A takes writes again: its freeze has ended and it did not seal. */
const expectServing = async (base: string, user: string): Promise<void> => {
  expect((await post(base, "/api/v1/controller/promotion-tokens", {}, user)).status).toBe(201);
};

describe("promote", () => {
  it("moves the data into this Home and seals the old controller", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const { options, lines } = await preparePromotion(harness.base, token);

      await Effect.runPromise(promote(options));

      expect(existsSync(options.paths.databaseFile)).toBe(true);
      expect(existsSync(options.paths.masterKeyFile)).toBe(true);
      expect(existsSync(options.paths.promotionTransferDir)).toBe(false);
      expect(lines.at(-1)).toBe(
        `${harness.base} is sealed. Its runners reconnect to ${options.address!}.`,
      );
      await expectSealed(harness.base, user, options.address!);
    });
  });

  it("refuses a transfer from another controller than the preview showed, and lets the old controller serve again", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const otherController = "0198e4b0-0000-7000-8000-00000000000c";
      const previewOther = interceptFetch("GET", TRANSFER_PATH, () =>
        Promise.resolve(Response.json({ controllerId: otherController, runners: [] })),
      );
      const { options } = await preparePromotion(harness.base, token, previewOther);

      const error = await Effect.runPromise(Effect.flip(promote(options)));

      expect(error.message).toContain(`but the preview showed controller ${otherController}`);
      expect(error.message).toContain(`${harness.base} serves again.`);
      expect(isHomeEmpty(options.paths)).toBe(true);
      expect(existsSync(options.paths.promotionTransferDir)).toBe(false);
      await expectServing(harness.base, user);
    });
  });

  it("empties this Home and lets the old controller serve again when it refuses the switch", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const refuseSwitch = interceptFetch("POST", SWITCH_PATH, () =>
        Promise.resolve(
          Response.json(
            { error: { code: "invalid_state", message: "this controller cannot switch now" } },
            { status: 409 },
          ),
        ),
      );
      const { options } = await preparePromotion(harness.base, token, refuseSwitch);

      const error = await Effect.runPromise(Effect.flip(promote(options)));

      expect(error.message).toContain("The switch failed: this controller cannot switch now.");
      expect(error.message).toContain(`${harness.base} serves again.`);
      expect(isHomeEmpty(options.paths)).toBe(true);
      await expectServing(harness.base, user);
    });
  });

  it("finishes when the old controller sealed but every answer to the switch was lost", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const loseAnswer = interceptFetch("POST", SWITCH_PATH, async (input, init) => {
        await (await fetch(input, init)).arrayBuffer();
        throw new TypeError("the connection closed before the answer arrived");
      });
      const { options, lines } = await preparePromotion(harness.base, token, loseAnswer);

      await Effect.runPromise(promote(options));

      expect(lines).toContain("The switch went through, although its answer was lost.");
      expect(existsSync(options.paths.databaseFile)).toBe(true);
      await expectSealed(harness.base, user, options.address!);
    });
  }, 30_000);

  it("lets the old controller serve again and empties this Home when interrupted after the transfer", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      let switchAsked!: () => void;
      const asked = new Promise<void>((resolve) => (switchAsked = resolve));
      const stallSwitch = interceptFetch("POST", SWITCH_PATH, (_input, init) => {
        switchAsked();
        return waitForAbort(init);
      });
      const { options, lines } = await preparePromotion(harness.base, token, stallSwitch);

      const fiber = Effect.runFork(promote(options));
      await asked;
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(lines.at(-1)).toContain("The promotion was interrupted.");
      expect(lines.at(-1)).toContain(`${harness.base} serves again.`);
      expect(isHomeEmpty(options.paths)).toBe(true);
      await expectServing(harness.base, user);
    });
  });

  it("settles both machines when something unexpected fails after the transfer", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const { options } = await preparePromotion(harness.base, token);
      // A throw from a plain callback is a defect, not a typed failure.
      const breakOnSwitch: PromoteOptions = {
        ...options,
        out: (line) => {
          if (line.startsWith("Asking")) throw new Error("a bug in this machine's code");
        },
      };

      const error = await Effect.runPromise(Effect.flip(promote(breakOnSwitch)));

      expect(error.message).toContain("a bug in this machine's code");
      expect(error.message).toContain(`${harness.base} serves again.`);
      expect(isHomeEmpty(options.paths)).toBe(true);
      await expectServing(harness.base, user);
    });
  });

  it("keeps this Home and says how to recover when another machine switched first with the token", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const otherAddress = "http://c.test:4937";
      const switchElsewhereFirst = interceptFetch("POST", SWITCH_PATH, async (input, init) => {
        await fetch(input, { ...init, body: JSON.stringify({ newAddress: otherAddress }) });
        return fetch(input, init);
      });
      const { options } = await preparePromotion(harness.base, token, switchElsewhereFirst);

      const error = await Effect.runPromise(Effect.flip(promote(options)));

      expect(error.message).toContain("The switch did not move the controller to this machine.");
      expect(error.message).toContain(`has moved to ${otherAddress}`);
      expect(error.message).toContain("this Home keeps the received data");
      expect(existsSync(options.paths.databaseFile)).toBe(true);
      expect(existsSync(options.paths.masterKeyFile)).toBe(true);
      await expectSealed(harness.base, user, otherAddress);
    });
  });

  it("refuses a controller that starts in this Home during the promotion", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const { options } = await preparePromotion(harness.base, token);
      const refusals: Array<string> = [];
      /** Opens this Home's database as a starting controller does, and records the refusal. */
      const startController = () =>
        Effect.runPromise(
          Effect.scoped(Layer.build(openDatabase(options.paths.databaseFile))).pipe(
            Effect.match({
              onFailure: (error) => refusals.push(error.message),
              onSuccess: () => refusals.push("opened"),
            }),
          ),
        );
      const startDuringTransfer = interceptFetch("POST", TRANSFER_PATH, async (input, init) => {
        await startController();
        return fetch(input, init);
      });
      const startDuringSwitch = ((input: string, init?: RequestInit) =>
        init?.method === "POST" && new URL(input).pathname === SWITCH_PATH
          ? startController().then(() => fetch(input, init))
          : startDuringTransfer(input, init)) as unknown as typeof fetch;

      await Effect.runPromise(promote({ ...options, fetch: startDuringSwitch }));

      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) expect(refusal).toContain("is already open");
      expect(readdirSync(options.paths.dataDir).sort()).toEqual(["attachments", "hercule.db"]);
      await expectSealed(harness.base, user, options.address!);
    });
  });

  it("lets the old controller serve again when interrupted while it prepares the transfer", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      let frozen!: () => void;
      const transferSpent = new Promise<void>((resolve) => (frozen = resolve));
      // The old controller has frozen and sent the transfer, but a proxy in
      // between holds the answer back.
      const holdTransfer = interceptFetch("POST", TRANSFER_PATH, async (input, init) => {
        await (await fetch(input, init)).arrayBuffer();
        frozen();
        return waitForAbort(init);
      });
      const { options, lines } = await preparePromotion(harness.base, token, holdTransfer);

      const fiber = Effect.runFork(promote(options));
      await transferSpent;
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(lines.at(-1)).toContain("The promotion was interrupted.");
      expect(lines.at(-1)).toContain(`${harness.base} serves again.`);
      expect(isHomeEmpty(options.paths)).toBe(true);
      await expectServing(harness.base, user);
    });
  });

  it("says the token is unspent when interrupted before the old controller got the transfer request", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      let requested!: () => void;
      const transferRequested = new Promise<void>((resolve) => (requested = resolve));
      const holdRequest = interceptFetch("POST", TRANSFER_PATH, (_input, init) => {
        requested();
        return waitForAbort(init);
      });
      const { options, lines } = await preparePromotion(harness.base, token, holdRequest);

      const fiber = Effect.runFork(promote(options));
      await transferRequested;
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(lines.at(-1)).toContain(
        `${harness.base} did not spend the token, so it still serves.`,
      );
      expect(isHomeEmpty(options.paths)).toBe(true);
      await expectServing(harness.base, user);
    });
  });

  it("gives up on an old controller that sends the headers of an answer but not all of its body", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const stallBody = interceptFetch("GET", TRANSFER_PATH, (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode('{"controllerId":'));
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return Promise.resolve(
          new Response(body, { headers: { "content-type": "application/json" } }),
        );
      });
      const { options } = await preparePromotion(harness.base, token, stallBody);

      const started = Date.now();
      const error = await Effect.runPromise(Effect.flip(promote(options)));

      expect(error.message).toContain("did not answer within 10 seconds");
      expect(Date.now() - started).toBeLessThan(12_000);
      expect(isHomeEmpty(options.paths)).toBe(true);
      expect(existsSync(options.paths.promotionTransferDir)).toBe(false);
    });
  }, 20_000);

  it("keeps this Home and says what to check when the old controller cannot be reached after the transfer", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const unreachable = () => Promise.reject(new TypeError("connection refused"));
      const cutOff = interceptFetch("POST", SWITCH_PATH, unreachable);
      const cutOffBoth = ((input: string, init?: RequestInit) =>
        init?.method === "DELETE" && new URL(input).pathname === TRANSFER_PATH
          ? unreachable()
          : cutOff(input, init)) as unknown as typeof fetch;
      const { options } = await preparePromotion(harness.base, token, cutOffBoth);

      const error = await Effect.runPromise(Effect.flip(promote(options)));

      expect(error.message).toContain("cannot tell whether the old controller sealed");
      expect(error.message).toContain(options.paths.databaseFile);
      expect(existsSync(options.paths.databaseFile)).toBe(true);
      expect(existsSync(options.paths.masterKeyFile)).toBe(true);
    });
  }, 30_000);
});
