/**
 * The web bundle over the same socket as the API: what a browser gets for a
 * page, for a fingerprinted file, and for everything neither of those.
 *
 * The bundle here is a temporary directory rather than `vite build`'s output,
 * so the test says what it means - one page, one fingerprinted file - and needs
 * no build to run. That the binary embeds the real thing is `e2e/web.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { webBundle } from "./server";
import { CONTENT_SECURITY_POLICY, type WebBundle } from "./static";
import { withServer } from "./testing";

const INDEX = '<!doctype html>\n<html><body><div id="root"></div></body></html>\n';
const CHUNK = "export const hercule = 1;\n";
const CHUNK_PATH = "/assets/index-CFSymTrk.js";

const directory = mkdtempSync(join(tmpdir(), "hercule-bundle-"));
mkdirSync(join(directory, "assets"));
writeFileSync(join(directory, "index.html"), INDEX);
writeFileSync(join(directory, CHUNK_PATH.slice(1)), CHUNK);

const bundle: WebBundle = {
  index: join(directory, "index.html"),
  files: new Map([
    ["/index.html", join(directory, "index.html")],
    [CHUNK_PATH, join(directory, CHUNK_PATH.slice(1))],
  ]),
};

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** The controller with the bundle mounted; every request here is a browser's. */
const withBundle = (body: (base: string) => Promise<void>): Promise<void> =>
  withServer(async ({ base }) => body(base), { bundle });

describe("the page", () => {
  it("serves index.html at the root, revalidated on every load", async () => {
    await withBundle(async (base) => {
      const response = await fetch(`${base}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toBe(INDEX);
    });
  });

  it("serves it for a deep link too, so a bookmarked screen loads", async () => {
    await withBundle(async (base) => {
      const settings = await fetch(`${base}/settings/profile`);
      expect(settings.status).toBe(200);
      expect(settings.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await settings.text()).toBe(INDEX);
    });
  });

  it("serves the setup link before setup completes, token and all", async () => {
    await withBundle(async (base) => {
      const setup = await fetch(`${base}/setup?token=a-setup-token`);
      expect(setup.status).toBe(200);
      expect(await setup.text()).toBe(INDEX);
    });
  });

  it("carries the content security policy and refuses type sniffing", async () => {
    await withBundle(async (base) => {
      const page = await fetch(`${base}/`);
      const chunk = await fetch(`${base}${CHUNK_PATH}`);
      expect(page.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
      expect(chunk.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
      expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
      // Inline code is admitted for styles and for nothing else: the workflow
      // editor puts its base styles in a `<style>` element, and a script is
      // never inline.
      expect(
        CONTENT_SECURITY_POLICY.split("; ").filter((directive) =>
          directive.includes("unsafe-inline"),
        ),
      ).toEqual(["style-src 'self' 'unsafe-inline'"]);
      // The one relaxation, and the shape of it: the ports a runner's identity
      // listener will settle for, named one by one. A wildcard port here would
      // hand anything that runs in the page every service on the reader's
      // machine, WebSockets included.
      expect(CONTENT_SECURITY_POLICY).toContain(
        "connect-src 'self' http://127.0.0.1:4939 http://127.0.0.1:4940",
      );
      expect(CONTENT_SECURITY_POLICY).toContain("http://127.0.0.1:4948;");
      expect(CONTENT_SECURITY_POLICY).not.toContain("127.0.0.1:*");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(chunk.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });

  it("answers a HEAD with the headers and no body", async () => {
    await withBundle(async (base) => {
      const response = await fetch(`${base}/`, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toBe("");
    });
  });

  it("answers any other method on a page path 404, not the page", async () => {
    await withBundle(async (base) => {
      const response = await fetch(`${base}/settings/profile`, { method: "POST" });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

describe("the fingerprinted files", () => {
  it("serves one with its own content type, cached forever", async () => {
    await withBundle(async (base) => {
      const response = await fetch(`${base}${CHUNK_PATH}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await response.text()).toBe(CHUNK);
    });
  });

  it("answers a missing one 404 rather than handing back the page", async () => {
    await withBundle(async (base) => {
      const response = await fetch(`${base}/assets/index-gone.js`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

describe("the API beside it", () => {
  it("keeps the error envelope for a path no operation owns", async () => {
    await withBundle(async (base) => {
      const response = await fetch(`${base}/api/v1/nope`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: expect.any(String) as string },
      });
    });
  });

  it("still answers its own operations", async () => {
    await withBundle(async (base) => {
      const response = await fetch(`${base}/api/v1/setup`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ complete: false });
    });
  });
});

describe("without a bundle", () => {
  it("answers every non-API path 404, as a checkout that was never built does", async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/settings/profile`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

describe("a generated bundle a test runner cannot evaluate", () => {
  it("reads as no bundle rather than as a failure to start", async () => {
    // `./bundle.ts` names build output through Bun's own import attributes, so
    // this runner cannot load it whether or not a build has run - which is the
    // stale-bundle situation, reached here through the effect the listener uses.
    expect(await Effect.runPromise(webBundle)).toBeUndefined();
  });
});
