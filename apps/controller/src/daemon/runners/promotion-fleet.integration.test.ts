/**
 * The preview and the switch of a promotion over HTTP, as the old controller A
 * serves them:
 *
 * - The preview lists A's identity and runners without spending the token,
 *   and is refused while another transfer holds the freeze.
 * - The switch seals A after a spent token. Connected runners get a
 *   forwarding pointer, a runner that dials afterwards gets one instead of a
 *   hello, and API writes then return `controller_sealed`.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  encodeForwardingPointerBytes,
  PROTOCOL_VERSION,
  type ControllerHello,
  type ControllerToRunner,
  type ForwardingPointer,
  type JoinAnswer,
  type RunnerHello,
} from "@hercule/protocol";
import { mintToken } from "../../credentials";
import { withFinalTransaction } from "../../db";
import { completeSetup, get, readErrorBody, send, withServer } from "../../http/testing";
import { NO_PROMOTION_TOKEN, SWITCH_PATH } from "../../promotion";
import {
  createPromotionToken,
  freezeController,
  NEW_CONTROLLER_ADDRESS,
  requestTransfer,
  sealController,
} from "../../promotion/testing";

const SOCKET_PATH = "/api/v1/runners/socket";

const postSwitch = (
  base: string,
  token: string,
  newAddress = NEW_CONTROLLER_ADDRESS,
): Promise<Response> =>
  fetch(`${base}${SWITCH_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({ newAddress }),
  });

const encodeBase64 = (raw: Uint8Array): string => Buffer.from(raw).toString("base64");

const decodeBase64Bytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const out = new Uint8Array(decoded.byteLength);
  out.set(decoded);
  return out;
};

const verifyAddressSignature = async (
  publicKey: string,
  newAddress: string,
  signature: string,
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "spki",
    decodeBase64Bytes(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    decodeBase64Bytes(signature),
    encodeForwardingPointerBytes(newAddress),
  );
};

const buildSocketUrl = (base: string): string => `${base.replace(/^http:/, "ws:")}${SOCKET_PATH}`;

interface Wire {
  readonly send: (message: object) => void;
  readonly next: () => Promise<ControllerToRunner>;
  readonly close: () => void;
}

const dial = (base: string, credential: string): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(buildSocketUrl(base), {
      headers: { authorization: `Bearer ${credential}` },
    });
    const frames: Array<ControllerToRunner> = [];
    let taken = 0;
    let ending: { readonly code: number; readonly reason: string } | undefined;

    socket.onmessage = (event) => {
      frames.push(JSON.parse(String(event.data)) as ControllerToRunner);
    };
    socket.onclose = (event) => {
      ending = { code: event.code, reason: event.reason };
    };
    socket.onopen = () => {
      resolve({
        send: (message) => socket.send(JSON.stringify(message)),
        next: async () => {
          for (let attempt = 0; attempt < 400 && frames.length <= taken; attempt++) {
            await delay(5);
          }
          if (frames.length <= taken) {
            throw new Error(
              ending === undefined
                ? "the controller sent nothing"
                : `the controller closed (${String(ending.code)} ${ending.reason}) instead of answering`,
            );
          }
          return frames[taken++]!;
        },
        close: () => socket.close(),
      });
    };
    setTimeout(
      () =>
        reject(
          new Error(
            ending === undefined
              ? "the controller never upgraded the connection"
              : `the controller refused the upgrade (${String(ending.code)} ${ending.reason})`,
          ),
        ),
      3000,
    );
  });

const buildHello = (overrides: Partial<RunnerHello> = {}): RunnerHello => ({
  _tag: "runnerHello",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [],
  binaryVersion: "0.1.0",
  nonce: encodeBase64(crypto.getRandomValues(new Uint8Array(16))),
  facts: {
    os: "linux",
    arch: "x64",
    totalMemoryBytes: 1,
    docker: false,
    toolchains: [],
    providers: [],
    adapters: [],
    identityPort: 4939,
  },
  ...overrides,
});

const enlist = async (base: string, joinToken: string): Promise<JoinAnswer> => {
  const response = await send("POST", base, "/api/v1/runners/join", {
    body: {},
    token: joinToken,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as JoinAnswer;
};

const waitForTag = async <T extends ControllerToRunner>(wire: Wire, tag: T["_tag"]): Promise<T> => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const frame = await wire.next();
    if (frame._tag === tag) return frame as T;
  }
  throw new Error(`the controller never sent ${tag}`);
};

describe("promotion preview", () => {
  it("previews the controller and its runners without spending the token, and not while frozen", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const preview = await requestTransfer(harness.base, token, "GET");
      expect(preview.status).toBe(200);
      const body = (await preview.json()) as {
        controllerId: string;
        runners: ReadonlyArray<{ name: string; connectivity: string }>;
      };
      expect(body.controllerId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Array.isArray(body.runners)).toBe(true);

      const spent = await requestTransfer(harness.base, token);
      expect(spent.status).toBe(200);
      await spent.arrayBuffer();

      const frozen = await requestTransfer(harness.base, mintToken(), "GET");
      expect(frozen.status).toBe(409);
      expect((await readErrorBody(frozen)).code).toBe("promotion_in_progress");
    });
  });
});

describe("promotion switch", () => {
  it("refuses a missing, unknown, or unspent token", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);

      const missing = await fetch(`${harness.base}${SWITCH_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ newAddress: NEW_CONTROLLER_ADDRESS }),
      });
      expect(missing.status).toBe(401);

      const unknown = await postSwitch(harness.base, "not-a-promotion-token");
      expect(unknown.status).toBe(401);
      expect((await readErrorBody(unknown)).message).toBe(NO_PROMOTION_TOKEN);

      const unspent = await createPromotionToken(harness.base, user);
      const beforeTransfer = await postSwitch(harness.base, unspent);
      expect(beforeTransfer.status).toBe(401);
      expect((await readErrorBody(beforeTransfer)).message).toBe(NO_PROMOTION_TOKEN);
    });
  });

  it("refuses a switch once the freeze has ended, and does not seal", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await freezeController(harness.base, user);
      const cancelled = await requestTransfer(harness.base, token, "DELETE");
      expect(cancelled.status).toBe(204);

      const switched = await postSwitch(harness.base, token);
      expect(switched.status).toBe(409);
      expect((await readErrorBody(switched)).code).toBe("invalid_state");

      const read = await get(harness.base, "/api/v1/controller", user);
      expect(read.status).toBe(200);
    });
  });

  // B repeats a switch whose answer it lost, and its cancel learns from the
  // refusal that A sealed. Both must hold after the token's lifetime, or B
  // would discard the data A's runners now point at.
  it("answers a repeated switch and refuses a cancel once sealed, even after the token expired", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await freezeController(harness.base, user);
      await sealController(harness.base, token);
      // A sealed controller's database refuses every write. The test expires
      // the token in `withFinalTransaction`, the one kind of transaction
      // allowed then, which leaves writes stopped after it.
      await Effect.runPromise(
        Effect.orDie(
          withFinalTransaction(
            harness.sql,
            harness.sql`
              UPDATE promotion_tokens
              SET created_at = ${"2000-01-01T00:00:00.000Z"},
                  expires_at = ${"2000-01-01T00:15:00.000Z"}
            `,
          ),
        ),
      );

      const again = await postSwitch(harness.base, token);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ newAddress: NEW_CONTROLLER_ADDRESS });

      const cancelled = await requestTransfer(harness.base, token, "DELETE");
      expect(cancelled.status).toBe(503);
      const refusal = (await cancelled.json()) as {
        error: { code: string; details: { newAddress: string } };
      };
      expect(refusal.error.code).toBe("controller_sealed");
      expect(refusal.error.details.newAddress).toBe(NEW_CONTROLLER_ADDRESS);
    });
  });

  it("seals A after a spent token, is idempotent, and refuses later writes", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await freezeController(harness.base, user);

      const first = await postSwitch(harness.base, token);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ newAddress: NEW_CONTROLLER_ADDRESS });

      const again = await postSwitch(harness.base, token, "http://other.example:8");
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ newAddress: NEW_CONTROLLER_ADDRESS });

      const read = await get(harness.base, "/api/v1/controller", user);
      expect(read.status).toBe(503);
      const body = await readErrorBody(read);
      expect(body.code).toBe("controller_sealed");
      expect(body.message).toContain(NEW_CONTROLLER_ADDRESS);
    });
  });

  it("announces the new address to a connected runner and serves a forwarding pointer afterwards", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      await Effect.runPromise(Effect.orDie(harness.sql.unsafe(`DELETE FROM provider_instances`)));
      const joined = await enlist(harness.base, await harness.joinToken());
      const wire = await dial(harness.base, joined.credential);
      wire.send(buildHello());
      const hello = await waitForTag<ControllerHello>(wire, "controllerHello");
      expect(hello.identityId).toBe(joined.controllerIdentityId);

      const token = await freezeController(harness.base, user);
      await sealController(harness.base, token);

      const announcement = await waitForTag<ForwardingPointer>(wire, "forwardingPointer");
      expect(announcement.newAddress).toBe(NEW_CONTROLLER_ADDRESS);
      expect(
        await verifyAddressSignature(
          joined.controllerPublicKey,
          announcement.newAddress,
          announcement.signature,
        ),
      ).toBe(true);
      wire.close();

      const again = await dial(harness.base, joined.credential);
      again.send(buildHello());
      const pointer = await waitForTag<ForwardingPointer>(again, "forwardingPointer");
      expect(pointer.newAddress).toBe(NEW_CONTROLLER_ADDRESS);
      expect(
        await verifyAddressSignature(
          joined.controllerPublicKey,
          pointer.newAddress,
          pointer.signature,
        ),
      ).toBe(true);
      again.close();
    });
  });
});
