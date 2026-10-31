import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  CLI,
  MAX_SKILL_BYTES,
  NOUNS,
  ONLY_THE_USER_IMPORTS_SKILLS,
  OPERATIONS,
  type OperationId,
  type ProviderAccount,
} from "@hercule/contract";
import { main, readSetupUrl } from "./index";
import { buildErrorEnvelope, buildId, stubFetch, stubIo, type Handler } from "./testing";

const SETUP_URL = "http://127.0.0.1:4937/setup?token=abc";

/** Returns a Profile with the contract's type; the client decodes what the stub returns. */
const buildProfile = (tail: string, name: string) => ({
  id: buildId(tail),
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

/** Returns a CLI connected to a stub controller, with a credential in its environment. */
const createStubCli = (handler: Handler = () => ({})) => {
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

  it("reads the file the controller wrote, without a credential", () => {
    writeSetupUrl();
    expect(readSetupUrl(["setup-url", "--home", home], {})).toEqual(Result.succeed(SETUP_URL));
    expect(readSetupUrl(["setup-url"], { HERCULE_HOME: home })).toEqual(Result.succeed(SETUP_URL));
  });

  it("prints the URL on stdout and nothing else", async () => {
    writeSetupUrl();
    const { io, run } = createStubCli();
    expect(await run("setup-url")).toBe(0);
    expect(io.stdout).toEqual([SETUP_URL]);
    expect(io.stderr).toEqual([]);
  });

  it("reports a missing file on stderr as missing local state, not as an API error", async () => {
    const { io, run } = createStubCli();
    expect(await run("setup-url")).toBe(3);
    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain(join(home, "setup-url"));
  });

  it("reports a malformed global option", () => {
    const result = readSetupUrl(["setup-url", "--home"], {});
    expect(Result.isFailure(result) && result.failure).toContain("directory");
  });
});

/** Runs `--help` for the given words, checks that it exits 0, and returns the printed lines. */
const runHelp = async (...argv: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const { io, run } = createStubCli();
  expect(await run(...argv, "--help"), `hercule ${argv.join(" ")} --help`).toBe(0);
  return io.stdout;
};

/** Returns the index of the line that starts a section, or -1. */
const findSection = (out: ReadonlyArray<string>, marker: string): number =>
  out.findIndex((line) => line.trim().toLowerCase().startsWith(marker));

/** Returns the text from one section marker up to the next. */
const readBetweenSections = (out: ReadonlyArray<string>, from: string, to: string): string =>
  out.slice(findSection(out, from), findSection(out, to)).join("\n");

const findLastLine = (out: ReadonlyArray<string>): string =>
  [...out].reverse().find((line) => line.trim() !== "") ?? "";

const startsWithWord = (line: string, word: string): boolean =>
  new RegExp(`^${word}\\b`).test(line.trim());

/**
 * Checks whether a root help line is the line that names a noun. A noun is
 * indented by two spaces, and the wrapped summary lines under it by more, so
 * a summary line that happens to start with a noun's word (`run, and where
 * those steps run.`) is not taken for the noun.
 */
const isNounLine = (line: string, noun: string): boolean => new RegExp(`^  ${noun}\\s`).test(line);

/** Returns the root help's block for one noun: its line, and every line before the next noun. */
const readNounBlock = (out: ReadonlyArray<string>, noun: string): string => {
  const from = out.findIndex((line) => isNounLine(line, noun));
  expect(from, `the root help has no ${noun} noun`).toBeGreaterThan(-1);
  const next = out.findIndex(
    (line, index) =>
      index > from && Object.keys(NOUNS).some((other) => other !== noun && isNounLine(line, other)),
  );
  return out.slice(from, next === -1 ? out.length : next).join("\n");
};

/** Every visible command, as the words after `hercule`. */
const spellings = Object.values(CLI as Record<string, { hidden?: true; command?: string }>)
  .filter((row) => row.hidden !== true)
  .map((row) => (row.command ?? "").split(" "));

// A command's help, which always has the same sections in the same order.
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
    const out = await runHelp("session", "input");
    const at = MARKERS.map((marker) => findSection(out, marker));
    for (const [index, marker] of MARKERS.entries()) {
      expect(at[index], `${marker} is missing`).toBeGreaterThan(-1);
    }
    expect(at, MARKERS.join(" then ")).toEqual([...at].sort((a, b) => a - b));
    expect(at[0]).toBeGreaterThan(0);
    expect(out.slice(0, at[0]).join("\n")).toContain("On an idle session it starts a turn");
  });

  it("renders the example as a piped shell line", async () => {
    const out = await runHelp("session", "input");
    expect(out.join("\n")).toMatch(
      /echo "Carry on, and run the tests when you are done\." \| hercule session input 1f3a9c2e/,
    );
  });

  it("describes the id argument and each flag", async () => {
    const text = (await runHelp("session", "input")).join("\n");
    expect(text).toContain("<id>");
    expect(text).toContain("The session's id, or a tail of eight or more characters.");
    expect(text).toContain("--model");
    expect(text).toContain("Switch the session to this model from this turn on.");
    expect(text).toContain("--options");
    expect(text).toContain(
      "The per-model choices as inline JSON, applied before the input is stored.",
    );
  });

  it("offers --image, and says the text may then be empty", async () => {
    const out = await runHelp("session", "input");
    expect(readBetweenSections(out, "flags:", "stdin:")).toMatch(
      /--image <path>\s+optional; repeatable/,
    );
    expect(readBetweenSections(out, "stdin:", "returns:").replace(/\s+/g, " ")).toContain(
      "With --image it may be empty, and when stdin is a terminal it is not read and the text is empty.",
    );
  });

  it("says the text is required on stdin and that there is no --text flag", async () => {
    const out = await runHelp("session", "input");
    const block = readBetweenSections(out, "stdin:", "returns:");
    expect(block.toLowerCase()).toContain("required");
    expect(block.toLowerCase()).toContain("there is no --text flag");
  });

  it("names what the command returns", async () => {
    const block = readBetweenSections(await runHelp("session", "input"), "returns:", "errors:");
    expect(block).toContain("inputId");
    expect(block).toContain("result");
  });

  it("says what forbidden means and how to ask for the grant", async () => {
    const block = readBetweenSections(await runHelp("session", "input"), "errors:", "next:");
    expect(block).toContain("forbidden");
    expect(block).toContain("hercule permission request session.steer");
  });

  it("ends on the operation line", async () => {
    expect(findLastLine(await runHelp("session", "input"))).toBe(
      "operation session.input \u00b7 POST /api/v1/sessions/:id/input \u00b7 grant session.steer",
    );
  });
});

// Requesting a grant helps only when the grant is all that is missing, so a
// command that refuses a session for another reason says so instead.
describe("the forbidden line of a refusal no grant lifts", () => {
  /** Returns a command's errors section with its lines joined, so a wrapped phrase reads whole. */
  const readErrors = async (...words: ReadonlyArray<string>): Promise<string> =>
    readBetweenSections(await runHelp(...words), "errors:", "operation ").replace(/\s+/g, " ");

  it("tells a session to ask the user when only the user may call the command", async () => {
    const errors = await readErrors("api-key", "create");
    expect(errors).toContain("forbidden only the user may make this call");
    expect(errors).toContain("ask the user to run the command");
    expect(errors).not.toContain("hercule permission request credential.write");
    expect(errors).toContain(
      "unauthenticated no credential, or one this operation does not accept",
    );
  });

  it("names thread.start as a grant to request, and the profile rule no grant lifts, when a session spawns", async () => {
    const errors = await readErrors("session", "spawn");
    expect(errors).toContain("you lack session.spawn, which a Permission Request can get you");
    expect(errors).toContain(
      "starting a Thread without thread.start, which a Permission Request can also get you",
    );
    expect(errors).toContain("a Thread may not use a profile that grants more than your own");
    expect(errors).not.toContain("only the user may");
  });
});

