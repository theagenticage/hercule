/**
 * Tests the web app served by the release binary: a browser pointed at a
 * machine running `hercule` gets the app, on the same port and origin as the
 * API.
 *
 * This is the only test that proves the bundle is embedded rather than read
 * from disk, so it runs what a release ships. It runs an existing binary
 * rather than building one: a build rewrites `apps/web/dist` and the generated
 * file list, which should not happen while the rest of the suite runs. Run
 * `pnpm build:binary` first, then `pnpm test:binary`.
 *
 * It stops before setup completes, which is when a first-run browser arrives.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, startController, type Controller } from "../scripts/controller-process";
import { createTemporaryHome } from "./harness";

const state = createTemporaryHome();

let controller: Controller | undefined;
let url: string;

beforeAll(async () => {
  const binary = join(ROOT, "hercule");
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  controller = await startController({ home: state.home, binary });
  url = controller.url;
}, 60_000);

afterAll(async () => {
  // The binary may have been missing, in which case nothing was started, but
  // the temporary home still has to be removed.
  await controller?.stop().catch(() => -1);
  state.remove();
});

describe("the binary serving the web app", () => {
  it("serves the page at the root", async () => {
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const page = await response.text();
    expect(page).toContain('<div id="root">');
    // Nothing the page runs is inline, which is what the policy above allows.
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  it("serves the page at the setup link, before setup completes", async () => {
    const setup = await fetch(`${url}/setup?token=whatever`);
    expect(setup.status).toBe(200);
    expect(setup.headers.get("content-type")).toBe("text/html; charset=utf-8");

    // The gate is unchanged: the API still reports that first run has not happened.
    const state = await fetch(`${url}/api/v1/setup`);
    expect(await state.json()).toEqual({ complete: false });
  });

  it("serves every script the page requests, each with the right cache headers", async () => {
    const page = await (await fetch(`${url}/`)).text();
    const sources = [...page.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]!);
    // The entry module and its chunks have content hashes in their names; the
    // theme's pre-paint script keeps its name, so caching it forever would be
    // wrong.
    expect(sources.some((source) => /^\/assets\//.test(source))).toBe(true);
    expect(sources).toContain("/theme-init.js");

    for (const source of sources) {
      const script = await fetch(`${url}${source}`);
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      const fingerprinted = source.startsWith("/assets/");
      expect(script.headers.get("cache-control")).toBe(
        fingerprinted ? "public, max-age=31536000, immutable" : "no-cache",
      );
      expect((await script.text()).length).toBeGreaterThan(0);
    }
  });

  it("ships React's production build, not its development one", async () => {
    const page = await (await fetch(`${url}/`)).text();
    const sources = [...page.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
    expect(sources.length).toBeGreaterThan(0);

    for (const source of sources) {
      const chunk = await (await fetch(`${url}${source}`)).text();
      // Two signs of a development build, in the shipped code rather than in
      // the page that loads it: React's development-only invariant, and the
      // development JSX runtime the production build never includes.
      expect(chunk, source).not.toContain("Invalid hook call");
      expect(chunk, source).not.toContain("jsx-dev-runtime");
    }
  });

  it("keeps the JSON error envelope on the API next to it", async () => {
    const response = await fetch(`${url}/api/v1/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) as string },
    });
  });
});
