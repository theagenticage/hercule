/**
 * The Claude Code adapter's probe, with the vendor SDK stubbed.
 *
 * The SDK is a third-party seam, so the adapter is built over one rather than
 * reaching the vendor package directly: that is what lets this file state what
 * an authenticated machine, an unauthenticated one, one whose SDK threw and one
 * that never answered all report, without any of them being a real login.
 *
 * The fixtures are the shapes captured from the real CLI at 2.1.263 and written
 * down in the SPEC's external contracts table, not shapes invented here.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ProbeResult } from "@hydra/protocol";
import { PROBE_DEADLINE, claudeCodeAdapter, type ClaudeSeam } from "./claude-code";
import type { ProviderRunnerContext } from "./index";

/** Where this instance keeps its own config directory, and what binary it drives. */
const CONTEXT: ProviderRunnerContext = {
  home: "/var/hydra/runner/providers/0199e0e7-0000-7000-8000-00000000000a",
  binary: "/usr/local/bin/claude",
  env: { PATH: "/usr/local/bin:/usr/bin" },
};

/** What `accountInfo()` answered on a machine with a live login. */
const AUTHENTICATED = {
  email: "rogier@example.com",
  organization: "Rogier's Org",
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

/** What it answered against an empty config dir: no throw, and no identity. */
const UNAUTHENTICATED = { tokenSource: "none", apiProvider: "firstParty" };

/** Three rows of the six the CLI reported, chosen for the three option shapes. */
const MODELS = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 4.8 for up to 50% of usage limits, then Sonnet 4.6",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Everyday coding",
    supportsEffort: false,
    supportsFastMode: false,
  },
  {
    value: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description: "Fastest",
    supportsFastMode: true,
  },
];

/** What the binary printed for `--version`. */
const PRINTED = "9.9.9 (Claude Code)";

interface Call {
  readonly params: { readonly options: Record<string, unknown> };
}