describe("hercule task list --help", () => {
  it("shows the paging section and a page's items", async () => {
    const out = await runHelp("task", "list");
    expect(findSection(out, "paging:"), "no paging section").toBeGreaterThan(-1);
    expect(out.slice(findSection(out, "returns:")).join("\n")).toContain("items[]");
  });

  it("says --sort repeats and what a repeat means", async () => {
    const flags = readBetweenSections(await runHelp("task", "list"), "flags:", "paging:");
    const text = flags.replace(/\s+/g, " ");
    expect(text).toContain("optional; repeatable; one of: updatedAt, createdAt, priority, status");
    expect(text).toContain(
      "Repeat to break ties: the first --sort orders the list, and each later one orders only the rows the ones before it leave equal. No direction means asc.",
    );
  });
});

describe("hercule profile list --help", () => {
  // A list with one sort field cannot take a second --sort, because the API
  // refuses a field named twice.
  it("does not offer to repeat --sort", async () => {
    const flags = readBetweenSections(await runHelp("profile", "list"), "flags:", "paging:");
    expect(flags).not.toContain("repeatable");
    expect(flags).toContain("No direction means asc.");
  });
});

describe("hercule session respond-to-approval-request --help", () => {
  it("lists --decision and no --answers among the flags", async () => {
    const block = readBetweenSections(
      await runHelp("session", "respond-to-approval-request"),
      "flags:",
      "returns:",
    );
    expect(block).toContain("--decision");
    expect(block).not.toContain("--answers");
  });
});

describe("hercule session respond-to-question --help", () => {
  it("lists --answers and no --decision among the flags", async () => {
    const block = readBetweenSections(
      await runHelp("session", "respond-to-question"),
      "flags:",
      "returns:",
    );
    expect(block).toContain("--answers");
    expect(block).not.toContain("--decision");
  });
});

describe("hercule session --help", () => {
  const VERBS = [
    "list",
    "read",
    "subagent list",
    "spawn",
    "update",
    "input",
    "interrupt",
    "respond-to-approval-request",
    "respond-to-question",
    "stop",
    "continue",
  ];

  it("lists the eleven verbs, the nested subagent list among them, each with the grant it needs", async () => {
    const out = await runHelp("session");
    for (const verb of VERBS) {
      const line = out.find((each) => startsWithWord(each, verb));
      expect(line, `no line for session ${verb}`).toBeDefined();
      expect(line, `session ${verb} names no grant`).toContain("grant ");
    }
  });

  it("names the usual order in a flow line", async () => {
    const out = await runHelp("session");
    expect(findSection(out, "flow:"), "no flow line").toBeGreaterThan(-1);
    expect(out.join("\n")).toContain("hercule session spawn starts one");
  });
});

describe("hercule --help", () => {
  it("lists every visible noun with its verbs", async () => {
    const out = await runHelp();
    for (const words of spellings) {
      expect(readNounBlock(out, words[0]!), `${words.join(" ")} is not in the root help`).toContain(
        words[1]!,
      );
    }
  });

  it("shows the nested join-token noun under runner", async () => {
    const block = readNounBlock(await runHelp(), "runner");
    expect(block).toMatch(/join-token:\s+create\s+list\s+revoke/);
  });

  it("includes the conventions that apply everywhere", async () => {
    const text = (await runHelp()).join("\n");
    expect(text).toContain("--json");
    expect(text).toContain("exit");
    expect(text).toContain("hercule permission request");
    expect(text.replace(/\s+/g, " ")).toContain(
      "unless the command's help says only the user may make the call",
    );
    expect(text.replace(/\s+/g, " ")).toContain(
      "Where a list sorts on more than one field, --sort may be repeated",
    );
  });

  it("has no auth noun at all", async () => {
    const out = await runHelp();
    expect(out.filter((line) => startsWithWord(line, "auth"))).toEqual([]);
    expect(out.join("\n")).not.toContain("ws-ticket");
  });
});

// `hercule runner` is both an operation noun and the runner daemon.
describe("hercule runner --help", () => {
  it("shows the four daemon forms above the verbs", async () => {
    const out = await runHelp("runner");
    const text = out.join("\n");
    expect(
      out.some((line) => /^hercule runner(\s\s|$)/.test(line.trim())),
      "no bare daemon form",
    ).toBe(true);
    expect(text).toContain("hercule runner --local");
    expect(text).toContain("hercule runner join");
    expect(text).toContain("--no-service");
    expect(text).toContain("hercule runner set-controller");
    expect(text).toContain("list");
  });
});

// `hercule service` is a role of its own, so its help lives in @hercule/service.
// The root help still names it, because the root help is where people look.
describe("hercule service in the root help", () => {
  it("is named", async () => {
    expect((await runHelp()).join("\n")).toContain("hercule service <verb>");
  });
});

// An unknown word, and the valid words the error lists.
describe("an unknown command", () => {
  const runAndCaptureErrors = async (...argv: ReadonlyArray<string>) => {
    const { io, run } = createStubCli();
    return { code: await run(...argv), err: io.stderr.join("\n") };
  };

  it("exits 2 on a hidden noun, help or not", async () => {
    const asked = await runAndCaptureErrors("auth", "--help");
    expect(asked.code).toBe(2);
    expect(asked.err).toContain("auth");
    expect(asked.err).toContain("api-key");
    expect(asked.err).toContain("task");

    const called = await runAndCaptureErrors("auth", "ws-ticket");
    expect(called.code).toBe(2);
    expect(called.err).toContain("auth");
  });

  it("exits 2 on the operation id spelled as a command", async () => {
    const keys = await runAndCaptureErrors("apiKey", "query");
    expect(keys.code).toBe(2);
    expect(keys.err).toContain("apiKey");
    expect(keys.err).toContain("api-key");

    const task = await runAndCaptureErrors("task", "query");
    expect(task.code).toBe(2);
    expect(task.err).toContain("query");
    expect(task.err).toContain("list");
  });

  it("exits 2 on the derived join-token verb and says what is valid there", async () => {
    const { code, err } = await runAndCaptureErrors("runner", "create-join-token");
    expect(code).toBe(2);
    expect(err).toContain("create-join-token");
    expect(err).toContain("join-token");
  });

  it("sends the list commands that do exist to their routes", async () => {
    const cases = [
      [["api-key", "list"], "/api/v1/api-keys"],
      [["task", "list"], "/api/v1/tasks"],
      [["runner", "join-token", "list"], "/api/v1/runners/join-tokens"],
    ] as const;
    for (const [argv, path] of cases) {
      const { fetch, run } = createStubCli((request) =>
        request.path === "/api/v1/runners/join-tokens" ? [] : { items: [] },
      );
      expect(await run(...argv), argv.join(" ")).toBe(0);
      expect(fetch.calls[0], argv.join(" ")).toMatchObject({ method: "GET", path });
    }
  });
});

