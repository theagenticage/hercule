import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Result } from "effect";
import { CLI, NOUNS, OPERATIONS, type OperationId } from "@hercule/contract";
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
  home = mkdtempSync(join(tmpdir(), "hercule-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A CLI wired to a stub controller, already holding an environment credential. */
const cli = (handler: Handler = () => ({})) => {
  const fetch = stubFetch(handler);
  const io = stubIo({
    env: { HERCULE_TOKEN: "test-token", HERCULE_API_URL: "http://controller.test" },
    fetch,
  });
  return {
    io,
    fetch,
    run: (...argv: ReadonlyArray<string>) => main(["--home", home, ...argv], io),
  };
};

describe("hercule setup-url", () => {
  const writeSetupUrl = () => {
    writeFileSync(join(home, "setup-url"), `${SETUP_URL}\n`, { mode: 0o600 });
  };

  it("reads the file the controller wrote, needing no credential", () => {
    writeSetupUrl();
    expect(readSetupUrl(["setup-url", "--home", home], {})).toEqual(Result.succeed(SETUP_URL));
    expect(readSetupUrl(["setup-url"], { HERCULE_HOME: home })).toEqual(Result.succeed(SETUP_URL));
  });

  it("prints the URL on stdout and nothing else", async () => {
    writeSetupUrl();
    const { io, run } = cli();
    expect(await run("setup-url")).toBe(0);
    expect(io.stdout).toEqual([SETUP_URL]);
    expect(io.stderr).toEqual([]);
  });

  it("reports an absent file on stderr as missing local state, not as an API failure", async () => {
    const { io, run } = cli();
    expect(await run("setup-url")).toBe(3);
    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain(join(home, "setup-url"));
  });

  it("reports a malformed global option", () => {
    const result = readSetupUrl(["setup-url", "--home"], {});
    expect(Result.isFailure(result) && result.failure).toContain("directory");
  });
});

/** The lines one `--help` printed, at exit 0. */
const help = async (...argv: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const { io, run } = cli();
  expect(await run(...argv, "--help"), `hercule ${argv.join(" ")} --help`).toBe(0);
  return io.stdout;
};

/** Where a section marker sits, or -1. */
const section = (out: ReadonlyArray<string>, marker: string): number =>
  out.findIndex((line) => line.trim().toLowerCase().startsWith(marker));

/** The text between two section markers. */
const between = (out: ReadonlyArray<string>, from: string, to: string): string =>
  out.slice(section(out, from), section(out, to)).join("\n");

const lastLine = (out: ReadonlyArray<string>): string =>
  [...out].reverse().find((line) => line.trim() !== "") ?? "";

const startsWithWord = (line: string, word: string): boolean =>
  new RegExp(`^${word}\\b`).test(line.trim());

/** The root help's lines for one noun: its own, and everything before the next noun. */
const nounBlock = (out: ReadonlyArray<string>, noun: string): string => {
  const from = out.findIndex((line) => startsWithWord(line, noun));
  expect(from, `the root help has no ${noun} noun`).toBeGreaterThan(-1);
  const next = out.findIndex(
    (line, index) =>
      index > from &&
      Object.keys(NOUNS).some((other) => other !== noun && startsWithWord(line, other)),
  );
  return out.slice(from, next === -1 ? out.length : next).join("\n");
};

/** Every visible command, as the words after `hercule`. */
const spellings = Object.values(CLI as Record<string, { hidden?: true; command?: string }>)
  .filter((row) => row.hidden !== true)
  .map((row) => (row.command ?? "").split(" "));

// the command screen, in one fixed shape.
describe("hercule session input --help", () => {
  const MARKERS = [
    "usage:",
    "examples:",
    "arguments:",
    "flags:",
    "stdin:",
    "returns:",
    "errors:",
    "next:",
  ];

  it("opens with the purpose, then the sections in their fixed order", async () => {
    const out = await help("session", "input");
    const at = MARKERS.map((marker) => section(out, marker));
    for (const [index, marker] of MARKERS.entries()) {
      expect(at[index], `${marker} is missing`).toBeGreaterThan(-1);
    }
    expect(at, MARKERS.join(" then ")).toEqual([...at].sort((a, b) => a - b));
    expect(at[0]).toBeGreaterThan(0);
    expect(out.slice(0, at[0]).join("\n")).toContain("opens a turn on an idle session");
  });

  it("renders the example as a piped shell line", async () => {
    const out = await help("session", "input");
    expect(out.join("\n")).toMatch(
      /echo "Carry on, and run the tests when you are done\." \| hercule session input 1f3a9c2e/,
    );
  });

  it("describes the id argument and each flag", async () => {
    const text = (await help("session", "input")).join("\n");
    expect(text).toContain("<id>");
    expect(text).toContain("The session's id, or a tail of eight or more characters.");
    expect(text).toContain("--model");
    expect(text).toContain("Switch the session to this model from this turn on.");
    expect(text).toContain("--options");
    expect(text).toContain(
      "The per-model choices as inline JSON, applied before the input is stored.",
    );
  });

  it("says the text is required on stdin and that there is no --text flag", async () => {
    const out = await help("session", "input");
    const block = between(out, "stdin:", "returns:");
    expect(block.toLowerCase()).toContain("required");
    expect(block.toLowerCase()).toContain("there is no --text flag");
  });

  it("names what comes back", async () => {
    const block = between(await help("session", "input"), "returns:", "errors:");
    expect(block).toContain("inputId");
    expect(block).toContain("result");
  });

  it("says what forbidden means and how to ask for the grant", async () => {
    const block = between(await help("session", "input"), "errors:", "next:");
    expect(block).toContain("forbidden");
    expect(block).toContain("hercule permission request session.steer");
  });

  it("ends on the operation line", async () => {
    expect(lastLine(await help("session", "input"))).toBe(
      "operation session.input \u00b7 POST /api/v1/sessions/:id/input \u00b7 grant session.steer",
    );
  });
});

describe("hercule task list --help", () => {
  it("shows the paging section and a page's items", async () => {
    const out = await help("task", "list");
    expect(section(out, "paging:"), "no paging section").toBeGreaterThan(-1);
    expect(out.slice(section(out, "returns:")).join("\n")).toContain("items[]");
  });
});

describe("hercule session --help", () => {
  const VERBS = [
    "list",
    "read",
    "spawn",
    "update",
    "input",
    "interrupt",
    "respond",
    "stop",
    "continue",
  ];

  it("lists the nine verbs, each with the grant it needs", async () => {
    const out = await help("session");
    for (const verb of VERBS) {
      const line = out.find((each) => startsWithWord(each, verb));
      expect(line, `no line for session ${verb}`).toBeDefined();
      expect(line, `session ${verb} names no grant`).toContain("grant ");
    }
  });

  it("names the usual order in a flow line", async () => {
    const out = await help("session");
    expect(section(out, "flow:"), "no flow line").toBeGreaterThan(-1);
    expect(out.join("\n")).toContain("hercule session spawn starts one");
  });
});

describe("hercule --help", () => {
  it("lists every visible noun with its verbs", async () => {
    const out = await help();
    for (const words of spellings) {
      expect(nounBlock(out, words[0]!), `${words.join(" ")} is not in the root help`).toContain(
        words[1]!,
      );
    }
  });

  it("shows the nested join-token noun under runner", async () => {
    const block = nounBlock(await help(), "runner");
    expect(block).toMatch(/join-token:\s+create\s+list\s+revoke/);
  });

  it("carries the conventions that hold everywhere", async () => {
    const text = (await help()).join("\n");
    expect(text).toContain("--json");
    expect(text).toContain("exit");
    expect(text).toContain("hercule permission request");
  });

  it("has no auth noun at all", async () => {
    const out = await help();
    expect(out.filter((line) => startsWithWord(line, "auth"))).toEqual([]);
    expect(out.join("\n")).not.toContain("ws-ticket");
  });
});

// the bridge, on the CLI's side of it.
describe("hercule runner --help", () => {
  it("shows the four daemon forms above the verbs", async () => {
    const out = await help("runner");
    const text = out.join("\n");
    expect(
      out.some((line) => /^hercule runner(\s\s|$)/.test(line.trim())),
      "no bare daemon form",
    ).toBe(true);
    expect(text).toContain("hercule runner --local");
    expect(text).toContain("hercule runner join");
    expect(text).toContain("hercule runner set-controller");
    expect(text).toContain("list");
  });
});

// a word the tree does not answer to, and the ones it does.
describe("an unknown command", () => {
  const fails = async (...argv: ReadonlyArray<string>) => {
    const { io, run } = cli();
    return { code: await run(...argv), err: io.stderr.join("\n") };
  };

  it("exits 2 on a hidden noun, help or not", async () => {
    const asked = await fails("auth", "--help");
    expect(asked.code).toBe(2);
    expect(asked.err).toContain("auth");
    expect(asked.err).toContain("api-key");
    expect(asked.err).toContain("task");

    const called = await fails("auth", "ws-ticket");
    expect(called.code).toBe(2);
    expect(called.err).toContain("auth");
  });

  it("exits 2 on the operation id spelled as a command", async () => {
    const keys = await fails("apiKey", "query");
    expect(keys.code).toBe(2);
    expect(keys.err).toContain("apiKey");
    expect(keys.err).toContain("api-key");

    const task = await fails("task", "query");
    expect(task.code).toBe(2);
    expect(task.err).toContain("query");
    expect(task.err).toContain("list");
  });

  it("exits 2 on the derived join-token verb and says what is valid there", async () => {
    const { code, err } = await fails("runner", "create-join-token");
    expect(code).toBe(2);
    expect(err).toContain("create-join-token");
    expect(err).toContain("join-token");
  });

  it("sends the listings that do exist to their own routes", async () => {
    const cases = [
      [["api-key", "list"], "/api/v1/api-keys"],
      [["task", "list"], "/api/v1/tasks"],
      [["runner", "join-token", "list"], "/api/v1/runners/join-tokens"],
    ] as const;
    for (const [argv, path] of cases) {
      const { fetch, run } = cli((request) =>
        request.path === "/api/v1/runners/join-tokens" ? [] : { items: [] },
      );
      expect(await run(...argv), argv.join(" ")).toBe(0);
      expect(fetch.calls[0], argv.join(" ")).toMatchObject({ method: "GET", path });
    }
  });
});

// a stdin field at a terminal.
describe("a stdin field with no pipe", () => {
  it("exits 2 naming the field and the piped form, and never reads stdin", async () => {
    const fetch = stubFetch(() => ({}));
    const base = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
    });
    let reads = 0;
    const io = {
      ...base,
      isTty: () => true,
      stdin: () => {
        reads += 1;
        return Promise.reject(new Error("stdin was read at a terminal"));
      },
    };

    expect(await main(["--home", home, "session", "input", id("aaaaaaa1")], io)).toBe(2);
    expect(reads).toBe(0);
    expect(base.stderr.join("\n")).toContain("text");
    expect(base.stderr.join("\n")).toContain("| hercule session input");
    expect(fetch.calls).toEqual([]);
  });

  it("shows the line the caller wrote, with the pipe it was missing", async () => {
    const base = stubIo({ env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" } });
    const io = { ...base, isTty: () => true };

    expect(await main(["--home", home, "task", "create", "--title", "x"], io)).toBe(2);
    expect(base.stderr.join("\n")).toContain(
      'echo "<description>" | hercule task create --title x',
    );
  });
});

describe("running an operation", () => {
  it("sends the payload the flags describe, under the resolved credential", async () => {
    const { fetch, run } = cli(() => profile("aaaaaaa1", "reviewer"));

    expect(await run("profile", "create", "--name", "reviewer", "--grant", "task.read")).toBe(0);
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
      "--grant",
      "task.read",
      "--grant",
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
      defaultRunnerId: null,
    }));
    await run("controller", "read");
    expect(io.stdout).toEqual([
      "id               abcdef12",
      "publicKey        key",
      "version          0.1.0",
      "defaultRunnerId",
    ]);
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
    await run("profile", "list");
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
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
      stdin: "s3cret\n",
    });
    expect(await main(["--home", home, "secret", "set", "connection", "github", "token"], io)).toBe(
      0,
    );
    expect(fetch.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/v1/secrets/connection/github/token",
      body: { value: "s3cret" },
    });
  });

  it("reads two passwords as two lines of stdin, in schema order", async () => {
    const fetch = stubFetch(() => ({}));
    const io = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
      stdin: "old-password\nnew-password\n",
    });
    expect(await main(["--home", home, "user", "set-password"], io)).toBe(0);
    expect(fetch.calls[0]?.body).toEqual({ current: "old-password", next: "new-password" });
    expect(io.stdout).toEqual(["ok"]);
  });

  it("has no plain flag for any password", async () => {
    const { io, run } = cli();
    expect(await run("user", "set-password", "--current", "p")).toBe(2);
    expect(io.stderr.join("\n")).toContain("--current-stdin");
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
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
    });
    expect(await main(["--home", home, "profile", "list", "--all", "--json"], io)).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      items: [profile("aaaaaaa1", "one"), profile("aaaaaaa2", "two"), profile("aaaaaaa3", "three")],
    });
    expect(fetch.calls.length).toBe(3);
  });

  it("starts the --all sweep at --cursor instead of discarding it", async () => {
    const fetch = stubFetch((request) => {
      const cursor = request.query.get("cursor");
      if (cursor === null) return page([profile("aaaaaaa1", "one")], "c2");
      if (cursor === "c2") return page([profile("aaaaaaa2", "two")], "c3");
      return page([profile("aaaaaaa3", "three")]);
    });
    const io = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
    });
    expect(
      await main(["--home", home, "profile", "list", "--all", "--cursor", "c2", "--json"], io),
    ).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      items: [profile("aaaaaaa2", "two"), profile("aaaaaaa3", "three")],
    });
    expect(fetch.calls[0]?.query.get("cursor")).toBe("c2");
    expect(fetch.calls.length).toBe(2);
  });

  it("passes --limit and --sort through", async () => {
    const { fetch, run } = cli(() => ({ items: [] }));
    await run("profile", "list", "--limit", "2", "--sort", "name:desc");
    expect(fetch.calls[0]?.query.get("limit")).toBe("2");
    expect(fetch.calls[0]?.query.get("sort")).toBe("name:desc");
    expect(fetch.calls[0]?.path).toBe("/api/v1/profiles");
  });

  it("leaves the direction out when --sort names only a field", async () => {
    const { fetch, run } = cli(() => ({ items: [] }));
    await run("profile", "list", "--sort", "name");
    expect(fetch.calls[0]?.query.get("sort")).toBe("name");
  });

  it("rejects a sort direction that is neither asc nor desc", async () => {
    const { io, run } = cli();
    expect(await run("profile", "list", "--sort", "name:sideways")).toBe(2);
    expect(io.stderr.join("\n")).toContain("is not asc or desc");
  });

  it("rejects a sort field the operation does not declare", async () => {
    const { io, run } = cli();
    expect(await run("profile", "list", "--sort", "createdAt")).toBe(2);
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
    stubIo({ env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" }, fetch });

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

  it("resolves a tail against a listing that answers with the whole set", async () => {
    // A provider instance listing is the whole set rather than a page, because
    // there is one instance per provider and a handful of providers.
    const instance = {
      id: id("cccccccc"),
      providerId: "claude-code",
      name: "Claude Code",
      config: {},
      displayName: "Claude Code",
      binaryName: "claude",
      secretFields: [],
      declared: {
        steering: "native",
        fork: "native",
        modelSwitch: "in-session",
        accessModes: {
          "approval-required": "native",
          "auto-accept-edits": "native",
          auto: "native",
          "full-access": "native",
        },
        mcpPassthrough: "native",
        disallowedTools: "native",
        structuredOutput: "supported",
      },
      snapshots: [],
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
    };
    const fetch = stubFetch((request) =>
      request.path === "/api/v1/providers" && request.method === "GET" ? [instance] : instance,
    );
    const stub = io(fetch);
    expect(await main(["--home", home, "provider", "read", "cccccccc", "--json"], stub)).toBe(0);
    expect(fetch.calls[1]?.path).toBe(`/api/v1/providers/${id("cccccccc")}`);
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

  it("sends a numeric id as written, with no tail lookup", async () => {
    const fetch = stubFetch(() => ({
      id: 42,
      source: "platform",
      connectionId: null,
      system: "hercule",
      kind: "auth.login.failed",
      occurredAt: "2026-09-04T10:00:00.000Z",
      receivedAt: "2026-09-04T10:00:00.000Z",
      dedupKey: "d1",
      refs: [],
      url: null,
      payload: {},
      raw: null,
      actor: null,
    }));
    const stub = io(fetch);
    expect(await main(["--home", home, "event", "read", "42", "--json"], stub)).toBe(0);
    expect(fetch.calls.length).toBe(1);
    expect(fetch.calls[0]?.path).toBe("/api/v1/events/42");
  });

  it("sweeps in an order writes do not move, so a touched row is still found", async () => {
    const row = (tail: string, at: string) => ({
      id: id(tail),
      title: `task ${tail}`,
      description: "",
      status: "open",
      priority: "normal",
      labels: [] as Array<string>,
      provenance: [] as Array<never>,
      createdAt: at,
      updatedAt: at,
      statusChangedAt: at,
    });
    const rows = [
      row("aaaaaaa1", "2026-01-01T00:00:00.000Z"),
      row("bbbbbbb2", "2026-01-02T00:00:00.000Z"),
      row("ccccccc3", "2026-01-03T00:00:00.000Z"),
    ];
    let touched = false;

    // A controller that pages two rows at a time, in whatever order the sweep
    // asks for. Between the first page and the second, the row the sweep has
    // not reached yet is written: under `updatedAt` it jumps to the head, ahead
    // of the cursor, and is never visited.
    const fetch = stubFetch((request) => {
      if (request.path !== "/api/v1/tasks" || request.method !== "GET") return rows[0];
      const [field = "updatedAt", direction = "desc"] = (
        request.query.get("sort") ?? "updatedAt:desc"
      ).split(":");
      const key = field as "createdAt" | "updatedAt";
      const sign = direction === "asc" ? 1 : -1;
      const ordered = [...rows].sort((a, b) => (a[key] < b[key] ? -1 : 1) * sign);
      const cursor = request.query.get("cursor");
      const from = cursor === null ? 0 : ordered.findIndex((item) => item.id === cursor) + 1;
      const items = ordered.slice(from, from + 2);
      if (!touched) {
        touched = true;
        rows[0]!.updatedAt = "2026-01-04T00:00:00.000Z";
      }
      const last = items[items.length - 1];
      return {
        items,
        ...(from + 2 < ordered.length && last !== undefined ? { nextCursor: last.id } : {}),
      };
    });
    const stub = io(fetch);
    expect(await main(["--home", home, "task", "read", "aaaaaaa1", "--json"], stub)).toBe(0);
    expect(fetch.calls.at(-1)?.path).toBe(`/api/v1/tasks/${id("aaaaaaa1")}`);
  });

  it("exits 2 on a tail where the row names no listing, and calls nothing", async () => {
    const fetch = stubFetch(() => ({}));
    const stub = io(fetch);
    // A queued input's own id is a Hercule id nothing lists on its own.
    expect(await main(["--home", home, "input", "cancel", id("aaaaaaa1"), "1f3a9c2e"], stub)).toBe(
      2,
    );
    expect(fetch.calls).toEqual([]);
    expect(stub.stderr.join("\n")).toContain("full id");
  });

  it("sends a name that only looks like a tail, where the field holds no Hercule id", async () => {
    const fetch = stubFetch(() => ({ items: [] }));
    const stub = io(fetch);

    expect(await main(["--home", home, "secret", "list", "--owner-id", "deadbeef"], stub)).toBe(0);

    // A secret's owner is a plugin, a runner or a connection by name; nothing
    // lists one id for all of them, and `deadbeef` is a name like any other.
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.query.get("ownerId")).toBe("deadbeef");
  });

  it("refuses a tail shorter than eight characters before calling anything", async () => {
    const fetch = withProfiles(() => ({}));
    const stub = io(fetch);
    expect(await main(["--home", home, "profile", "read", "abc"], stub)).toBe(2);
    expect(fetch.calls.length).toBe(0);
    expect(stub.stderr.join("\n")).toContain("at least 8 characters");
  });
});

describe("failures", () => {
  it("exits 2 on an unknown noun and lists what is valid there", async () => {
    const { io, run } = cli();
    expect(await run("nope", "read")).toBe(2);
    expect(io.stderr.join("\n")).toContain("nope");
    expect(io.stderr.join("\n")).toContain("task");
  });

  it("exits 2 on an unknown flag and points at --help", async () => {
    const { io, run } = cli();
    expect(await run("profile", "create", "--nope", "x")).toBe(2);
    expect(io.stderr.join("\n")).toContain("hercule profile create --help");
  });

  it("exits 2 when a required flag is missing", async () => {
    const { io, run } = cli();
    expect(await run("profile", "create")).toBe(2);
    expect(io.stderr.join("\n")).toContain("missing required --name, --grant");
  });

  it("exits 1 on an error envelope and prints the missing grant verbatim", async () => {
    const { io, run } = cli(() =>
      envelope("forbidden", 403, "missing grant permission.write", { grant: "permission.write" }),
    );
    expect(await run("profile", "create", "--name", "x", "--grant", "task.read")).toBe(1);
    expect(io.stderr.join("\n")).toContain("missing grant permission.write");
  });

  it("prints the error envelope verbatim under --json", async () => {
    const { io, run } = cli(() => envelope("not_found", 404, "no such profile"));
    expect(await run("profile", "delete", id("aaaaaaa1"), "--json")).toBe(1);
    expect(JSON.parse(io.stderr.join("\n"))).toEqual({
      error: { code: "not_found", message: "no such profile" },
    });
  });

  it("exits 2 when a flag's value does not fit its field, and sends nothing", async () => {
    const { io, fetch, run } = cli();
    expect(
      await run(
        "task",
        "create",
        "--title",
        "a task",
        "--provenance",
        '{"note":"nothing that names anything"}',
      ),
    ).toBe(2);
    expect(fetch.calls).toEqual([]);
    expect(io.stderr.join("\n")).toContain("--provenance: A provenance entry names at least one");
    expect(io.stderr.join("\n")).toContain("run `hercule task create --help`");
  });

  it("names a field read from stdin by its name, never by a flag it does not have", async () => {
    // An empty pipe is a value the field refuses, and the caller has no
    // `--text` to correct: the message has to point at the pipe.
    const { io, fetch, run } = cli();
    expect(await run("session", "input", id("aaaaaaa1"))).toBe(2);
    expect(fetch.calls).toEqual([]);
    expect(io.stderr.join("\n")).toContain("text (on stdin)");
    expect(io.stderr.join("\n")).not.toContain("--text");
  });

  it("exits 3 when the controller cannot be reached", async () => {
    const fetch = stubFetch(() => {
      throw new TypeError("connect ECONNREFUSED");
    });
    const io = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
    });
    expect(await main(["--home", home, "controller", "read"], io)).toBe(3);
    expect(io.stderr.join("\n")).toContain("cannot reach");
  });

  it("exits 3 when no credential resolves", async () => {
    const io = stubIo({ env: {} });
    expect(await main(["--home", home, "controller", "read"], io)).toBe(3);
    expect(io.stderr.join("\n")).toContain("hercule login");
  });
});

/** An Agent as the API answers one, named by its whole id so a tail case can pick its own. */
const buildAgentRecord = (agentId: string, name: string) => ({
  id: agentId,
  name,
  systemPrompt: "You assess tasks.",
  instanceId: id("cccccccc"),
  permissionProfileId: id("dddddddd"),
  accessMode: "full-access",
  model: null,
  disallowedTools: [] as Array<string>,
  unenforced: [] as Array<string>,
  createdAt: "2026-09-19T10:00:00.000Z",
  updatedAt: "2026-09-19T10:00:00.000Z",
});

describe("hercule session spawn --agent", () => {
  const AGENT = buildAgentRecord(id("aaaaaaa1"), "triager");

  const SPAWNED = {
    id: id("eeeeeee1"),
    title: "Assess this task.",
    status: "starting",
    resumable: false,
    permissionProfileId: AGENT.permissionProfileId,
    agentId: AGENT.id,
    instanceId: AGENT.instanceId,
    runnerId: id("ffffffff"),
    workspaceId: null,
    projectId: null,
    requestedAccessMode: "full-access",
    accessMode: "full-access",
    nativeSessionId: null,
    modelSelection: { model: "claude-haiku-4-5", options: {} },
    parentSessionId: null,
    openRequest: null,
    createdAt: "2026-09-19T10:01:00.000Z",
    startedAt: null,
    exitedAt: null,
    lastActivityAt: "2026-09-19T10:01:00.000Z",
    unenforced: [] as Array<string>,
  };

  const stubSpawn = () => {
    const fetch = stubFetch((request) =>
      request.path === "/api/v1/agents" && request.method === "GET" ? { items: [AGENT] } : SPAWNED,
    );
    return {
      fetch,
      io: stubIo({
        env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
        fetch,
        stdin: "Assess this task.\n",
      }),
    };
  };

  it("resolves an agent tail through the agent listing and sends the canonical id", async () => {
    const { fetch, io } = stubSpawn();

    expect(
      await main(["--home", home, "session", "spawn", "--agent", "aaaaaaa1", "--json"], io),
    ).toBe(0);

    // The wire never carries a tail: the listing is read first, exactly as it
    // is for a positional id.
    expect(fetch.calls[0]?.path).toBe("/api/v1/agents");
    expect(fetch.calls[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/sessions",
      body: { agentId: AGENT.id, prompt: "Assess this task." },
    });
  });

  it("resolves a profile tail on a flag through the profile listing", async () => {
    const PROFILE = profile("dddddddd", "worker");
    const fetch = stubFetch((request) =>
      request.path === "/api/v1/profiles" && request.method === "GET"
        ? { items: [PROFILE] }
        : SPAWNED,
    );
    const io = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
      stdin: "Assess this task.\n",
    });

    expect(await main(["--home", home, "session", "spawn", "--profile", "dddddddd"], io)).toBe(0);

    // A flag holding an id takes a tail like a positional one does: the
    // listing is read first and the wire carries the canonical id.
    expect(fetch.calls[0]?.path).toBe("/api/v1/profiles");
    expect(fetch.calls[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/sessions",
      body: { permissionProfileId: PROFILE.id },
    });
  });

  it("uses a full agent id without a lookup, and carries the schema as written", async () => {
    const { fetch, io } = stubSpawn();
    const schema =
      '{"type":"object","additionalProperties":false,"required":["verdict"],"properties":{"verdict":{"type":"string","enum":["accept","dismiss"]}}}';

    expect(
      await main(
        ["--home", home, "session", "spawn", "--agent", AGENT.id, "--output-schema", schema],
        io,
      ),
    ).toBe(0);

    expect(fetch.calls.length).toBe(1);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/sessions",
      body: { agentId: AGENT.id, outputSchema: JSON.parse(schema) as unknown },
    });
  });
});

