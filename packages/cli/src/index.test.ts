import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Result } from "effect";
import { main, readSetupUrl } from "./index";
import { envelope, id, stubFetch, stubIo, type Handler } from "./testing";

const SETUP_URL = "http://127.0.0.1:4937/setup?token=abc";

/** A Profile as the contract declares it; the client decodes what the stub returns. */
const profile = (tail: string, name: string) => ({
  id: id(tail),
  name,
  grants: ["task.read"],
  shipped: false,
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T10:00:00.000Z",
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A CLI wired to a stub controller, already holding an environment credential. */
const cli = (handler: Handler = () => ({})) => {
  const fetch = stubFetch(handler);
  const io = stubIo({
    env: { HYDRA_TOKEN: "test-token", HYDRA_API_URL: "http://controller.test" },
    fetch,
  });
  return {
    io,
    fetch,
    run: (...argv: ReadonlyArray<string>) => main(["--home", home, ...argv], io),
  };
};

describe("hydra setup-url", () => {
  const writeSetupUrl = () => {
    writeFileSync(join(home, "setup-url"), `${SETUP_URL}\n`, { mode: 0o600 });
  };

  it("reads the file the controller wrote, needing no credential", () => {
    writeSetupUrl();
    expect(readSetupUrl(["setup-url", "--home", home], {})).toEqual(Result.succeed(SETUP_URL));
    expect(readSetupUrl(["setup-url"], { HYDRA_HOME: home })).toEqual(Result.succeed(SETUP_URL));
  });

  it("prints the URL on stdout and nothing else", async () => {
    writeSetupUrl();
    const { io, run } = cli();
    expect(await run("setup-url")).toBe(0);
    expect(io.stdout).toEqual([SETUP_URL]);
    expect(io.stderr).toEqual([]);
  });

  it("reports an absent file on stderr and exits 1", async () => {
    const { io, run } = cli();
    expect(await run("setup-url")).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain(join(home, "setup-url"));
  });

  it("reports a malformed global option", () => {
    const result = readSetupUrl(["setup-url", "--home"], {});
    expect(Result.isFailure(result) && result.failure).toContain("directory");
  });
});

describe("--help", () => {
  it("lists the entities at the root, with the exit codes", async () => {
    const { io, run } = cli();
    expect(await run("--help")).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("profile");
    expect(text).toContain("secret");
    expect(text).toContain("HYDRA_SESSION=1");
    expect(text).toContain("2  the command line was wrong");
  });

  it("lists an entity's verbs and the grant each needs", async () => {
    const { io, run } = cli();
    expect(await run("profile", "--help")).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("query");
    expect(text).toContain("grant permission.read");
    expect(text).toContain("grant permission.write");
  });

  it("names the grant, the route and the flags of one verb", async () => {
    const { io, run } = cli();
    expect(await run("profile", "create", "--help")).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("operation: profile.create");
    expect(text).toContain("POST /api/v1/profiles");
    expect(text).toContain("requires:  grant permission.write");
    expect(text).toContain("--name");
    expect(text).toContain("--grants");
  });

  it("works after other flags have been written", async () => {
    const { io, run } = cli();
    expect(await run("profile", "create", "--name", "x", "--help")).toBe(0);
    expect(io.stdout.join("\n")).toContain("operation: profile.create");
  });

  it("renders the three requirement markers as prose, not as grants", async () => {
    const setup = cli();
    await setup.run("setup", "--help");
    expect(setup.io.stdout.join("\n")).toContain("no credential needed");
    expect(setup.io.stdout.join("\n")).toContain("the one-time setup token");

    const auth = cli();
    await auth.run("auth", "--help");
    expect(auth.io.stdout.join("\n")).toContain("any authenticated caller");
  });
});

describe("running an operation", () => {
  it("sends the payload the flags describe, under the resolved credential", async () => {
    const { fetch, run } = cli(() => profile("aaaaaaa1", "reviewer"));

    expect(await run("profile", "create", "--name", "reviewer", "--grants", "task.read")).toBe(0);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/profiles",
      body: { name: "reviewer", grants: ["task.read"] },
      authorization: "Bearer test-token",
    });
  });

  it("repeats a list flag into a list", async () => {
    const { fetch, run } = cli(() => ({
      ...profile("aaaaaaa1", "reviewer"),
      grants: ["task.read", "task.update"],
    }));
    await run(
      "profile",
      "create",
      "--name",
      "reviewer",
      "--grants",
      "task.read",
      "--grants",
      "task.update",
    );
    expect((fetch.calls[0]?.body as { grants: Array<string> }).grants).toEqual([
      "task.read",
      "task.update",
    ]);
  });

  it("prints the contract's output verbatim under --json", async () => {
    const reviewer = profile("aaaaaaa1", "reviewer");
    const { io, run } = cli(() => reviewer);
    expect(await run("profile", "read", reviewer.id, "--json")).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual(reviewer);
  });

  it("prints an object as key-value lines, with ids as tails", async () => {
    const { io, run } = cli(() => ({
      id: id("abcdef12"),
      publicKey: "key",
      version: "0.1.0",
    }));
    await run("controller", "read");
    expect(io.stdout).toEqual(["id         abcdef12", "publicKey  key", "version    0.1.0"]);
  });

  it("flattens a nested object into dotted keys", async () => {
    const { io, run } = cli(() => ({
      controller: { "retention.events": 30 },
      user: { timezone: "Europe/Amsterdam" },
    }));
    await run("settings", "read");
    expect(io.stdout).toEqual([
      "controller.retention.events  30",
      "user.timezone                Europe/Amsterdam",
    ]);
  });

  it("prints a page as a table and says how to get the rest", async () => {
    const { io, run } = cli(() => ({ items: [profile("aaaaaaa1", "one")], nextCursor: "c2" }));
    await run("profile", "query");
    expect(io.stdout).toEqual([
      "id        name  grants     shipped  createdAt                 updatedAt",
      "aaaaaaa1  one   task.read  false    2026-09-04T10:00:00.000Z  2026-09-04T10:00:00.000Z",
      "",
      "more results: --cursor c2, or --all",
    ]);
  });

  it("takes a secret's value from stdin and never from argv", async () => {
    const fetch = stubFetch(() => ({
      ownerKind: "connection",
      ownerId: "github",
      name: "token",
      createdAt: "2026-09-04T10:00:00.000Z",
    }));
    const io = stubIo({
      env: { HYDRA_TOKEN: "t", HYDRA_API_URL: "http://controller.test" },
      fetch,
      stdin: "s3cret\n",
    });
    expect(
      await main(
        ["--home", home, "secret", "set", "connection", "github", "token", "--value-stdin"],
        io,
      ),
    ).toBe(0);
    expect(fetch.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/v1/secrets/connection/github/token",
      body: { value: "s3cret" },
    });
  });

  it("refuses --value on a secret and says where the value goes", async () => {
    const { io, run } = cli();
    expect(await run("secret", "set", "connection", "github", "token", "--value", "s3cret")).toBe(
      2,
    );
    expect(io.stderr.join("\n")).toContain("--value-stdin");
  });
});