// A stdin field when stdin is a terminal.
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

    expect(await main(["--home", home, "session", "input", buildId("aaaaaaa1")], io)).toBe(2);
    expect(reads).toBe(0);
    expect(base.stderr.join("\n")).toContain("text");
    expect(base.stderr.join("\n")).toContain("| hercule session input");
    expect(fetch.calls).toEqual([]);
  });

  it("shows the caller's command line, with the missing pipe added", async () => {
    const base = stubIo({ env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" } });
    const io = { ...base, isTty: () => true };

    expect(await main(["--home", home, "task", "create", "--title", "x"], io)).toBe(2);
    expect(base.stderr.join("\n")).toContain(
      'echo "<description>" | hercule task create --title x',
    );
  });

  it("sends the images with empty text when --image is given, without reading stdin", async () => {
    writeFileSync(join(home, "shot.png"), "PNG!");
    const attachmentId = buildId("bbbbbbb2");
    const fetch = stubFetch((request) =>
      request.path === "/api/v1/attachments"
        ? Response.json(
            { id: attachmentId, name: "shot.png", mimeType: "image/png", sizeBytes: 4 },
            { status: 201 },
          )
        : { inputId: buildId("ccccccc3"), result: "opened" },
    );
    const base = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
    });
    const io = {
      ...base,
      isTty: () => true,
      stdin: () => Promise.reject(new Error("stdin was read at a terminal")),
    };
    const sessionId = buildId("aaaaaaa1");
    const argv = ["session", "input", sessionId, "--image", join(home, "shot.png")];

    expect(await main(["--home", home, ...argv], io)).toBe(0);
    expect(fetch.calls.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/v1/sessions/${sessionId}/input`,
      body: { text: "", attachments: [attachmentId] },
    });
  });
});

describe("running an operation", () => {
  it("sends the payload the flags describe, with the resolved credential", async () => {
    const { fetch, run } = createStubCli(() => buildProfile("aaaaaaa1", "reviewer"));

    expect(await run("profile", "create", "--name", "reviewer", "--grant", "task.read")).toBe(0);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/profiles",
      body: { name: "reviewer", grants: ["task.read"] },
      authorization: "Bearer test-token",
    });
  });

  it("repeats a list flag into a list", async () => {
    const { fetch, run } = createStubCli(() => ({
      ...buildProfile("aaaaaaa1", "reviewer"),
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
    const reviewer = buildProfile("aaaaaaa1", "reviewer");
    const { io, run } = createStubCli(() => reviewer);
    expect(await run("profile", "read", reviewer.id, "--json")).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual(reviewer);
  });

  it("prints an object as key-value lines, with ids as tails", async () => {
    const { io, run } = createStubCli(() => ({
      id: buildId("abcdef12"),
      publicKey: "key",
      version: "0.1.0",
      defaultRunnerId: null,
      localRunnerId: buildId("12345678"),
      textGeneration: { model: null, unavailableReason: null, lastFailure: null },
    }));
    await run("controller", "read");
    expect(io.stdout).toEqual([
      "id                                abcdef12",
      "publicKey                         key",
      "version                           0.1.0",
      "defaultRunnerId",
      "localRunnerId                     12345678",
      "textGeneration.model",
      "textGeneration.unavailableReason",
      "textGeneration.lastFailure",
    ]);
  });

  it("flattens a nested object into dotted keys", async () => {
    const { io, run } = createStubCli(() => ({
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
    const { io, run } = createStubCli(() => ({
      items: [buildProfile("aaaaaaa1", "one")],
      nextCursor: "c2",
    }));
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
      ownerKind: "plugin",
      ownerId: "github",
      name: "token",
      createdAt: "2026-09-04T10:00:00.000Z",
    }));
    const io = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
      stdin: "s3cret\n",
    });
    expect(await main(["--home", home, "secret", "set", "plugin", "github", "token"], io)).toBe(0);
    expect(fetch.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/v1/secrets/plugin/github/token",
      body: { value: "s3cret" },
    });
  });

  it("creates a connection from credentials alone, sending no label and no topics", async () => {
    const created = {
      id: buildId("aaaaaaa1"),
      type: "github/github",
      label: "octocat",
      displayName: "octocat",
      status: "connected",
      labels: [],
      config: {},
      feedIntervals: {},
      credentials: [{ name: "pat" }],
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
    };
    const fetch = stubFetch(() => Response.json(created, { status: 201 }));
    const io = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
      stdin: '{"pat":"x"}\n',
    });

    expect(
      await main(["--home", home, "connection", "create", "--type", "github/github"], io),
    ).toBe(0);
    expect(fetch.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/connections" });
    expect(fetch.calls[0]?.body).toEqual({ type: "github/github", credentials: { pat: "x" } });
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
    const { io, run } = createStubCli();
    expect(await run("user", "set-password", "--current", "p")).toBe(2);
    expect(io.stderr.join("\n")).toContain("--current-stdin");
  });

  it("rejects --value on a secret and says how to give the value", async () => {
    const { io, run } = createStubCli();
    expect(await run("secret", "set", "plugin", "github", "token", "--value", "s3cret")).toBe(2);
    expect(io.stderr.join("\n")).toContain("--value-stdin");
  });
});

describe("the permission commands", () => {
  it("asks for a grant with the grant as the positional and the reason as a flag", async () => {
    const { fetch, run } = createStubCli(() => ({
      requestId: buildId("aaaaaaa1"),
      subscriptionId: buildId("bbbbbbb2"),
    }));
    expect(
      await run("permission", "request", "task.delete", "--reason", "It duplicates a task."),
    ).toBe(0);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/permissions/request",
      body: { grant: "task.delete", reason: "It duplicates a task." },
    });
  });

  it("decides a request by its full id with --outcome", async () => {
    const { fetch, run } = createStubCli(() => ({}));
    const requestId = buildId("ccccccc3");
    expect(await run("permission", "decide", requestId, "--outcome", "session")).toBe(0);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/permissions/requests/${requestId}/decide`,
      body: { outcome: "session" },
    });
  });

  it("does not offer --operation, which only a program builds", async () => {
    expect(
      readBetweenSections(await runHelp("permission", "request"), "flags:", "returns:"),
    ).not.toContain("--operation");
  });
});

describe("paging", () => {
  const buildPage = (items: ReadonlyArray<unknown>, nextCursor?: string) => ({
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });

  it("follows nextCursor to the end under --all", async () => {
    const fetch = stubFetch((request) => {
      const cursor = request.query.get("cursor");
      if (cursor === null) return buildPage([buildProfile("aaaaaaa1", "one")], "c2");
      if (cursor === "c2") return buildPage([buildProfile("aaaaaaa2", "two")], "c3");
      return buildPage([buildProfile("aaaaaaa3", "three")]);
    });
    const io = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
    });
    expect(await main(["--home", home, "profile", "list", "--all", "--json"], io)).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      items: [
        buildProfile("aaaaaaa1", "one"),
        buildProfile("aaaaaaa2", "two"),
        buildProfile("aaaaaaa3", "three"),
      ],
    });
    expect(fetch.calls.length).toBe(3);
  });

  it("starts the --all read at --cursor instead of ignoring it", async () => {
    const fetch = stubFetch((request) => {
      const cursor = request.query.get("cursor");
      if (cursor === null) return buildPage([buildProfile("aaaaaaa1", "one")], "c2");
      if (cursor === "c2") return buildPage([buildProfile("aaaaaaa2", "two")], "c3");
      return buildPage([buildProfile("aaaaaaa3", "three")]);
    });
    const io = stubIo({
      env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" },
      fetch,
    });
    expect(
      await main(["--home", home, "profile", "list", "--all", "--cursor", "c2", "--json"], io),
    ).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      items: [buildProfile("aaaaaaa2", "two"), buildProfile("aaaaaaa3", "three")],
    });
    expect(fetch.calls[0]?.query.get("cursor")).toBe("c2");
    expect(fetch.calls.length).toBe(2);
  });

  it("passes --limit and --sort through", async () => {
    const { fetch, run } = createStubCli(() => ({ items: [] }));
    await run("profile", "list", "--limit", "2", "--sort", "name:desc");
    expect(fetch.calls[0]?.query.get("limit")).toBe("2");
    expect(fetch.calls[0]?.query.get("sort")).toBe("name:desc");
    expect(fetch.calls[0]?.path).toBe("/api/v1/profiles");
  });

  it("leaves the direction out when --sort names only a field", async () => {
    const { fetch, run } = createStubCli(() => ({ items: [] }));
    await run("profile", "list", "--sort", "name");
    expect(fetch.calls[0]?.query.get("sort")).toBe("name");
  });

  it("sends one sort parameter per --sort, in the order written", async () => {
    const { fetch, run } = createStubCli(() => ({ items: [] }));
    expect(await run("task", "list", "--sort", "priority:desc", "--sort", "createdAt:desc")).toBe(
      0,
    );
    expect(fetch.calls[0]?.query.getAll("sort")).toEqual(["priority:desc", "createdAt:desc"]);
  });

  it("exits 2 naming the field when --sort repeats one, and sends nothing", async () => {
    const { fetch, io, run } = createStubCli(() => ({ items: [] }));
    expect(await run("task", "list", "--sort", "priority", "--sort", "priority:desc")).toBe(2);
    expect(io.stderr.join("\n")).toContain("--sort: priority appears more than once");
    expect(fetch.calls).toEqual([]);
  });

  it("exits 2 naming --limit when the page size is out of range, and sends nothing", async () => {
    const { fetch, io, run } = createStubCli(() => ({ items: [] }));
    expect(await run("task", "list", "--limit", "0")).toBe(2);
    expect(io.stderr.join("\n")).toContain("--limit: ");
    expect(fetch.calls).toEqual([]);
  });

  it.each([
    [
      ["--sort", "createdAt", "--sort", "createdAt:desc"],
      "--sort: createdAt appears more than once",
    ],
    [["--limit", "0"], "--limit: "],
  ])("refuses %j before looking up an id tail, so nothing is sent", async (paging, refusal) => {
    // An id tail is looked up through the API before the request is made, so
    // the paging flags are checked first. Otherwise a tail that matches no
    // runner would fail with "no runner" and exit 1, not 2.
    const { fetch, io, run } = createStubCli(() => ({ items: [] }));
    expect(await run("session", "list", "--runner", "deadbeef", ...paging)).toBe(2);
    expect(io.stderr.join("\n")).toContain(refusal);
    expect(fetch.calls).toEqual([]);
  });

  it("rejects a sort direction that is neither asc nor desc", async () => {
    const { io, run } = createStubCli();
    expect(await run("profile", "list", "--sort", "name:sideways")).toBe(2);
    expect(io.stderr.join("\n")).toContain("is not asc or desc");
  });

  it("rejects a sort field the operation does not declare", async () => {
    const { io, run } = createStubCli();
    expect(await run("profile", "list", "--sort", "createdAt")).toBe(2);
    expect(io.stderr.join("\n")).toContain("is not sortable");
  });
});

