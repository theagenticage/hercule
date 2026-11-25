/**
 * Tests the Antigravity adapter as the runner sees it: the names it registers
 * under, what it offers (sign-in, install, probe, deleting a conversation's
 * files) and what it refuses while it runs no sessions. A fake `agy` stands in
 * for the real one, which is never started.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { SessionSpec } from "@hercule/protocol";
import { cleanupHomes } from "../testing";
import { ANTIGRAVITY, makeAntigravityAdapter } from "./adapter";
import {
  AGY_VERSION,
  BINARY,
  CONVERSATION,
  SIGNED_IN_EMAIL,
  buildContext,
  buildFakeAgy,
  createConversationFiles,
  createSignedInHome,
  listHomeFiles,
} from "./fake-agy.testing";

afterEach(() => {
  cleanupHomes();
});

const buildAdapter = (home: string) => makeAntigravityAdapter(buildFakeAgy(home));

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";

const SPEC: SessionSpec = {
  providerAccountId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  modelSelection: { model: "gemini-4-hydrogen", options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

describe("what the adapter is registered as", () => {
  it("uses the harness id and binary name its plugin declares", () => {
    const adapter = buildAdapter(createSignedInHome());

    expect(ANTIGRAVITY).toBe("antigravity/antigravity");
    expect(adapter.harnessId).toBe("antigravity/antigravity");
    expect(adapter.binaryName).toBe("agy");
    expect(adapter.harnessName).toBe("Antigravity");
  });

  it("does not hand the MCP Gateway to the harness", () => {
    expect(buildAdapter(createSignedInHome()).mapsMcpServers).toBeUndefined();
  });
});

describe("the probe", () => {
  it("reports the account through the fake agy", async () => {
    const home = createSignedInHome();

    const result = await Effect.runPromise(
      buildAdapter(home).probe({ ...buildContext(home) }, { readUsage: true }),
    );

    expect(result.harnessVersion).toBe(AGY_VERSION);
    expect(result.auth).toMatchObject({ status: "ok", identity: SIGNED_IN_EMAIL });
    expect(result.usage).toBeNull();
  });

  it("is an error on a machine with no agy, and starts nothing", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);
    const ctx = { ...buildContext(home), binary: undefined };

    const result = await Effect.runPromise(
      makeAntigravityAdapter(fake).probe(ctx, { readUsage: false }),
    );

    expect(result).toEqual({
      harnessVersion: null,
      auth: { status: "error", message: "no agy on this machine" },
      models: [],
      usage: null,
    });
    expect(fake.spawns).toHaveLength(0);
    expect(fake.ran).toHaveLength(0);
  });
});

describe("signing in", () => {
  it("is offered for sign-in, in the account's own Harness Home, and for no other method", () => {
    const home = createSignedInHome();
    const adapter = buildAdapter(home);

    const signIn = adapter.login?.(buildContext(home), BINARY, "sign-in");

    expect(signIn?.command).toEqual([
      BINARY,
      "acp",
      "--login",
      "--gemini-dir",
      home,
      "--app-data-dir",
      "antigravity-acp",
    ]);
    expect(adapter.login?.(buildContext(home), BINARY, "create-token")).toBeUndefined();
  });
});

describe("installing", () => {
  it("is offered", () => {
    expect(buildAdapter(createSignedInHome()).install).toBeDefined();
  });
});

describe("a text generation", () => {
  it("fails and tells the user what to do instead", async () => {
    const home = createSignedInHome();
    const adapter = buildAdapter(home);

    const failure = await Effect.runPromise(
      Effect.flip(
        adapter.generateText(
          { ...buildContext(home), binary: BINARY, cwd: home },
          {
            model: "gemini-4-hydrogen",
            instructions: "Answer.",
            input: "Hello",
            outputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ),
      ),
    );

    expect(failure).toBe(
      "Antigravity runs no text generations. Pick another model for it in Settings.",
    );
  });
});

describe("a session", () => {
  it("cannot start yet, and says so", async () => {
    const home = createSignedInHome();
    const adapter = buildAdapter(home);

    const failure = await Effect.runPromise(
      Effect.flip(adapter.startSession(SESSION, SPEC, { ...buildContext(home), mcpServers: [] })),
    );

    expect(failure._tag).toBe("AdapterFailed");
    expect(failure.message).toBe("This version of Hercule cannot run Antigravity sessions yet.");
  });

  it("is not found by anything that asks about a running one", async () => {
    const adapter = buildAdapter(createSignedInHome());

    const sent = await Effect.runPromise(
      Effect.flip(adapter.sendInput(SESSION, { text: "hello" })),
    );
    const answered = await Effect.runPromise(
      Effect.flip(adapter.respondToQuestion(SESSION, "request-1", {}, { model: "x", options: {} })),
    );

    expect(sent._tag).toBe("SessionNotRunning");
    expect(answered._tag).toBe("AnswerNotDelivered");
    expect(await Effect.runPromise(adapter.listSessions)).toEqual([]);
  });
});

describe("deleting the files of a session", () => {
  it("removes the conversation's files and nothing else", async () => {
    const home = createSignedInHome();
    createConversationFiles(home, CONVERSATION);
    const other = "11111111-2222-4333-8444-555555555555";
    createConversationFiles(home, other);

    await Effect.runPromise(buildAdapter(home).deleteSessionFiles(home, CONVERSATION));

    const left = listHomeFiles(home);
    expect(left).not.toContain(join("antigravity-acp", "conversations", `${CONVERSATION}.db`));
    expect(left).toContain(join("antigravity-acp", "conversations", `${other}.db`));
  });
});
