/**
 * Tests the response compression through the real controller over a real
 * socket, so the order of the wrappers is tested too: the compression runs on
 * the finished response, after CORS and the envelope.
 */
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DESKTOP_APP_ORIGIN } from "@hercule/contract";
import { completeSetup, withServer } from "./testing";

/** A list the controller answers with more than 1 KiB of JSON on a fresh database. */
const BIG_PATH = "/api/v1/profiles";

/** Reads a path with a given `Accept-Encoding`, leaving the body as the wire carried it. */
const readRaw = (
  base: string,
  token: string,
  acceptEncoding: string | undefined,
  path = BIG_PATH,
) =>
  fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      connection: "close",
      ...(acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding }),
      origin: DESKTOP_APP_ORIGIN,
    },
    decompress: false,
  });

describe("response compression", () => {
  it.each([
    ["brotli", "gzip, deflate, br, zstd", "br", brotliDecompressSync],
    ["gzip, from a client that accepts only gzip", "gzip", "gzip", gunzipSync],
    ["gzip, from a client that refuses brotli", "br;q=0, gzip", "gzip", gunzipSync],
  ])(
    "compresses a large JSON answer with %s, and the bytes decode to the same JSON",
    async (_name, acceptEncoding, coding, decode) => {
      await withServer(async ({ base }) => {
        const token = await completeSetup(base);
        const plain = await readRaw(base, token, "identity");
        const plainText = await plain.text();
        expect(plain.headers.get("content-encoding")).toBeNull();
        expect(plainText.length).toBeGreaterThan(1024);

        const response = await readRaw(base, token, acceptEncoding);
        const bytes = new Uint8Array(await response.arrayBuffer());

        expect(response.status).toBe(200);
        expect(response.headers.get("content-encoding")).toBe(coding);
        expect(response.headers.get("content-length")).toBe(String(bytes.length));
        expect(bytes.length).toBeLessThan(plainText.length);
        expect(new TextDecoder().decode(decode(bytes))).toBe(plainText);
      });
    },
  );

  it("keeps the CORS headers and adds Accept-Encoding to Vary, with origin still listed", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await readRaw(base, token, "gzip");
      await response.arrayBuffer();

      expect(response.headers.get("access-control-allow-origin")).toBe(DESKTOP_APP_ORIGIN);
      const vary = (response.headers.get("vary") ?? "").toLowerCase().split(/,\s*/);
      expect(vary).toContain("origin");
      expect(vary).toContain("accept-encoding");
    });
  });

  it.each([
    ["no Accept-Encoding header", undefined],
    ["identity", "identity"],
    ["gzip refused with q=0", "gzip;q=0"],
    ["only a coding the controller does not offer", "zstd"],
    ["everything refused with a wildcard at q=0", "*;q=0"],
  ])("sends the answer as it was for a client with %s", async (_name, acceptEncoding) => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await readRaw(base, token, acceptEncoding);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect((JSON.parse(text) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    });
  });

  it("leaves an answer under 1 KiB uncompressed", async () => {
    await withServer(async ({ base }) => {
      const response = await readRaw(base, "", "gzip", "/api/v1/setup");
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text.length).toBeLessThan(1024);
      expect(response.headers.get("content-encoding")).toBeNull();
    });
  });

  it("leaves an image attachment's bytes alone even when the client accepts gzip", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const image = new Uint8Array(8192);
      image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const upload = await fetch(`${base}/api/v1/attachments?name=big.png`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          authorization: `Bearer ${token}`,
          connection: "close",
        },
        body: image,
      });
      expect(upload.status).toBe(201);
      const { id } = (await upload.json()) as { id: string };

      const response = await readRaw(base, token, "gzip", `/api/v1/attachments/${id}/content`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
    });
  });

  it("answers a HEAD request with no body", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const head = await fetch(`${base}${BIG_PATH}`, {
        method: "HEAD",
        headers: {
          authorization: `Bearer ${token}`,
          "accept-encoding": "gzip",
          connection: "close",
        },
        decompress: false,
      });

      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    });
  });

  it("is decoded transparently by an ordinary fetch", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await fetch(`${base}${BIG_PATH}`, {
        headers: { authorization: `Bearer ${token}`, connection: "close" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("br");
      expect(((await response.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    });
  });
});
