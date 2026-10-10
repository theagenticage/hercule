import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { buildHomePaths } from "@hercule/home";
import { makeSupervisorLayer } from "@hercule/service";
import { mintToken } from "../credentials";
import { promote, resolveAnnounceAddress, type PromoteOptions } from "./promote";

let dir: string;
let fetched: Array<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hercule-promote-"));
  fetched = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Returns options that pass every refusal, with a fetch that records each call and fails it. */
const buildOptions = (overrides: Partial<PromoteOptions> = {}): PromoteOptions => ({
  from: "http://a.test:4937",
  token: mintToken(),
  address: "http://b.test:4937",
  paths: buildHomePaths(join(dir, "home"), "data"),
  bindHost: "127.0.0.1",
  bindPort: 0,
  backend: "file",
  confirm: undefined,
  service: undefined,
  out: () => undefined,
  fetch: ((url: string) => {
    fetched.push(url);
    return Promise.reject(new Error("unreachable"));
  }) as unknown as typeof fetch,
  ...overrides,
});

/** Runs `promote` and returns the message it failed with. */
const readRefusal = (options: PromoteOptions): Promise<string> =>
  Effect.runPromise(Effect.flip(promote(options))).then((error) => error.message);

describe("resolveAnnounceAddress", () => {
  /** Returns the resolved address, or the message it was refused with. */
  const resolve = (
    address: string | undefined,
    host: string,
    port: number,
  ): Promise<{ readonly resolved?: string; readonly refused?: string }> =>
    Effect.runPromise(
      resolveAnnounceAddress(address, host, port).pipe(
        Effect.match({
          onFailure: (error) => ({ refused: error.message }),
          onSuccess: (resolved) => ({ resolved }),
        }),
      ),
    );

  it("uses --address as an origin, even when it is loopback", async () => {
    expect(await resolve("http://127.0.0.1:9/path", "127.0.0.1", 4937)).toEqual({
      resolved: "http://127.0.0.1:9",
    });
  });

  it("refuses a loopback or wildcard bind host when --address is omitted", async () => {
    expect((await resolve(undefined, "127.0.0.1", 4937)).refused).toContain("Pass --address");
    expect((await resolve(undefined, "0.0.0.0", 4937)).refused).toContain("Pass --address");
  });

  it("uses the bind origin when the bind host is reachable from other machines", async () => {
    expect(await resolve(undefined, "hercule.local", 9)).toEqual({
      resolved: "http://hercule.local:9",
    });
  });

  it("refuses --address that is not an http origin", async () => {
    expect((await resolve("ftp://hercule.local", "hercule.local", 9)).refused).toContain(
      "is not a controller URL",
    );
  });
});

// The transfer spends the token, so each of these refusals must come before
// the old controller is contacted.
describe("promote refuses before it contacts the old controller", () => {
  it("refuses text that is not a promotion token", async () => {
    expect(await readRefusal(buildOptions({ token: "tok" }))).toContain(
      "--token is not a promotion token",
    );
    expect(fetched).toEqual([]);
  });

  it("refuses --from that is not a controller URL", async () => {
    expect(await readRefusal(buildOptions({ from: "a.test" }))).toContain(
      "--from a.test is not a controller URL",
    );
    expect(fetched).toEqual([]);
  });

  it("refuses a Home that already holds a database", async () => {
    const options = buildOptions();
    mkdirSync(options.paths.dataDir, { recursive: true });
    writeFileSync(options.paths.databaseFile, "keep-me");
    expect(await readRefusal(options)).toContain("already exists");
    expect(fetched).toEqual([]);
  });

  it("refuses a service it could not install, and names --no-service", async () => {
    const home = join(dir, "home");
    const message = await readRefusal(
      buildOptions({
        service: {
          // With no compiled binary, a service unit has nothing to run.
          request: { role: "serve", home, overrides: [], env: {}, program: undefined },
          supervisor: makeSupervisorLayer({}),
        },
      }),
    );
    expect(message).toContain("To promote without installing the service, add --no-service.");
    expect(fetched).toEqual([]);
  });

  it("refuses a port that is already in use", async () => {
    const server: Server = await new Promise((resolve) => {
      const listening = createServer().listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      expect(await readRefusal(buildOptions({ bindPort: port }))).toContain(
        `Port ${String(port)} is already in use`,
      );
      expect(fetched).toEqual([]);
    } finally {
      server.close();
    }
  });
});
