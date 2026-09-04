/**
 * The web app out of the release binary: a browser pointed at a machine running
 * `hydra` gets the app, on the same port and origin as the API.
 *
 * This is the one test that proves the bundle is embedded rather than read off
 * disk, so it runs what a release ships. It runs a binary that is already
 * there rather than building one: a build rewrites `apps/web/dist` and the
 * generated file list, which is not something to do underneath the rest of the
 * suite. `pnpm build:binary` first, then `pnpm test:binary`.
 *
 * It stops before setup completes, which is when a first-run browser arrives.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, startController, temporaryHome, type Controller } from "./harness";

const state = temporaryHome();

let controller: Controller;
let url: string;

beforeAll(async () => {
  const binary = join(ROOT, "hydra");
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  controller = await startController({ home: state.home, binary });
  url = controller.url;
}, 60_000);

afterAll(async () => {
  await controller.stop().catch(() => -1);
  state.remove();
});

describe("the binary serving the web app", () => {
  it("answers the root with the page", async () => {
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

  it("answers the setup link with the page, before setup completes", async () => {
    const setup = await fetch(`${url}/setup?token=whatever`);
    expect(setup.status).toBe(200);
    expect(setup.headers.get("content-type")).toBe("text/html; charset=utf-8");

    // The gate is unchanged: the API still says first run has not happened.
    const state = await fetch(`${url}/api/v1/setup`);
    expect(await state.json()).toEqual({ complete: false });
  });

  it("serves the fingerprinted script the page asks for, cached forever", async () => {
    const page = await (await fetch(`${url}/`)).text();
    const source = /<script[^>]*\ssrc="([^"]+)"/.exec(page)?.[1];
    expect(source).toMatch(/^\/assets\//);

    const script = await fetch(`${url}${source!}`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await script.text()).length).toBeGreaterThan(0);
  });

  it("ships React's production build, not its development one", async () => {
    const page = await (await fetch(`${url}/`)).text();
    const sources = [...page.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
    expect(sources.length).toBeGreaterThan(0);

    for (const source of sources) {
      const chunk = await (await fetch(`${url}${source}`)).text();
      expect(chunk, source).not.toContain("Invalid hook call");
    }
    expect(page).not.toContain("jsx-dev-runtime");
  });

  it("keeps the JSON error envelope on the API beside it", async () => {
    const response = await fetch(`${url}/api/v1/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) as string },
    });
  });
});