describe("paging", () => {
  const page = (items: ReadonlyArray<unknown>, nextCursor?: string) => ({
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });

  it("follows nextCursor to the end under --all", async () => {
    const fetch = stubFetch((request) => {
      const cursor = request.query.get("cursor");
      if (cursor === null) return page([profile("aaaaaaa1", "one")], "c2");
      if (cursor === "c2") return page([profile("aaaaaaa2", "two")], "c3");
      return page([profile("aaaaaaa3", "three")]);
    });
    const io = stubIo({
      env: { HYDRA_TOKEN: "t", HYDRA_API_URL: "http://controller.test" },
      fetch,
    });
    expect(await main(["--home", home, "profile", "query", "--all", "--json"], io)).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      items: [profile("aaaaaaa1", "one"), profile("aaaaaaa2", "two"), profile("aaaaaaa3", "three")],
    });
    expect(fetch.calls.length).toBe(3);
  });

  it("passes --limit and --sort through", async () => {
    const { fetch, run } = cli(() => ({ items: [] }));
    await run("profile", "query", "--limit", "2", "--sort", "name:desc");
    expect(fetch.calls[0]?.query.get("limit")).toBe("2");
    expect(fetch.calls[0]?.path).toBe("/api/v1/profiles");
  });

  it("rejects a sort field the operation does not declare", async () => {
    const { io, run } = cli();
    expect(await run("profile", "query", "--sort", "createdAt")).toBe(2);
    expect(io.stderr.join("\n")).toContain("is not sortable");
  });
});