describe("id tails", () => {
  const profiles = [buildProfile("aaaaaaa1", "one"), buildProfile("bbbbbbb2", "two")];

  const withProfiles = (extra: Handler) =>
    stubFetch((request) =>
      request.path === "/api/v1/profiles" && request.method === "GET"
        ? { items: profiles }
        : extra(request),
    );

  const stubEnvIo = (fetch: ReturnType<typeof stubFetch>) =>
    stubIo({ env: { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" }, fetch });

  it("resolves a unique tail through the entity's query operation", async () => {
    const fetch = withProfiles(() => profiles[1]!);
    const stub = stubEnvIo(fetch);
    expect(await main(["--home", home, "profile", "read", "bbbbbbb2", "--json"], stub)).toBe(0);
    expect(fetch.calls[1]?.path).toBe(`/api/v1/profiles/${buildId("bbbbbbb2")}`);
  });

  it("uses a full canonical id without a lookup", async () => {
    const fetch = withProfiles(() => profiles[0]!);
    const stub = stubEnvIo(fetch);
    await main(["--home", home, "profile", "read", buildId("aaaaaaa1"), "--json"], stub);
    expect(fetch.calls.length).toBe(1);
    expect(fetch.calls[0]?.path).toBe(`/api/v1/profiles/${buildId("aaaaaaa1")}`);
  });

  it("resolves a tail through a list that is returned whole", async () => {
    // The Provider Account list is returned whole rather than as a page,
    // because there are only a few accounts.
    const account: ProviderAccount = {
      id: buildId("cccccccc"),
      providerId: "anthropic/anthropic",
      kind: "subscription-per-machine",
      label: null,
      identity: null,
      planLabel: null,
      defaultHarnessId: "claude-code/claude-code",
      expiresAt: null,
      usage: [],
      failure: null,
      snapshots: [],
      modelCount: 0,
      catalogReadAt: null,
      catalogError: null,
      readiness: [],
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
    };
    const fetch = stubFetch((request) =>
      request.path === "/api/v1/provider-accounts" && request.method === "GET"
        ? [account]
        : account,
    );
    const stub = stubEnvIo(fetch);
    expect(
      await main(["--home", home, "provider-account", "read", "cccccccc", "--json"], stub),
    ).toBe(0);
    expect(fetch.calls[1]?.path).toBe(`/api/v1/provider-accounts/${buildId("cccccccc")}`);
  });

  it("reports conflict when a tail matches more than one id", async () => {
    const fetch = stubFetch(() => ({
      items: [
        { ...buildProfile("x", "one"), id: "0192f0a1-0000-7000-8000-000011112222" },
        { ...buildProfile("x", "two"), id: "0192f0a1-0000-7000-8000-999911112222" },
      ],
    }));
    const stub = stubEnvIo(fetch);
    expect(await main(["--home", home, "profile", "read", "11112222", "--json"], stub)).toBe(1);
    const printed = JSON.parse(stub.stderr.join("\n")) as { error: { code: string } };
    expect(printed.error.code).toBe("conflict");
  });

  it("reports not_found when a tail matches nothing", async () => {
    const fetch = withProfiles(() => ({}));
    const stub = stubEnvIo(fetch);
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
      title: null,
      author: null,
      payload: {},
      raw: null,
      actor: null,
    }));
    const stub = stubEnvIo(fetch);
    expect(await main(["--home", home, "event", "read", "42", "--json"], stub)).toBe(0);
    expect(fetch.calls.length).toBe(1);
    expect(fetch.calls[0]?.path).toBe("/api/v1/events/42");
  });

  it("reads the list in an order that updates cannot change, so an updated row is still found", async () => {
    const buildTaskRow = (tail: string, at: string) => ({
      id: buildId(tail),
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
      buildTaskRow("aaaaaaa1", "2026-01-01T00:00:00.000Z"),
      buildTaskRow("bbbbbbb2", "2026-01-02T00:00:00.000Z"),
      buildTaskRow("ccccccc3", "2026-01-03T00:00:00.000Z"),
    ];
    let touched = false;

    // A stub controller that returns two rows per page, in the requested sort
    // order. Between the first and second page, it updates a row the read has
    // not reached yet. Sorted by `updatedAt`, that row would move ahead of the
    // cursor and never be read.
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
    const stub = stubEnvIo(fetch);
    expect(await main(["--home", home, "task", "read", "aaaaaaa1", "--json"], stub)).toBe(0);
    expect(fetch.calls.at(-1)?.path).toBe(`/api/v1/tasks/${buildId("aaaaaaa1")}`);
  });

  it("exits 2 on a tail when the row names no list operation, and calls nothing", async () => {
    const fetch = stubFetch(() => ({}));
    const stub = stubEnvIo(fetch);
    // A queued input's id is a Hercule id with no list operation of its own.
    expect(
      await main(["--home", home, "input", "cancel", buildId("aaaaaaa1"), "1f3a9c2e"], stub),
    ).toBe(2);
    expect(fetch.calls).toEqual([]);
    expect(stub.stderr.join("\n")).toContain("full id");
  });

  it("sends a name that only looks like a tail, when the field holds no Hercule id", async () => {
    const fetch = stubFetch(() => ({ items: [] }));
    const stub = stubEnvIo(fetch);

    expect(await main(["--home", home, "secret", "list", "--owner-id", "deadbeef"], stub)).toBe(0);

    // A secret's owner is a plugin, a runner or a connection, given by name.
    // No list covers all of them, and `deadbeef` is a valid name.
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.query.get("ownerId")).toBe("deadbeef");
  });

  it("rejects a tail shorter than eight characters before calling anything", async () => {
    const fetch = withProfiles(() => ({}));
    const stub = stubEnvIo(fetch);
    expect(await main(["--home", home, "profile", "read", "abc"], stub)).toBe(2);
    expect(fetch.calls.length).toBe(0);
    expect(stub.stderr.join("\n")).toContain("at least 8 characters");
  });
});