/** A seam that answers with what the test says, and records how it was asked. */
const seamOver = (answers: {
  readonly accountInfo?: () => Promise<unknown>;
  readonly supportedModels?: () => Promise<ReadonlyArray<unknown>>;
}): {
  readonly seam: ClaudeSeam;
  readonly calls: Array<Call>;
  readonly closed: () => number;
} => {
  const calls: Array<Call> = [];
  let closes = 0;
  const seam: ClaudeSeam = {
    query: (params) => {
      calls.push({ params });
      return {
        accountInfo: answers.accountInfo ?? (() => Promise.resolve(AUTHENTICATED)),
        supportedModels: answers.supportedModels ?? (() => Promise.resolve(MODELS)),
        close: () => {
          closes += 1;
        },
      };
    },
    run: (command) =>
      Effect.succeed(
        command[1] === "--version"
          ? { code: 0, stdout: PRINTED, stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      ),
  };
  return { seam, calls, closed: () => closes };
};

const probeWith = (
  answers: Parameters<typeof seamOver>[0] = {},
): {
  readonly result: Promise<ProbeResult>;
  readonly calls: Array<Call>;
  readonly closed: () => number;
} => {
  const { seam, calls, closed } = seamOver(answers);
  return {
    result: Effect.runPromise(claudeCodeAdapter(seam).probe(CONTEXT, {})),
    calls,
    closed,
  };
};

/** The option a model carries under a given id, if it carries one. */
const optionOf = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

describe("what the Claude adapter reports about a machine that is logged in", () => {
  it("names the account, its plan and its backend", async () => {
    const { result } = probeWith({});

    const probed = await result;
    expect(probed.auth).toMatchObject({
      status: "ok",
      identity: "rogier@example.com",
      planLabel: "Claude Max",
      backend: "firstParty",
    });
    // The version the machine is really running, which is what the floor is
    // compared against.
    expect(probed.harnessVersion).toBe("9.9.9");
  });

  it("maps each model to its slug, its name and only the options it supports", async () => {
    const { result } = probeWith({});

    const probed = await result;
    expect(probed.models.slice(0, 3).map((model) => model.slug)).toEqual([
      "default",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(probed.models[0]).toMatchObject({ slug: "default", name: "Default (recommended)" });
    // The one row whose value is `default` is the default; nothing else is.
    expect(probed.models[0]?.isDefault).toBe(true);
    expect(probed.models[1]?.isDefault ?? false).toBe(false);

    // Effort is a select over exactly the levels the CLI listed for that model.
    expect(optionOf(probed.models, "default", "effort")).toMatchObject({
      kind: "select",
      choices: [{ value: "low" }, { value: "medium" }, { value: "high" }] as ReadonlyArray<unknown>,
      default: "medium",
    });
    expect(optionOf(probed.models, "default", "fastMode")).toMatchObject({
      kind: "boolean",
      default: false,
    });

    // A model that supports neither carries neither: the composer renders what
    // the harness will actually accept for that model and nothing more.
    expect(probed.models[1]?.options).toEqual([]);
    // And one that supports only fast mode carries only that.
    expect(probed.models[2]?.options.map((option) => option.id)).toEqual(["fastMode"]);
    // The CLI reports adaptive thinking as a fact about the model, not as a
    // choice a user makes, so it is not an option.
    expect(JSON.stringify(probed.models)).not.toContain("thinking");
  });

  it("appends the legacy models the CLI no longer lists, after the ones it does", async () => {
    const { result } = probeWith({});

    const probed = await result;
    const legacy = probed.models.filter((model) => model.isLegacy === true);
    expect(legacy.map((model) => model.slug)).toEqual(["claude-opus-4-8", "claude-fable-5"]);
    expect(legacy.map((model) => model.name)).toEqual(["Opus 4.8", "Fable 5"]);
    // Appended, never interleaved: the probed catalogue is what the harness
    // will list, and the overlay is what it has stopped listing.
    expect(probed.models.slice(0, 3).every((model) => model.isLegacy !== true)).toBe(true);
    expect(probed.models).toHaveLength(MODELS.length + legacy.length);
  });

  it("leaves a slug the CLI still lists out of the overlay, keeping the probed row", async () => {
    // The day Anthropic puts Fable 5 back in the list, the hand-authored entry
    // must not shadow or duplicate what the machine really reported.
    const { result } = probeWith({
      supportedModels: () =>
        Promise.resolve([
          ...MODELS,
          {
            value: "claude-fable-5",
            displayName: "Fable 5 (probed)",
            description: "Back on the list",
            supportsEffort: false,
            supportsFastMode: false,
          },
        ]),
    });

    const probed = await result;
    const fable = probed.models.filter((model) => model.slug === "claude-fable-5");
    expect(fable).toHaveLength(1);
    expect(fable[0]?.name).toBe("Fable 5 (probed)");
    expect(fable[0]?.isLegacy ?? false).toBe(false);
  });
});

describe("what the Claude adapter reports about a machine that is not logged in", () => {
  it("says so, and names nobody", async () => {
    const { result } = probeWith({ accountInfo: () => Promise.resolve(UNAUTHENTICATED) });

    const probed = await result;
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
    // Not an error: an empty config directory is an ordinary machine, and the
    // version and the catalogue are still facts about it.
    expect(probed.auth.message).toBeUndefined();
    expect(probed.harnessVersion).toBe("9.9.9");
  });
});

describe("what the Claude adapter reports when the probe did not finish", () => {
  it("says what the SDK threw, so the user reads why rather than a blank row", async () => {
    const { result } = probeWith({
      accountInfo: () => Promise.reject(new Error("spawn /usr/local/bin/claude ENOENT")),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("ENOENT");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.models).toEqual([]);
  });

  it("gives the SDK fifteen seconds and then says it did not answer", async () => {
    expect(Duration.toSeconds(PROBE_DEADLINE)).toBe(15);

    const { seam } = seamOver({ accountInfo: () => new Promise<never>(() => undefined) });
    const probed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(claudeCodeAdapter(seam).probe(CONTEXT, {}));
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(PROBE_DEADLINE);
          return yield* Fiber.join(running);
        }),
        TestClock.layer(),
      ),
    );

    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").not.toBe("");
  });
});

describe("how the Claude adapter asks the SDK", () => {
  it("runs a query with no prompt, no settings and no session left behind", async () => {
    const { result, calls } = probeWith({});
    await result;

    expect(calls).toHaveLength(1);
    const params = calls[0]!.params;
    // A prompt that yields makes a real API call at the same instant as the
    // init message; a probe must make none.
    expect("prompt" in params).toBe(false);
    expect(params.options).toMatchObject({
      pathToClaudeCodeExecutable: CONTEXT.binary,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    });
  });

  it("ends the query however it went, so no harness child is left running", async () => {
    const answered = probeWith({});
    await answered.result;
    expect(answered.closed()).toBe(1);

    // The case that matters most: a query nobody closed after a throw is a CLI
    // process left on the machine, one more every hour.
    const threw = probeWith({ accountInfo: () => Promise.reject(new Error("gone")) });
    await threw.result;
    expect(threw.closed()).toBe(1);
  });

  it("points the harness at the instance's own home and never at the user's", async () => {
    const { result, calls } = probeWith({});
    await result;

    const env = calls[0]!.params.options["env"] as Record<string, string>;
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(CONTEXT.home);
    // A probe that let the harness update itself would install a version
    // nobody chose in the middle of answering a question about versions.
    expect(env["DISABLE_AUTOUPDATER"]).toBe("1");
    // The one thing that must never move: with `HOME` overridden the CLI reads
    // and writes the wrong account's credential and reports it as this one's.
    expect(Object.keys(env)).not.toContain("HOME");
    expect(env["PATH"]).toBe(CONTEXT.env["PATH"]);
  });
});