describe("id tails", () => {
  const profiles = [profile("aaaaaaa1", "one"), profile("bbbbbbb2", "two")];

  const withProfiles = (extra: Handler) =>
    stubFetch((request) =>
      request.path === "/api/v1/profiles" && request.method === "GET"
        ? { items: profiles }
        : extra(request),
    );

  const io = (fetch: ReturnType<typeof stubFetch>) =>
    stubIo({ env: { HYDRA_TOKEN: "t", HYDRA_API_URL: "http://controller.test" }, fetch });

  it("resolves a unique tail through the entity's query operation", async () => {
    const fetch = withProfiles(() => profiles[1]!);
    const stub = io(fetch);
    expect(await main(["--home", home, "profile", "read", "bbbbbbb2", "--json"], stub)).toBe(0);
    expect(fetch.calls[1]?.path).toBe(`/api/v1/profiles/${id("bbbbbbb2")}`);
  });

  it("uses a full canonical id without a lookup", async () => {
    const fetch = withProfiles(() => profiles[0]!);
    const stub = io(fetch);
    await main(["--home", home, "profile", "read", id("aaaaaaa1"), "--json"], stub);
    expect(fetch.calls.length).toBe(1);
    expect(fetch.calls[0]?.path).toBe(`/api/v1/profiles/${id("aaaaaaa1")}`);
  });

  it("reports conflict when a tail matches more than one id", async () => {
    const fetch = stubFetch(() => ({
      items: [
        { ...profile("x", "one"), id: "0192f0a1-0000-7000-8000-000011112222" },
        { ...profile("x", "two"), id: "0192f0a1-0000-7000-8000-999911112222" },
      ],
    }));
    const stub = io(fetch);
    expect(await main(["--home", home, "profile", "read", "11112222", "--json"], stub)).toBe(1);
    const printed = JSON.parse(stub.stderr.join("\n")) as { error: { code: string } };
    expect(printed.error.code).toBe("conflict");
  });

  it("reports not_found when a tail matches nothing", async () => {
    const fetch = withProfiles(() => ({}));
    const stub = io(fetch);
    expect(await main(["--home", home, "profile", "read", "ffffffff"], stub)).toBe(1);
    expect(stub.stderr.join("\n")).toContain("no profile whose id ends with ffffffff");
  });

  it("refuses a tail shorter than eight characters before calling anything", async () => {
    const fetch = withProfiles(() => ({}));
    const stub = io(fetch);
    expect(await main(["--home", home, "profile", "read", "abc"], stub)).toBe(1);
    expect(fetch.calls.length).toBe(0);
    expect(stub.stderr.join("\n")).toContain("at least 8 characters");
  });
});

describe("failures", () => {
  it("exits 2 on an unknown command and names the entities", async () => {
    const { io, run } = cli();
    expect(await run("nope", "read")).toBe(2);
    expect(io.stderr.join("\n")).toContain("unknown command `nope`");
  });

  it("exits 2 on an unknown flag and points at --help", async () => {
    const { io, run } = cli();
    expect(await run("profile", "create", "--nope", "x")).toBe(2);
    expect(io.stderr.join("\n")).toContain("hydra profile create --help");
  });

  it("exits 2 when a required flag is missing", async () => {
    const { io, run } = cli();
    expect(await run("profile", "create")).toBe(2);
    expect(io.stderr.join("\n")).toContain("missing required --name, --grants");
  });

  it("exits 1 on an error envelope and prints the missing grant verbatim", async () => {
    const { io, run } = cli(() =>
      envelope("forbidden", 403, "missing grant permission.write", { grant: "permission.write" }),
    );
    expect(await run("profile", "create", "--name", "x", "--grants", "task.read")).toBe(1);
    expect(io.stderr.join("\n")).toContain("missing grant permission.write");
  });

  it("prints the error envelope verbatim under --json", async () => {
    const { io, run } = cli(() => envelope("not_found", 404, "no such profile"));
    expect(await run("profile", "delete", id("aaaaaaa1"), "--json")).toBe(1);
    expect(JSON.parse(io.stderr.join("\n"))).toEqual({
      error: { code: "not_found", message: "no such profile" },
    });
  });

  it("exits 3 when the controller cannot be reached", async () => {
    const fetch = stubFetch(() => {
      throw new TypeError("connect ECONNREFUSED");
    });
    const io = stubIo({
      env: { HYDRA_TOKEN: "t", HYDRA_API_URL: "http://controller.test" },
      fetch,
    });
    expect(await main(["--home", home, "controller", "read"], io)).toBe(3);
    expect(io.stderr.join("\n")).toContain("cannot reach");
  });

  it("exits 3 when no credential resolves", async () => {
    const io = stubIo({ env: {} });
    expect(await main(["--home", home, "controller", "read"], io)).toBe(3);
    expect(io.stderr.join("\n")).toContain("hydra login");
  });
});
