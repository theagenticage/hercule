/**
 * Tests the Antigravity adapter as the runner sees it: that its names are the
 * ones its plugin declares, that it probes and signs in through `agy`, and what
 * it does for a session it does not host. Running sessions are tested in
 * `session.test.ts`. A fake `agy` stands in for the real
 * one, which is never started.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { antigravity as antigravityPlugin } from "@hercule/plugin-antigravity";
import type { SessionSpec } from "@hercule/protocol";
import { cleanupHomes } from "../testing";
import { ANTIGRAVITY, makeAntigravityAdapter } from "./adapter";
import { BINARY, buildContext, buildFakeAgy, createSignedInHome } from "./fake-agy.testing";

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

describe("the names of the adapter", () => {
  it("are the ones the plugin declares, so the controller and the runner mean the same harness", async () => {
    const declared: Array<{
      readonly id: string;
      readonly binaryName: string;
      readonly displayName: string;
    }> = [];
    await Effect.runPromise(
      antigravityPlugin.register({
        harnesses: {
          register: (definition) =>
            Effect.sync(() => {
              declared.push(definition);
            }),
        },
      }),
    );
    const adapter = buildAdapter(createSignedInHome());

    expect(declared).toHaveLength(1);
    expect(adapter.harnessId).toBe(`${antigravityPlugin.manifest.id}/${declared[0]!.id}`);
    expect(adapter.harnessId).toBe(ANTIGRAVITY);
    expect(adapter.binaryName).toBe(declared[0]!.binaryName);
    expect(adapter.harnessName).toBe(declared[0]!.displayName);
  });
});

describe("the probe without a binary", () => {
  it("is an error on a machine with no agy, and starts nothing", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);

    const result = await Effect.runPromise(
      makeAntigravityAdapter(fake).probe(
        { ...buildContext(home), binary: undefined },
        { readUsage: false },
      ),
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

describe("the MCP Gateway", () => {
  it("is handed to agy: the adapter maps the session's MCP servers", () => {
    expect(buildAdapter(createSignedInHome()).mapsMcpServers).toBe(true);
  });
});

describe("signing in", () => {
  it("is offered for sign-in, and for no other method", () => {
    const home = createSignedInHome();
    const adapter = buildAdapter(home);

    expect(adapter.login?.(buildContext(home), BINARY, "sign-in")).toBeDefined();
    expect(adapter.login?.(buildContext(home), BINARY, "create-token")).toBeUndefined();
  });
});

describe("a text generation", () => {
  it("fails and tells the user what to do instead", async () => {
    const home = createSignedInHome();

    const failure = await Effect.runPromise(
      Effect.flip(
        buildAdapter(home).generateText(
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

describe("a session the adapter does not host", () => {
  it("lists none, refuses an input and an answer, and ignores stops, interrupts and decisions", async () => {
    const adapter = buildAdapter(createSignedInHome());

    expect(await Effect.runPromise(adapter.listSessions)).toEqual([]);
    const input = await Effect.runPromise(Effect.flip(adapter.sendInput(SESSION, { text: "Hi." })));
    expect(input._tag).toBe("SessionNotRunning");
    const answer = await Effect.runPromise(
      Effect.flip(
        adapter.respondToQuestion(SESSION, "request", { Question: "Green" }, SPEC.modelSelection),
      ),
    );
    expect(answer._tag).toBe("AnswerNotDelivered");
    await Effect.runPromise(adapter.stopSession(SESSION, "stopped"));
    await Effect.runPromise(adapter.interrupt(SESSION));
    await Effect.runPromise(adapter.respondToApprovalRequest(SESSION, "request", "allow"));
  });
});
