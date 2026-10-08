/**
 * Tests the runner's cache of attached images against a stub controller.
 *
 * The stub is `Bun.serve`, because this package must not import controller
 * code. It serves the attachment route and counts the requests, so a test can
 * tell a fetch from a cache hit.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { AttachmentReference } from "@hercule/protocol";
import { makeAttachmentCache } from "./index";

const CREDENTIAL = "runner-credential-for-a-test";

/** A one-pixel PNG: the bytes the stub serves for every known image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

const buildReference = (id: string, bytes: Buffer = PNG): AttachmentReference => ({
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const IMAGE_A = buildReference("0199e0e7-0000-7000-8000-0000000000a1");
const IMAGE_B = buildReference("0199e0e7-0000-7000-8000-0000000000b2");

interface Stub {
  readonly url: string;
  /** The ids requested so far, in order, one entry per request. */
  readonly requested: Array<string>;
  /** The authorization header of each request, in order. */
  readonly authorizations: Array<string | null>;
  /** When set, a request waits for this promise before it responds. */
  hold: Promise<void> | undefined;
}

const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
const roots: Array<string> = [];

afterAll(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Starts a stub controller that serves, for each id it knows, either those
 * bytes or the response the function builds, and 404 for any other id.
 */
const startStub = (bytes: Readonly<Record<string, Buffer | (() => Response)>>): Stub => {
  const stub: Stub = { url: "", requested: [], authorizations: [], hold: undefined };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const id = new URL(request.url).pathname.replace("/api/v1/runners/attachments/", "");
      stub.requested.push(id);
      stub.authorizations.push(request.headers.get("authorization"));
      if (stub.hold !== undefined) await stub.hold;
      const body = bytes[id];
      if (body === undefined) return new Response("not found", { status: 404 });
      return typeof body === "function" ? body() : new Response(body);
    },
  });
  servers.push(server);
  return Object.assign(stub, { url: `http://127.0.0.1:${String(server.port)}` });
};

const createDir = (): string => {
  const made = mkdtempSync(join(tmpdir(), "hercule-attachments-"));
  roots.push(made);
  return made;
};

describe("the attachment cache", () => {
  it("fetches each image with the runner's credential, checks it and saves it under its id", async () => {
    const stub = startStub({ [IMAGE_A.id]: PNG, [IMAGE_B.id]: PNG });
    const cache = makeAttachmentCache({ controllerUrl: stub.url, credential: CREDENTIAL });
    const dir = createDir();

    const local = await Effect.runPromise(cache.fetch(dir, [IMAGE_A, IMAGE_B]));

    expect(local).toEqual([
      { ...IMAGE_A, path: join(dir, IMAGE_A.id) },
      { ...IMAGE_B, path: join(dir, IMAGE_B.id) },
    ]);
    expect(readFileSync(join(dir, IMAGE_A.id))).toEqual(PNG);
    expect(stub.authorizations).toEqual([`Bearer ${CREDENTIAL}`, `Bearer ${CREDENTIAL}`]);
    // Only the checked files: no temporary file is left behind.
    expect(readdirSync(dir).sort()).toEqual([IMAGE_A.id, IMAGE_B.id].sort());
  });

  it("uses a cached image without asking the controller again", async () => {
    const stub = startStub({ [IMAGE_A.id]: PNG });
    const cache = makeAttachmentCache({ controllerUrl: stub.url, credential: CREDENTIAL });
    const dir = createDir();

    await Effect.runPromise(cache.fetch(dir, [IMAGE_A]));
    await Effect.runPromise(cache.fetch(dir, [IMAGE_A]));

    expect(stub.requested).toEqual([IMAGE_A.id]);
  });

  it("fetches an image once when two inputs ask for it at the same time", async () => {
    const stub = startStub({ [IMAGE_A.id]: PNG });
    let release = (): void => undefined;
    stub.hold = new Promise((resolve) => {
      release = resolve;
    });
    const cache = makeAttachmentCache({ controllerUrl: stub.url, credential: CREDENTIAL });
    const dir = createDir();

    const first = Effect.runPromise(cache.fetch(dir, [IMAGE_A]));
    const second = Effect.runPromise(cache.fetch(dir, [IMAGE_A]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();

    expect(await first).toEqual(await second);
    expect(stub.requested).toEqual([IMAGE_A.id]);
  });

  it("refuses an image whose bytes do not match its checksum, and keeps no file of it", async () => {
    // Same length as the image, so only the checksum can tell them apart.
    const stub = startStub({ [IMAGE_A.id]: Buffer.alloc(PNG.length) });
    const cache = makeAttachmentCache({ controllerUrl: stub.url, credential: CREDENTIAL });
    const dir = createDir();

    const failure = await Effect.runPromise(Effect.flip(cache.fetch(dir, [IMAGE_A])));

    expect(failure).toBe(
      `the image "${IMAGE_A.name}" could not be fetched from the controller: the bytes the controller sent do not match the image's checksum`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a response whose length is not the image's size", async () => {
    const stub = startStub({ [IMAGE_A.id]: Buffer.from("not the image") });
    const cache = makeAttachmentCache({ controllerUrl: stub.url, credential: CREDENTIAL });
    const dir = createDir();

    const failure = await Effect.runPromise(Effect.flip(cache.fetch(dir, [IMAGE_A])));

    expect(failure).toBe(
      `the image "${IMAGE_A.name}" could not be fetched from the controller: the controller sent 13 bytes, but the image has ${String(PNG.length)}`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops reading a response with no length as soon as it passes the image's size", async () => {
    // A streamed body has no content-length, and this one never ends: the
    // fetch can only finish by giving up once too many bytes arrived.
    const endless = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new Uint8Array(PNG));
            controller.enqueue(new Uint8Array(PNG));
          },
        }),
      );
    const stub = startStub({ [IMAGE_A.id]: endless });
    const cache = makeAttachmentCache({ controllerUrl: stub.url, credential: CREDENTIAL });
    const dir = createDir();

    const failure = await Effect.runPromise(Effect.flip(cache.fetch(dir, [IMAGE_A])));

    expect(failure).toBe(
      `the image "${IMAGE_A.name}" could not be fetched from the controller: the controller sent more than the image's ${String(PNG.length)} bytes`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an image the controller does not serve, naming the image and the status", async () => {
    const stub = startStub({});
    const cache = makeAttachmentCache({ controllerUrl: stub.url, credential: CREDENTIAL });
    const dir = createDir();

    const failure = await Effect.runPromise(Effect.flip(cache.fetch(dir, [IMAGE_A])));

    expect(failure).toBe(
      `the image "${IMAGE_A.name}" could not be fetched from the controller: the controller responded with HTTP 404`,
    );
    expect(existsSync(join(dir, IMAGE_A.id))).toBe(false);
  });
});
