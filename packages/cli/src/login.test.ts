import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./index";
import { envelope, id, stubFetch, stubIo, type StubRequest } from "./testing";

const KEY = "hercule_key_dGVzdA";
const BEARER = "hercule_bearer_dGVzdA";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-login-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A controller that logs in, mints a key, and logs out. */
const controller = () =>
  stubFetch((request: StubRequest) => {
    if (request.path === "/api/v1/auth/login") {
      return { token: BEARER, expiresAt: "2026-10-04T10:00:00.000Z" };
    }
    if (request.path === "/api/v1/api-keys") {
      return {
        id: id("aaaaaaa1"),
        name: (request.body as { name: string }).name,
        token: KEY,
        createdAt: "2026-09-04T10:00:00.000Z",
      };
    }
    return {};
  });

const credentialsPath = () => join(home, "credentials.json");

describe("hercule login", () => {
  it("logs in, mints a key under the bearer, stores the key and drops the bearer", async () => {
    const fetch = controller();
    const io = stubIo({ fetch, stdin: "hunter2\n", hostname: "laptop" });

    expect(
      await main(
        ["--home", home, "login", "http://c.test", "--username", "rogier", "--password-stdin"],
        io,
      ),
    ).toBe(0);

    expect(fetch.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/v1/auth/login",
      "POST /api/v1/api-keys",
      "POST /api/v1/auth/logout",
    ]);
    expect(fetch.calls[0]?.body).toEqual({ username: "rogier", password: "hunter2" });
    expect(fetch.calls[0]?.authorization).toBeUndefined();
    expect(fetch.calls[1]?.authorization).toBe(`Bearer ${BEARER}`);
    expect(fetch.calls[1]?.body).toEqual({ name: "laptop" });
    expect(fetch.calls[2]?.authorization).toBe(`Bearer ${BEARER}`);

    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      url: "http://c.test",
      apiKey: KEY,
    });
  });

  it("writes the credential file readable by no one else", async () => {
    const io = stubIo({ fetch: controller(), stdin: "hunter2" });
    await main(
      ["--home", home, "login", "http://c.test", "--username", "rogier", "--password-stdin"],
      io,
    );
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("never writes the key into an existing file anyone could read", async () => {
    writeFileSync(credentialsPath(), "{}", { mode: 0o644 });
    const before = statSync(credentialsPath()).ino;

    const io = stubIo({ fetch: controller(), stdin: "hunter2" });
    await main(
      ["--home", home, "login", "http://c.test", "--username", "rogier", "--password-stdin"],
      io,
    );

    const after = statSync(credentialsPath());
    expect(after.mode & 0o777).toBe(0o600);
    // A new inode: the key went into a fresh 0600 file that was renamed over the
    // old one, so it was never held at 0644 waiting for a chmod.
    expect(after.ino).not.toBe(before);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      url: "http://c.test",
      apiKey: KEY,
    });
  });

  it("leaves no temporary file behind", async () => {
    const io = stubIo({ fetch: controller(), stdin: "hunter2" });
    await main(
      ["--home", home, "login", "http://c.test", "--username", "rogier", "--password-stdin"],
      io,
    );
    expect(readdirSync(home)).toEqual(["credentials.json"]);
  });

  it("never prints the key, the bearer or the password", async () => {
    const io = stubIo({ fetch: controller(), stdin: "hunter2" });
    await main(
      ["--home", home, "login", "http://c.test", "--username", "rogier", "--password-stdin"],
      io,
    );
    const printed = [...io.stdout, ...io.stderr].join("\n");
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(BEARER);
    expect(printed).not.toContain("hunter2");
    expect(printed).toContain(credentialsPath());
  });

  it("prints the key's identity and never its token under --json", async () => {
    const io = stubIo({ fetch: controller(), stdin: "hunter2" });
    await main(
      [
        "--home",
        home,
        "login",
        "http://c.test",
        "--username",
        "rogier",
        "--password-stdin",
        "--json",
      ],
      io,
    );
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      url: "http://c.test",
      apiKeyId: id("aaaaaaa1"),
      name: "test-host",
    });
  });

  it("takes the key's name from --name", async () => {
    const fetch = controller();
    const io = stubIo({ fetch, stdin: "hunter2" });
    await main(
      [
        "--home",
        home,
        "login",
        "http://c.test",
        "--username",
        "rogier",
        "--password-stdin",
        "--name",
        "ci",
      ],
      io,
    );
    expect(fetch.calls[1]?.body).toEqual({ name: "ci" });
  });

  it("reads its flags with the one parser: --flag=value, and a flag with no value", async () => {
    const fetch = controller();
    const io = stubIo({ fetch, stdin: "hunter2" });
    expect(
      await main(
        [
          "--home",
          home,
          "login",
          "http://c.test",
          "--username=rogier",
          "--name=ci",
          "--password-stdin",
        ],
        io,
      ),
    ).toBe(0);
    expect(fetch.calls[0]?.body).toEqual({ username: "rogier", password: "hunter2" });
    expect(fetch.calls[1]?.body).toEqual({ name: "ci" });

    const dangling = stubIo({ fetch: controller(), stdin: "hunter2" });
    expect(await main(["--home", home, "login", "http://c.test", "--username"], dangling)).toBe(2);
    expect(dangling.stderr.join("\n")).toContain("--username needs a value");
  });

  it("prompts with echo off only on a terminal", async () => {
    const fetch = controller();
    const io = stubIo({ fetch, tty: true, password: "hunter2" });
    expect(await main(["--home", home, "login", "http://c.test", "--username", "rogier"], io)).toBe(
      0,
    );
    expect(io.prompts).toEqual(["password: "]);
    expect(fetch.calls[0]?.body).toEqual({ username: "rogier", password: "hunter2" });
  });

  it("refuses to wedge on a prompt when stdin is not a terminal", async () => {
    const io = stubIo({ fetch: controller() });
    expect(await main(["--home", home, "login", "http://c.test", "--username", "rogier"], io)).toBe(
      2,
    );
    expect(io.stderr.join("\n")).toContain("--password-stdin");
    expect(io.prompts).toEqual([]);
  });

  it("has no --password flag, and says why", async () => {
    const io = stubIo({ fetch: controller() });
    expect(
      await main(
        ["--home", home, "login", "http://c.test", "--username", "u", "--password", "p"],
        io,
      ),
    ).toBe(2);
    expect(io.stderr.join("\n")).toContain("shell history");
  });

  it("needs a URL and a username", async () => {
    const io = stubIo({ fetch: controller(), stdin: "x" });
    expect(await main(["--home", home, "login", "--username", "u", "--password-stdin"], io)).toBe(
      2,
    );
    expect(await main(["--home", home, "login", "http://c.test", "--password-stdin"], io)).toBe(2);
    expect(await main(["--home", home, "login", "c.test", "--username", "u"], io)).toBe(2);
  });

  it("writes nothing when the password is wrong", async () => {
    const fetch = stubFetch(() => envelope("unauthenticated", 401, "wrong username or password"));
    const io = stubIo({ fetch, stdin: "wrong" });
    expect(
      await main(
        ["--home", home, "login", "http://c.test", "--username", "rogier", "--password-stdin"],
        io,
      ),
    ).toBe(1);
    expect(() => readFileSync(credentialsPath(), "utf8")).toThrow();
  });
});