describe("failures", () => {
  it("exits 2 on an unknown noun and lists what is valid there", async () => {
    const { io, run } = createStubCli();
    expect(await run("nope", "read")).toBe(2);
    expect(io.stderr.join("\n")).toContain("nope");
    expect(io.stderr.join("\n")).toContain("task");
  });

  it("exits 2 on an unknown flag and points at --help", async () => {
    const { io, run } = createStubCli();
    expect(await run("profile", "create", "--nope", "x")).toBe(2);
    expect(io.stderr.join("\n")).toContain("hercule profile create --help");
  });

  it("exits 2 when a required flag is missing", async () => {
    const { io, run } = createStubCli();
    expect(await run("profile", "create")).toBe(2);
    expect(io.stderr.join("\n")).toContain("missing required --name, --grant");
  });

  it("exits 1 on an error envelope and prints the missing grant verbatim", async () => {
    const { io, run } = createStubCli(() =>
      buildErrorEnvelope("forbidden", 403, "missing grant permission.write", {
        grant: "permission.write",
      }),
    );
    expect(await run("profile", "create", "--name", "x", "--grant", "task.read")).toBe(1);
    expect(io.stderr.join("\n")).toContain("missing grant permission.write");
  });

  it("prints the error envelope verbatim under --json", async () => {
    const { io, run } = createStubCli(() =>
      buildErrorEnvelope("not_found", 404, "no such profile"),
    );
    expect(await run("profile", "delete", buildId("aaaaaaa1"), "--json")).toBe(1);
    expect(JSON.parse(io.stderr.join("\n"))).toEqual({
      error: { code: "not_found", message: "no such profile" },
    });
  });

  it("exits 2 when a flag's value does not fit its field, and sends nothing", async () => {
    const { io, fetch, run } = createStubCli();
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
    expect(io.stderr.join("\n")).toContain(
      "--provenance: A provenance entry must include at least one",
    );
    expect(io.stderr.join("\n")).toContain("run `hercule task create --help`");
  });

  it("names a field read from stdin by its name, never by a flag it does not have", async () => {
    // An empty pipe is an invalid value for the field, and there is no
    // `--text` flag to fix, so the message must point at the pipe.
    const { io, fetch, run } = createStubCli();
    expect(await run("session", "input", buildId("aaaaaaa1"))).toBe(2);
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

/**
 * Returns an Agent as the API returns it, with the given id so each tail test
 * can choose its own.
 */
const buildAgentRecord = (agentId: string, name: string) => ({
  id: agentId,
  name,
  systemPrompt: "You assess tasks.",
  providerAccountId: buildId("cccccccc"),
  harnessId: null,
  permissionProfileId: buildId("dddddddd"),
  accessMode: "full-access",
  model: null,
  disallowedTools: [] as Array<string>,
  unenforced: [] as Array<string>,
  createdAt: "2026-09-19T10:00:00.000Z",
  updatedAt: "2026-09-19T10:00:00.000Z",
});

describe("hercule session spawn --agent", () => {
  const AGENT = buildAgentRecord(buildId("aaaaaaa1"), "triager");

  const SPAWNED = {
    id: buildId("eeeeeee1"),
    kind: "agent",
    title: "Assess this task.",
    role: null,
    status: "starting",
    resumable: false,
    resumeHeld: false,
    toolCalls: 0,
    permissionProfileId: AGENT.permissionProfileId,
    agentId: AGENT.id,
    conversationId: null,
    runId: null,
    stepId: null,
    providerAccountId: AGENT.providerAccountId,
    harnessId: "claude-code/claude-code",
    runnerId: buildId("ffffffff"),
    workspaceId: null,
    projectId: null,
    requestedAccessMode: "full-access",
    accessMode: "full-access",
    nativeSessionId: null,
    modelSelection: { model: "claude-haiku-4-5", options: {} },
    parentSessionId: null,
    openRequests: [],
    openPermissionRequests: [],
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

  it("resolves an agent tail through the agent list and sends the full id", async () => {
    const { fetch, io } = stubSpawn();

    expect(
      await main(["--home", home, "session", "spawn", "--agent", "aaaaaaa1", "--json"], io),
    ).toBe(0);

    // The API never receives a tail: the list is read first, as it is for a
    // positional id.
    expect(fetch.calls[0]?.path).toBe("/api/v1/agents");
    expect(fetch.calls[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/sessions",
      body: { agentId: AGENT.id, prompt: "Assess this task." },
    });
  });

  it("resolves a profile tail on a flag through the profile list", async () => {
    const PROFILE = buildProfile("dddddddd", "worker");
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

    // A flag that holds an id accepts a tail like a positional does: the list
    // is read first, and the API receives the full id.
    expect(fetch.calls[0]?.path).toBe("/api/v1/profiles");
    expect(fetch.calls[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/sessions",
      body: { permissionProfileId: PROFILE.id },
    });
  });

  it("uses a full agent id without a lookup, and sends the schema as given", async () => {
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
    buildAgentRecord(buildId("aaaaaaa1"), "triager"),
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

  it("resolves the agent tail and filters on the full id", async () => {
    const { fetch, io } = stubAgentListing(AGENTS);

    expect(
      await main(["--home", home, "session", "list", "--agent", "aaaaaaa1", "--json"], io),
    ).toBe(0);

    expect(fetch.calls[0]?.path).toBe("/api/v1/agents");
    expect(fetch.calls[1]?.query.get("agentId")).toBe(buildId("aaaaaaa1"));
  });

  it("fails with conflict when the tail matches two agents", async () => {
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

  it("asks for several kinds of session with a repeated --kind", async () => {
    const { fetch, io } = stubAgentListing(AGENTS);

    expect(
      await main(
        ["--home", home, "session", "list", "--kind", "agent", "--kind", "run", "--json"],
        io,
      ),
    ).toBe(0);

    // No agent was given, so no agent list was read.
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.query.getAll("kind")).toEqual(["agent", "run"]);
  });
});

describe("hercule transcript read: a turn with a structured result", () => {
  const SESSION_ID = buildId("eeeeeee1");
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
    // The result is shown as a phrase on the line, not in the generic
    // `field=value` form the event's other fields use.
    expect(io.stdout.join("\n")).not.toContain("structuredResult=");
  });

  it("prints the result unchanged under --json", async () => {
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

// A positional whose field has a shorthand is decoded by the field's schema
// before the call, so the API never receives the shorthand.
describe("a positional decoded by its field's schema", () => {
  it("sends the decoded target, not the shorthand the agent typed", async () => {
    const { fetch, run } = createStubCli(() => ({ subscriptionId: buildId("aaaaaaa1") }));

    expect(await run("subscription", "create", "github:pr:o/r#87")).toBe(0);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/subscriptions",
      body: { target: { kind: "ref", ref: "github:pr:o/r#87" } },
    });
  });
});

// An agent reads one help page and then makes the call. The last line tells it
// which operation that is, its route, and the grant its profile needs for the
// call to be allowed.
describe("the last line of every command's help", () => {
  it("names the operation, its route, and the grant it needs", async () => {
    const rows = Object.entries(CLI as Record<string, { command?: string; hidden?: true }>);
    for (const [id, row] of rows) {
      if (row.hidden === true) continue;
      const printed = findLastLine(await runHelp(...row.command!.split(" ")));
      const operation = OPERATIONS[id as OperationId];
      expect(printed, row.command).toContain(`operation ${id}`);
      expect(printed, row.command).toContain(`${operation.method} ${operation.path}`);
      // A grant always contains a dot. Requirements that are not grants are
      // described in words on this line, not by their keyword.
      if (operation.requires.includes(".")) {
        expect(printed, row.command).toContain(operation.requires);
      }
    }
  });
});

/**
 * A workflow's source is a document with newlines and comments, so it is
 * passed on stdin, never in argv. `workflow create` needs a source, so it
 * always reads stdin. `workflow update` reads stdin only with
 * `--source-stdin`, so an empty pipe never erases a stored workflow.
 *
 * Input and output mirror each other:
 *
 * - Input: the source is stdin minus exactly one trailing line break, `\n` or
 *   `\r\n`. Every stdin field follows this rule.
 * - Output: `workflow read` prints the source followed by one line break, of
 *   the same kind the source uses.
 *
 * So a file that ends in a line break comes back byte for byte, and a file
 * with no trailing line break comes back with one.
 */
describe("a workflow's source in the CLI", () => {
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
  /** The source the CLI sends for that file: the file minus its trailing newline. */
  const WORKFLOW_SOURCE = WORKFLOW_FILE.slice(0, -1);
  const WORKFLOW_ID = buildId("aaaaaaa1");

  const buildWorkflowRecord = (source: string) => ({
    id: WORKFLOW_ID,
    enabled: false,
    source,
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:00:00.000Z",
  });

  /** The controller's response to a create or update: the stored record and its warnings. */
  const SAVE_ANSWER = { workflow: buildWorkflowRecord(WORKFLOW_SOURCE), warnings: [] };

  /** Returns the bytes a terminal receives: each line the CLI writes, followed by a newline. */
  const joinPrintedLines = (lines: ReadonlyArray<string>): string =>
    lines.map((line) => `${line}\n`).join("");

  it("sends stdin minus exactly one trailing newline as the source of a create, without a flag", async () => {
    // The second file ends in a blank line, so its source keeps one newline.
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

  it("sends stdin minus exactly one trailing newline as the source of an update with --source-stdin", async () => {
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

  it("does not read stdin for an update that only enables the workflow", async () => {
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

  it("rejects an inline --source flag on both commands, and sends nothing", async () => {
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

  it("prints the source and exactly one newline after it for a read, and no key-value lines", async () => {
    // The first source ends in a newline, like one saved from a file over
    // HTTP. The second is what the CLI itself sends for the same file.
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

  it("returns a file with CRLF line breaks byte for byte after a create and a read", async () => {
    const crlfFile = WORKFLOW_FILE.replaceAll("\n", "\r\n");
    // The stub controller stores the source it receives and returns it on a read.
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

/**
 * The controller returns success for `workflow validate` even when the
 * workflow has errors, because the errors are the result. Scripts validate a
 * workflow before saving it, so the CLI exits with 1 when there are errors,
 * the same code as a rejected save.
 */
describe("hercule workflow validate", () => {
  const CREDENTIAL_ENV = { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" };
  const SOURCE = "name: Check me\nsteps: []\n";
  const ERROR = { path: ["steps", "0", "action"], message: "task.creat is not an action." };
  const WARNING = { path: ["steps"], message: "A run can end only when someone cancels it." };

  it.each([
    ["an error", { errors: [ERROR], warnings: [WARNING] }, 1],
    ["only a warning", { errors: [], warnings: [WARNING] }, 0],
    ["nothing", { errors: [], warnings: [] }, 0],
  ] as const)(
    "exits with 1 on errors and 0 otherwise when it finds %s, with and without --json",
    async (_found, answer, code) => {
      for (const extra of [[], ["--json"]]) {
        const fetch = stubFetch(() => answer);
        const io = stubIo({ env: CREDENTIAL_ENV, fetch, stdin: SOURCE });

        expect(await main(["--home", home, "workflow", "validate", ...extra], io)).toBe(code);
        expect(fetch.calls[0]).toMatchObject({
          method: "POST",
          path: "/api/v1/workflows/validate",
        });
      }
    },
  );
});

/**
 * The run commands. `run start` runs a stored workflow named with
 * `--workflow`, or reads a workflow's source from stdin with
 * `--source-stdin`, like `workflow create`, and prints the same lines for
 * both, because both start a run the caller then follows with `run read`.
 * `run list` prints one row per run, and `run cancel` confirms the cancel.
 */
describe("the run commands", () => {
  const CREDENTIAL_ENV = { HERCULE_TOKEN: "t", HERCULE_API_URL: "http://controller.test" };
  const RUN_ID = buildId("bbbbbbb1");
  const WORKFLOW_ID = buildId("aaaaaaa1");
  const SESSION_ID = buildId("ccccccc1");
  const WORKFLOW_FILE = "name: File a task\nsteps:\n  - id: file_task\n";

  const buildSummary = (tail: string, fields: Record<string, unknown>) => ({
    id: buildId(tail),
    workflowId: WORKFLOW_ID,
    workflowName: "File a task",
    origin: { kind: "manual", actor: "user" },
    status: "completed",
    createdAt: "2026-09-24T10:00:00.000Z",
    startedAt: "2026-09-24T10:00:00.000Z",
    finishedAt: "2026-09-24T10:00:01.000Z",
    ...fields,
  });

  it("sends --workflow or stdin, with --inputs, to run start, and prints the same lines for both", async () => {
    const runFetch = stubFetch(() => ({ runId: RUN_ID }));
    const runIo = stubIo({ env: CREDENTIAL_ENV, fetch: runFetch });
    expect(await main(["--home", home, "run", "start", "--workflow", WORKFLOW_ID], runIo)).toBe(0);
    expect(runFetch.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/runs/start" });
    expect(runFetch.calls[0]!.body).toEqual({ workflowId: WORKFLOW_ID });

    const fetch = stubFetch(() => ({ runId: RUN_ID }));
    const io = stubIo({ env: CREDENTIAL_ENV, fetch, stdin: WORKFLOW_FILE });
    expect(
      await main(
        ["--home", home, "run", "start", "--source-stdin", "--inputs", '{"title":"Fix login"}'],
        io,
      ),
    ).toBe(0);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/runs/start" });
    expect(fetch.calls[0]!.body).toEqual({
      source: WORKFLOW_FILE.slice(0, -1),
      inputs: { title: "Fix login" },
    });
    expect(io.stdout).toEqual(runIo.stdout);
    expect(io.stdout.join("\n")).toContain(`hercule subscription create run:${RUN_ID}`);
  });

  it("prints run list as a table with the status, where a running run is, the workflow, who started it and its age", async () => {
    const fetch = stubFetch(() => ({
      items: [
        buildSummary("bbbbbbb4", {
          status: "running",
          finishedAt: undefined,
          activeStepIds: ["file_task"],
          awaitedSignalIds: [],
        }),
        buildSummary("bbbbbbb3", {
          status: "running",
          finishedAt: undefined,
          activeStepIds: [],
          awaitedSignalIds: ["approved", "merged"],
        }),
        buildSummary("bbbbbbb2", {
          origin: { kind: "api", actor: `session:${SESSION_ID}` },
          status: "failed",
          failureReason: "step-failed",
          failedStepId: "file_task",
        }),
        buildSummary("bbbbbbb1", {}),
      ],
    }));
    const io = stubIo({ env: CREDENTIAL_ENV, fetch });

    expect(await main(["--home", home, "run", "list"], io)).toBe(0);

    expect(fetch.calls[0]).toMatchObject({ method: "GET", path: "/api/v1/runs" });
    expect(io.stdout).toHaveLength(5);
    const [header, atStep, waiting, failed, completed] = io.stdout as [
      string,
      string,
      string,
      string,
      string,
    ];
    expect(header).toMatch(/status/i);
    expect(header).toMatch(/workflow/i);
    expect(header).toMatch(/started/i);
    expect(header).toMatch(/age/i);
    expect(atStep).toContain("running (at file_task)");
    expect(waiting).toContain("running (waiting for approved, merged)");
    expect(failed).toContain("failed (step-failed)");
    expect(failed).toContain("File a task");
    expect(failed).toContain(`session ${SESSION_ID.slice(-8)} through the API`);
    expect(completed).toContain("completed");
    expect(completed).toContain("File a task");
    expect(completed).toContain("you");
  });

  it("prints run read --json as the run itself, with its edge traversals, output, failed edge and skipped steps", async () => {
    const plan = {
      name: "File a batch",
      steps: [
        { id: "file", kind: "action", action: "task.create" },
        { id: "count", kind: "action", action: "task.query" },
        { id: "escalate", kind: "action", action: "task.update", condition: "inputs.urgent" },
      ],
      edges: [
        { from: "file", to: "count" },
        { from: "count", to: "file", condition: "true", maxTraversals: 1 },
        { from: "count", to: "escalate" },
      ],
    };
    const record = (stepId: string, iteration: number) => ({
      stepId,
      iteration,
      status: "completed",
      startedAt: "2026-09-24T10:00:00.000Z",
      finishedAt: "2026-09-24T10:00:00.020Z",
      output: { items: [] },
    });
    const base = {
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      plan,
      inputs: {},
      origin: { kind: "manual", actor: "user" },
      subscriptions: [],
      createdAt: "2026-09-24T10:00:00.000Z",
      startedAt: "2026-09-24T10:00:00.000Z",
      finishedAt: "2026-09-24T10:00:01.000Z",
    };
    const completed = {
      ...base,
      status: "completed",
      output: { id: "t_1", status: "in-progress" },
      steps: [
        record("file", 1),
        record("count", 1),
        record("file", 2),
        record("count", 2),
        {
          stepId: "escalate",
          iteration: 1,
          status: "skipped",
          finishedAt: "2026-09-24T10:00:00.900Z",
        },
      ],
      edgeTraversals: [2, 1, 1],
    };
    const failed = {
      ...base,
      status: "failed",
      failureReason: "iteration-limit",
      failedStepId: "count",
      failedEdge: { index: 1, message: "The edge ran out." },
      steps: [record("file", 1), record("count", 1), record("file", 2), record("count", 2)],
      edgeTraversals: [2, 1, 0],
    };

    for (const run of [completed, failed]) {
      const io = stubIo({ env: CREDENTIAL_ENV, fetch: stubFetch(() => run) });
      expect(await main(["--home", home, "run", "read", RUN_ID, "--json"], io)).toBe(0);
      expect(JSON.parse(io.stdout.join("\n"))).toEqual(run);
    }
  });

  it("sends run cancel to the run's cancel route and confirms it, without printing the whole run", async () => {
    const fetch = stubFetch(() => ({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      plan: { name: "File a task", steps: [] },
      inputs: {},
      origin: { kind: "manual", actor: "user" },
      subscriptions: [],
      status: "cancelled",
      steps: [],
      edgeTraversals: [],
      createdAt: "2026-09-24T10:00:00.000Z",
      startedAt: "2026-09-24T10:00:00.000Z",
      finishedAt: "2026-09-24T10:00:01.000Z",
    }));
    const io = stubIo({ env: CREDENTIAL_ENV, fetch });

    expect(await main(["--home", home, "run", "cancel", RUN_ID], io)).toBe(0);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/runs/${RUN_ID}/cancel`,
    });
    const printed = io.stdout.join("\n");
    expect(printed).toContain(RUN_ID.slice(-8));
    expect(printed).toMatch(/cancelled/);
    // The whole record, plan included, is what `run read` and --json are for.
    expect(printed).not.toMatch(/^plan/m);
  });
});

// The three Ignore Rule commands, from argv to the request sent and the lines printed.
describe("hercule ignore-rule", () => {
  /** Returns an Ignore Rule, as `ignore-rule create` returns it. */
  const buildIgnoreRule = (tail: string) => ({
    id: buildId(tail),
    kind: "github/review-requested",
    match: { repo: "acme/webshop", author: "dependabot[bot]" },
    text: "Review requested · Repository acme/webshop · Author dependabot[bot]",
    createdAt: "2026-10-10T09:00:00.000Z",
    actor: "user",
  });

  /** Returns an Ignore Rule with what it caught, as `ignore-rule list` returns it. */
  const buildListedIgnoreRule = (tail: string) => ({
    ...buildIgnoreRule(tail),
    caughtCount: 142,
    lastCaughtAt: "2026-10-11T09:00:00.000Z",
  });

  it("lists the rules as a table, with the kind filter in the query", async () => {
    const { io, fetch, run } = createStubCli(() => [buildListedIgnoreRule("aaaaaaa1")]);

    expect(await run("ignore-rule", "list", "--kind", "github/review-requested")).toBe(0);

    expect(fetch.calls[0]).toMatchObject({ method: "GET", path: "/api/v1/ignore-rules" });
    expect(fetch.calls[0]!.query.get("kind")).toBe("github/review-requested");
    // The rule's text names the kind and the values, so the match is not printed again.
    expect(io.stdout).toEqual([
      "id        kind                     caughtCount  lastCaughtAt              text",
      "aaaaaaa1  github/review-requested  142          2026-10-11T09:00:00.000Z  Review requested · Repository acme/webshop · Author dependabot[bot]",
    ]);
  });

  it("creates a rule from the kind and one --match per value", async () => {
    const { fetch, run } = createStubCli(() => buildIgnoreRule("aaaaaaa1"));

    expect(
      await run(
        "ignore-rule",
        "create",
        "github/review-requested",
        "--match",
        "repo=acme/webshop",
        "--match",
        "author=dependabot[bot]",
      ),
    ).toBe(0);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/ignore-rules",
      body: {
        kind: "github/review-requested",
        match: { repo: "acme/webshop", author: "dependabot[bot]" },
      },
    });
  });

  it("deletes the rule a tail names, found through the rule list", async () => {
    const rule = buildListedIgnoreRule("aaaaaaa1");
    const { fetch, run } = createStubCli((request) =>
      request.method === "GET" ? [rule, buildListedIgnoreRule("bbbbbbb2")] : {},
    );

    expect(await run("ignore-rule", "delete", "0aaaaaaa1")).toBe(0);

    expect(fetch.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/api/v1/ignore-rules" },
      { method: "DELETE", path: `/api/v1/ignore-rules/${rule.id}` },
    ]);
  });
});

describe("hercule skill import", () => {
  const HASH = "a".repeat(64);

  /** Returns a Skill record with the contract's type, with an upload source. */
  const buildSkill = (
    name: string,
    currentApprovalEffects: { allowedTools: string | null; hooks: string | null } | null = null,
  ) => ({
    name,
    source: { kind: "upload" },
    currentRevisionHash: HASH,
    currentApprovalEffects,
    currentFileCount: 1,
    currentSizeBytes: 40,
    availableRevisionHash: null,
    availableApprovalEffects: null,
    proposedCount: 0,
    lastCheckedAt: null,
    checkError: null,
    createdAt: "2026-10-18T10:00:00.000Z",
    createdBy: "user",
    updatedAt: "2026-10-18T10:00:00.000Z",
    updatedBy: "user",
  });

  /** Writes one skill folder holding a `SKILL.md` under `parent`, and returns its path. */
  const writeSkill = (parent: string, name: string): string => {
    const folder = join(parent, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
    return folder;
  };

  /**
   * Writes `<home>/skills` with four skills, and the lock file beside it
   * that gives `alpha` a GitHub source:
   *
   * - `alpha`, which the stub creates, with an `allowed-tools` effect;
   * - `beta`, which the stub answers `unchanged`;
   * - `gamma`, which the stub refuses with two content issues;
   * - `delta`, whose link points outside its folder, so it is never sent.
   */
  const writeSkillsFolder = (): string => {
    const skills = join(home, "skills");
    for (const name of ["alpha", "beta", "gamma"]) writeSkill(skills, name);
    const delta = writeSkill(skills, "delta");
    writeFileSync(join(home, "secret.txt"), "not part of any skill");
    symlinkSync(join(home, "secret.txt"), join(delta, "shared"));
    writeFileSync(
      join(home, ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          alpha: {
            source: "mattpocock/skills",
            sourceType: "github",
            skillPath: "skills/alpha/SKILL.md",
          },
          beta: { source: "beta", sourceType: "local", skillPath: "SKILL.md" },
        },
      }),
    );
    return skills;
  };

  const handleImport: Handler = (request) => {
    switch (request.query.get("name")) {
      case "alpha":
        return {
          result: "created",
          skill: buildSkill("alpha", { allowedTools: "Bash(git:*)", hooks: null }),
        };
      case "beta":
        return { result: "unchanged", skill: buildSkill("beta") };
      default:
        return buildErrorEnvelope("validation", 400, "the skill's content breaks 2 rules", {
          issues: [
            { path: [], message: "`SKILL.md` has no `description`." },
            { path: [], message: "`gamma/run` has mode 600." },
          ],
        });
    }
  };

  it("sends one request per skill, in name order, and prints one line per skill", async () => {
    const skills = writeSkillsFolder();
    const { io, fetch, run } = createStubCli(handleImport);

    expect(await run("skill", "import", skills)).toBe(1);

    // `delta` is refused before anything is sent.
    expect(fetch.calls.map((call) => call.query.get("name"))).toEqual(["alpha", "beta", "gamma"]);
    expect(io.stdout).toEqual([
      "alpha: created",
      "  `alpha` lets tools run without asking: `Bash(git:*)`",
      "beta: unchanged",
      "delta: refused: `delta/shared` points outside the skill's folder. A skill holds only its own files; copy what it needs into its folder.",
      "gamma: refused: the skill's content breaks 2 rules",
      "  `SKILL.md` has no `description`.",
      "  `gamma/run` has mode 600.",
    ]);
    expect(io.stderr).toEqual([]);
  });

  it("sends each skill's archive as the body, and its source from the lock file", async () => {
    const skills = writeSkillsFolder();
    const { fetch, run } = createStubCli(handleImport);

    await run("skill", "import", skills, "--replace", "true");

    const [alpha, beta] = fetch.calls;
    expect(alpha).toMatchObject({ method: "POST", path: "/api/v1/skills/import" });
    expect(Object.fromEntries(alpha!.query)).toEqual({
      name: "alpha",
      replace: "true",
      sourceRepo: "mattpocock/skills",
      sourcePath: "skills/alpha",
    });
    // A lock file entry that is not from GitHub gives no source fields.
    expect(Object.fromEntries(beta!.query)).toEqual({ name: "beta", replace: "true" });
    // The body is a tar archive, whose first header names the first file.
    expect(String(alpha!.body).startsWith("SKILL.md")).toBe(true);
  });

  it("imports one skill folder by itself, and exits 0 when nothing was refused", async () => {
    const folder = writeSkill(join(home, "skills"), "beta");
    const { io, fetch, run } = createStubCli(handleImport);

    expect(await run("skill", "import", folder)).toBe(0);
    expect(fetch.calls).toHaveLength(1);
    expect(io.stdout).toEqual(["beta: unchanged"]);
  });

  it("prints one JSON document with every skill's result or error under --json", async () => {
    const skills = writeSkillsFolder();
    const { io, run } = createStubCli(handleImport);

    expect(await run("skill", "import", skills, "--json")).toBe(1);
    const printed = JSON.parse(io.stdout.join("\n")) as {
      skills: ReadonlyArray<Record<string, unknown>>;
      stopped: unknown;
      lockFileProblem: string | null;
    };
    expect(printed.lockFileProblem).toBeNull();
    expect(printed.stopped).toBeNull();
    expect(printed.skills.map(({ name, result, error }) => ({ name, result, error }))).toEqual([
      { name: "alpha", result: "created", error: undefined },
      { name: "beta", result: "unchanged", error: undefined },
      {
        name: "delta",
        result: undefined,
        error: {
          message:
            "`delta/shared` points outside the skill's folder. A skill holds only its own files; copy what it needs into its folder.",
        },
      },
      {
        name: "gamma",
        result: undefined,
        error: {
          code: "validation",
          message: "the skill's content breaks 2 rules",
          details: {
            issues: [
              { path: [], message: "`SKILL.md` has no `description`." },
              { path: [], message: "`gamma/run` has mode 600." },
            ],
          },
        },
      },
    ]);
  });

  it("names a lock file it cannot read in the last line, and still imports", async () => {
    const skills = join(home, "skills");
    writeSkill(skills, "beta");
    writeFileSync(join(home, ".skill-lock.json"), "{ not json");
    const { io, run } = createStubCli(handleImport);

    expect(await run("skill", "import", skills)).toBe(0);
    expect(io.stdout.at(0)).toBe("beta: unchanged");
    expect(io.stdout.at(-1)).toContain("is not valid JSON");
  });

  it("refuses a skill over the size cap by name, without sending it", async () => {
    const skills = join(home, "skills");
    writeSkill(skills, "beta");
    const huge = writeSkill(skills, "huge");
    writeFileSync(join(huge, "data.bin"), new Uint8Array(MAX_SKILL_BYTES + 1));
    const { io, fetch, run } = createStubCli(handleImport);

    expect(await run("skill", "import", skills)).toBe(1);
    expect(fetch.calls.map((call) => call.query.get("name"))).toEqual(["beta"]);
    expect(io.stdout).toEqual([
      "beta: unchanged",
      "huge: refused: `huge` is over 10 MiB, the most a skill can hold.",
    ]);
  });

  it("stops at a controller that cannot be reached, keeps the lines so far, and exits 3", async () => {
    const skills = join(home, "skills");
    for (const name of ["beta", "gamma", "omega"]) writeSkill(skills, name);
    const { io, fetch, run } = createStubCli((request) => {
      if (request.query.get("name") === "beta") return handleImport(request);
      throw new TypeError("connect ECONNREFUSED");
    });

    expect(await run("skill", "import", skills)).toBe(3);
    // `omega` is never sent: every later skill would fail the same way.
    expect(fetch.calls.map((call) => call.query.get("name"))).toEqual(["beta", "gamma"]);
    expect(io.stdout).toHaveLength(2);
    expect(io.stdout[0]).toBe("beta: unchanged");
    expect(io.stdout[1]).toMatch(/^gamma: failed, so the import stopped: .*cannot reach/);
  });

  it("stops at the first skill the token may not import, and exits 1", async () => {
    const skills = join(home, "skills");
    for (const name of ["beta", "gamma"]) writeSkill(skills, name);
    const { io, fetch, run } = createStubCli(() =>
      buildErrorEnvelope("forbidden", 403, ONLY_THE_USER_IMPORTS_SKILLS, { grant: "skill.write" }),
    );

    expect(await run("skill", "import", skills)).toBe(1);
    expect(fetch.calls).toHaveLength(1);
    expect(io.stdout).toEqual([
      `beta: refused, so the import stopped: ${ONLY_THE_USER_IMPORTS_SKILLS}`,
    ]);
  });

  it("stops at the first skill when the token is not accepted, and exits 1", async () => {
    const skills = join(home, "skills");
    for (const name of ["beta", "gamma"]) writeSkill(skills, name);
    const { io, fetch, run } = createStubCli(() =>
      buildErrorEnvelope("unauthenticated", 401, "The token has expired."),
    );

    expect(await run("skill", "import", skills)).toBe(1);
    expect(fetch.calls).toHaveLength(1);
    expect(io.stdout).toEqual(["beta: refused, so the import stopped: The token has expired."]);
  });

  it("names the skill that stopped the import under --json", async () => {
    const skills = join(home, "skills");
    writeSkill(skills, "beta");
    const { io, run } = createStubCli(() =>
      buildErrorEnvelope("forbidden", 403, ONLY_THE_USER_IMPORTS_SKILLS, { grant: "skill.write" }),
    );

    expect(await run("skill", "import", skills, "--json")).toBe(1);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      skills: [],
      stopped: {
        name: "beta",
        error: {
          code: "forbidden",
          message: ONLY_THE_USER_IMPORTS_SKILLS,
          details: { grant: "skill.write" },
        },
      },
      lockFileProblem: null,
    });
  });

  it("exits 2 and sends nothing for a folder that holds no skill", async () => {
    mkdirSync(join(home, "empty"));
    const { io, fetch, run } = createStubCli(handleImport);

    expect(await run("skill", "import", join(home, "empty"))).toBe(2);
    expect(fetch.calls).toEqual([]);
    expect(io.stderr[0]).toContain("holds no skill");
  });

  it("exits 2 and sends nothing for a folder that does not exist", async () => {
    const { io, fetch, run } = createStubCli(handleImport);

    expect(await run("skill", "import", join(home, "missing"))).toBe(2);
    expect(fetch.calls).toEqual([]);
    expect(io.stderr[0]).toContain("does not exist");
  });
});

describe("hercule skill apply-updates", () => {
  const CURRENT = "a".repeat(64);
  const UPDATE = "b".repeat(64);

  /** Returns a GitHub-sourced Skill record, with an update waiting when `available` is set. */
  const buildSkill = (name: string, available: string | null) => ({
    name,
    source: { kind: "github", repo: "mattpocock/skills", path: `skills/${name}`, branch: null },
    currentRevisionHash: CURRENT,
    currentApprovalEffects: null,
    currentFileCount: 1,
    currentSizeBytes: 40,
    availableRevisionHash: available,
    availableApprovalEffects: null,
    proposedCount: 0,
    lastCheckedAt: "2026-10-18T10:00:00.000Z",
    checkError: null,
    createdAt: "2026-10-18T10:00:00.000Z",
    createdBy: "user",
    updatedAt: "2026-10-18T10:00:00.000Z",
    updatedBy: "user",
  });

  it("sends every waiting update with the hash it read, and prints each applied skill with its warnings", async () => {
    const applied = {
      ...buildSkill("grilling", null),
      currentRevisionHash: UPDATE,
      currentApprovalEffects: { allowedTools: null, hooks: "PreToolUse" },
    };
    const { io, fetch, run } = createStubCli((request) =>
      request.method === "GET"
        ? { items: [buildSkill("grilling", UPDATE), buildSkill("teach", null)] }
        : { items: [applied] },
    );

    expect(await run("skill", "apply-updates")).toBe(0);

    expect(fetch.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "GET", path: "/api/v1/skills", body: undefined },
      {
        method: "POST",
        path: "/api/v1/skills/apply-updates",
        body: { updates: [{ name: "grilling", revisionHash: UPDATE }] },
      },
    ]);
    expect(io.stdout).toEqual([
      `grilling: applied ${UPDATE}`,
      "  `grilling` has hooks, which run without asking",
    ]);
  });

  it("sends nothing when no update waits, and says so", async () => {
    const { io, fetch, run } = createStubCli(() => ({ items: [buildSkill("teach", null)] }));

    expect(await run("skill", "apply-updates")).toBe(0);

    expect(fetch.calls.map(({ method }) => method)).toEqual(["GET"]);
    expect(io.stdout).toEqual(["no updates to apply"]);
  });
});