describe("hercule session list --agent", () => {
  const AGENTS = [
    buildAgentRecord(id("aaaaaaa1"), "triager"),
    buildAgentRecord("0192f0a1-0000-7000-8000-999911112222", "reviewer"),
  ];

  const stubAgentListing = (agents: ReadonlyArray<unknown>) => {
    const fetch = stubFetch((request) =>
      request.path === "/api/v1/agents" ? { items: agents } : { items: [] },
    );
    return {
      fetch,
      io: stubIo({ env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" }, fetch }),
    };
  };

  it("resolves the agent tail and filters on the canonical id", async () => {
    const { fetch, io } = stubAgentListing(AGENTS);

    expect(
      await main(["--home", home, "session", "list", "--agent", "aaaaaaa1", "--json"], io),
    ).toBe(0);

    expect(fetch.calls[0]?.path).toBe("/api/v1/agents");
    expect(fetch.calls[1]?.query.get("agentId")).toBe(id("aaaaaaa1"));
  });

  it("answers conflict when the tail could be either of two agents", async () => {
    const { io } = stubAgentListing([
      buildAgentRecord("0192f0a1-0000-7000-8000-000011112222", "one"),
      buildAgentRecord("0192f0a1-0000-7000-8000-999911112222", "two"),
    ]);

    expect(
      await main(["--home", home, "session", "list", "--agent", "11112222", "--json"], io),
    ).toBe(1);

    const printed = JSON.parse(io.stderr.join("\n")) as { error: { code: string } };
    expect(printed.error.code).toBe("conflict");
  });

  it("asks for the sessions nobody drives by hand with --thread", async () => {
    const { fetch, io } = stubAgentListing(AGENTS);

    expect(await main(["--home", home, "session", "list", "--thread", "true", "--json"], io)).toBe(
      0,
    );

    // No agent named, so no listing was read for one.
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.query.get("thread")).toBe("true");
  });
});

describe("hercule transcript read: a turn that answered under a schema", () => {
  const SESSION_ID = id("eeeeeee1");
  const VALUE = { verdict: "accept", confidence: 0.9 };

  const buildTurnRow = (
    position: number,
    structuredResult: Record<string, unknown>,
  ): Record<string, unknown> => ({
    position,
    at: "2026-09-19T10:02:00.000Z",
    event: {
      _tag: "turn.completed",
      eventId: `e${position}`,
      sessionId: SESSION_ID,
      at: "2026-09-19T10:02:00.000Z",
      turnId: `t${position}`,
      state: "completed",
      structuredResult,
    },
  });

  const ROWS = [
    buildTurnRow(1, { outcome: "ok", value: VALUE }),
    buildTurnRow(2, { outcome: "schema-failure", reason: "/verdict: not one of the enum values" }),
  ];

  const stubTranscriptRead = () => {
    const fetch = stubFetch(() => ({ items: ROWS }));
    return {
      fetch,
      io: stubIo({ env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" }, fetch }),
    };
  };

  it("shows each outcome as one line, the value as JSON and the failure by its reason", async () => {
    const { io } = stubTranscriptRead();

    expect(await main(["--home", home, "transcript", "read", SESSION_ID], io)).toBe(0);

    expect(io.stdout).toHaveLength(2);
    expect(io.stdout[0]).toContain("result: ok");
    expect(io.stdout[0]).toContain(JSON.stringify(VALUE));
    expect(io.stdout[1]).toContain("result: schema-failure: /verdict: not one of the enum values");
    // The result is a sentence on the line, not the generic field dump the
    // other keys of an event get.
    expect(io.stdout.join("\n")).not.toContain("structuredResult=");
  });

  it("carries the result verbatim under --json", async () => {
    const { io } = stubTranscriptRead();

    expect(await main(["--home", home, "transcript", "read", SESSION_ID, "--json"], io)).toBe(0);

    const printed = JSON.parse(io.stdout.join("\n")) as {
      items: ReadonlyArray<{ event: { structuredResult: unknown } }>;
    };
    expect(printed.items.map((row) => row.event.structuredResult)).toEqual([
      { outcome: "ok", value: VALUE },
      { outcome: "schema-failure", reason: "/verdict: not one of the enum values" },
    ]);
  });
});

// A positional whose field carries a shorthand is decoded by that field's own
// schema before the call, so the wire never carries the terminal's spelling.
describe("a positional a field's own schema decodes", () => {
  it("sends the decoded target, not the shorthand the agent typed", async () => {
    const { fetch, run } = cli(() => ({ subscriptionId: id("aaaaaaa1") }));

    expect(await run("subscription", "create", "github:pr:o/r#87")).toBe(0);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/subscriptions",
      body: { target: { kind: "ref", ref: "github:pr:o/r#87" } },
    });
  });
});

// An agent reads one help screen and then makes the call. The last line is what
// tells it which operation that is, where it lands, and what its profile must
// hold for the call to be let through.
describe("the last line of every command's help", () => {
  it("names the operation, its route, and the grant it needs", async () => {
    const rows = Object.entries(CLI as Record<string, { command?: string; hidden?: true }>);
    for (const [id, row] of rows) {
      if (row.hidden === true) continue;
      const printed = lastLine(await help(...row.command!.split(" ")));
      const operation = OPERATIONS[id as OperationId];
      expect(printed, row.command).toContain(`operation ${id}`);
      expect(printed, row.command).toContain(`${operation.method} ${operation.path}`);
      // A grant always contains a dot. The requirements that are not grants
      // are written as prose on this line, not as the marker word.
      if (operation.requires.includes(".")) {
        expect(printed, row.command).toContain(operation.requires);
      }
    }
  });
});

/**
 * A workflow's source is a document with newlines and comments, so it travels
 * on stdin and never in argv. A create has nothing to send without it and
 * reads it unasked. An update reads it only when `--source-stdin` asks, so an
 * empty pipe never blanks a stored workflow.
 *
 * The two directions mirror each other. Going in, the source is stdin minus
 * exactly one final line break, `\n` or `\r\n`, which is the rule every stdin
 * field follows. Coming out, `workflow read` prints the source and one line
 * break after it, the one the source itself uses. So a file that ends in a
 * line break comes back byte for byte. A file with no final line break comes
 * back with one.
 */
describe("the source of a workflow through the CLI", () => {
  const CREDENTIAL_ENV = { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" };
  /** A file as an editor saves it: one newline at the end. */
  const WORKFLOW_FILE = [
    "# Files one task.",
    "name: File a task",
    "",
    "steps:",
    "  - id: file_task",
    "    kind: action",
    "    action: task.create",
    "",
  ].join("\n");
  /** The source that file sends: the file minus its final newline. */
  const WORKFLOW_SOURCE = WORKFLOW_FILE.slice(0, -1);
  const WORKFLOW_ID = id("aaaaaaa1");

  const buildWorkflowRecord = (source: string) => ({
    id: WORKFLOW_ID,
    enabled: false,
    source,
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:00:00.000Z",
  });

  /** What the controller answers a save with: the stored record and the save's warnings. */
  const SAVE_ANSWER = { workflow: buildWorkflowRecord(WORKFLOW_SOURCE), warnings: [] };

  /** The bytes a terminal receives: each line the CLI writes, and the newline after it. */
  const joinPrintedLines = (lines: ReadonlyArray<string>): string =>
    lines.map((line) => `${line}\n`).join("");

  it("sends stdin minus exactly one final newline as a create's source, with no marker asked for", async () => {
    // The second file ends in a blank line, so one newline stays in its source.
    for (const [stdin, source] of [
      [WORKFLOW_FILE, WORKFLOW_SOURCE],
      [`${WORKFLOW_FILE}\n`, WORKFLOW_FILE],
    ] as const) {
      const fetch = stubFetch(() => SAVE_ANSWER);
      const io = stubIo({ env: CREDENTIAL_ENV, fetch, stdin });

      expect(await main(["--home", home, "workflow", "create"], io)).toBe(0);
      expect(fetch.calls).toHaveLength(1);
      expect(fetch.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/workflows" });
      expect(fetch.calls[0]!.body).toEqual({ source });
    }
  });

  it("sends stdin minus exactly one final newline as an update's source when --source-stdin asks for it", async () => {
    const fetch = stubFetch(() => SAVE_ANSWER);
    const io = stubIo({ env: CREDENTIAL_ENV, fetch, stdin: WORKFLOW_FILE });

    expect(
      await main(["--home", home, "workflow", "update", WORKFLOW_ID, "--source-stdin"], io),
    ).toBe(0);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({
      method: "PATCH",
      path: `/api/v1/workflows/${WORKFLOW_ID}`,
    });
    expect(fetch.calls[0]!.body).toEqual({ source: WORKFLOW_SOURCE });
  });

  it("reads no stdin for an update that only turns the workflow on", async () => {
    const fetch = stubFetch(() => ({
      ...SAVE_ANSWER,
      workflow: { ...SAVE_ANSWER.workflow, enabled: true },
    }));
    const stubbed = stubIo({ env: CREDENTIAL_ENV, fetch });
    let stdinReads = 0;
    const io = {
      ...stubbed,
      stdin: () => {
        stdinReads += 1;
        return Promise.resolve(WORKFLOW_FILE);
      },
    };

    expect(
      await main(["--home", home, "workflow", "update", WORKFLOW_ID, "--enabled", "true"], io),
    ).toBe(0);
    expect(stdinReads).toBe(0);
    expect(fetch.calls[0]?.body).toEqual({ enabled: true });
  });

  it("has no inline flag for the source on either command, and sends nothing", async () => {
    for (const argv of [
      ["workflow", "create", "--source", "name: inline"],
      ["workflow", "update", WORKFLOW_ID, "--source", "name: inline"],
    ]) {
      const fetch = stubFetch(() => SAVE_ANSWER);
      const io = stubIo({ env: CREDENTIAL_ENV, fetch, stdin: WORKFLOW_FILE });

      expect(await main(["--home", home, ...argv], io), argv.join(" ")).toBe(2);
      expect(io.stderr.join("\n"), argv.join(" ")).toContain("--source-stdin");
      expect(fetch.calls, argv.join(" ")).toEqual([]);
    }
  });

  it("prints a read's source and exactly one newline after it, and no key-value lines", async () => {
    // The first source ends in a newline, as one saved over HTTP from a file
    // does; the second is what the CLI itself sent for the same file.
    for (const source of [WORKFLOW_FILE, WORKFLOW_SOURCE]) {
      const fetch = stubFetch(() => buildWorkflowRecord(source));
      const io = stubIo({ env: CREDENTIAL_ENV, fetch });

      expect(await main(["--home", home, "workflow", "read", WORKFLOW_ID], io)).toBe(0);
      expect(fetch.calls[0]).toMatchObject({
        method: "GET",
        path: `/api/v1/workflows/${WORKFLOW_ID}`,
      });
      expect(joinPrintedLines(io.stdout)).toBe(`${source}\n`);
      expect(io.stderr).toEqual([]);
    }
  });

  it("gives back a file saved with CRLF line breaks byte for byte, through a create and a read", async () => {
    const crlfFile = WORKFLOW_FILE.replaceAll("\n", "\r\n");
    // The controller stores the source it is sent, and a read answers it.
    let storedSource = "";
    const fetch = stubFetch((request) => {
      if (request.method !== "POST") return buildWorkflowRecord(storedSource);
      storedSource = (request.body as { source: string }).source;
      return { workflow: buildWorkflowRecord(storedSource), warnings: [] };
    });
    const createIo = stubIo({ env: CREDENTIAL_ENV, fetch, stdin: crlfFile });
    expect(await main(["--home", home, "workflow", "create"], createIo)).toBe(0);
    expect(storedSource).toBe(crlfFile.slice(0, -"\r\n".length));

    const readIo = stubIo({ env: CREDENTIAL_ENV, fetch });
    expect(await main(["--home", home, "workflow", "read", WORKFLOW_ID], readIo)).toBe(0);
    expect(joinPrintedLines(readIo.stdout)).toBe(crlfFile);
  });
});
