/**
 * Tests the facts a runner reports about its machine, and when it reports them
 * again.
 *
 * The probe is the one part of the runner that looks outside the process, so
 * the machine is passed in: `locate` stands in for the PATH, and `version` for
 * running a binary. That lets one test file cover a machine with no `gh`, a
 * machine whose `git --version` prints something unexpected, and a machine
 * with every provider installed.
 *
 * The refresh runs every hour, so it runs on a `TestClock`, like the reconnect
 * loop's tests. The tests check that a report is sent only when a value
 * differs from the one already reported, so the fleet's rows are not rewritten
 * every hour for nothing.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { arch, platform, totalmem } from "node:os";
import { IDENTITY_PORT, MAX_FACT_LENGTH, RunnerFacts } from "@hercule/protocol";
import {
  FACTS_REFRESH,
  VERSION_DEADLINE,
  probeFacts,
  refreshFacts,
  thisMachine,
  type Machine,
} from "./probe";

/** What each installed binary prints for `--version`, by binary name. */
type Printed = Record<string, string>;

/**
 * Builds a machine with exactly the binaries in `printed` on its PATH. Each
 * binary's path is built from its name, so a test only states what is
 * installed.
 */
const buildMachine = (printed: Printed): Machine => ({
  locate: (binary) => (binary in printed ? `/usr/local/bin/${binary}` : undefined),
  version: (path) => Effect.succeed(printed[path.slice("/usr/local/bin/".length)]),
});

/** Real `--version` output, captured from the pinned toolchain. */
const GIT = "git version 2.50.1";
const GH = "gh version 2.99.0 (2025-01-01)";

/** A machine with every binary installed. Tests remove binaries from it. */
const FULL: Printed = {
  git: GIT,
  gh: GH,
  docker: "Docker version 27.0.0, build abc",
  claude: "1.0.0",
  codex: "1.0.0",
  pi: "1.0.0",
};

const probePrinted = (printed: Printed, port = IDENTITY_PORT): Promise<RunnerFacts> =>
  Effect.runPromise(probeFacts(buildMachine(printed), port));

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** Lets a forked loop run without moving time. */
const settle = TestClock.adjust(Duration.zero);

describe("probeFacts", () => {
  it("reports the operating system, the architecture and the total memory", async () => {
    const facts = await probePrinted(FULL);

    expect(facts.os).toBe(platform());
    expect(facts.arch).toBe(arch());
    expect(facts.totalMemoryBytes).toBe(totalmem());
    // A plain number of bytes, because the session cap is computed from it.
    expect(Number.isInteger(facts.totalMemoryBytes)).toBe(true);
    expect(facts.totalMemoryBytes).toBeGreaterThan(0);
  });

  it("reports the identity port it was given, defaulting to 4939", async () => {
    expect(IDENTITY_PORT).toBe(4939);
    expect((await probePrinted(FULL)).identityPort).toBe(IDENTITY_PORT);
    // The listener falls back to a free port when 4939 is taken, and the facts
    // hold the port it actually bound, not the one it asked for.
    expect((await probePrinted(FULL, 51234)).identityPort).toBe(51234);
  });

  it("reports docker as present when it is on the PATH, without running it", async () => {
    expect((await probePrinted(FULL)).docker).toBe(true);

    const { docker, ...rest } = FULL;
    expect(docker).toBeDefined();
    expect((await probePrinted(rest)).docker).toBe(false);
  });
});

describe("toolchains", () => {
  it("lists git and gh with their versions and paths", async () => {
    const facts = await probePrinted(FULL);

    expect(facts.toolchains).toEqual([
      { name: "git", version: "2.50.1", path: "/usr/local/bin/git" },
      { name: "gh", version: "2.99.0", path: "/usr/local/bin/gh" },
    ]);
  });

  it("leaves out a missing binary, without failing the probe", async () => {
    const { gh, ...withoutGh } = FULL;
    expect(gh).toBeDefined();

    const facts = await probePrinted(withoutGh);
    expect(facts.toolchains.map((one) => one.name)).toEqual(["git"]);
    // The rest of the probe is unaffected: a machine without `gh` is normal,
    // not broken.
    expect(facts.os).toBe(platform());
  });

  it("reports an empty list on a machine with neither", async () => {
    const facts = await probePrinted({ docker: "Docker version 27.0.0, build abc" });
    expect(facts.toolchains).toEqual([]);
  });

  it("keeps the raw output when it holds no recognisable version", async () => {
    const facts = await probePrinted({
      ...FULL,
      git: "git: this build prints something else entirely",
    });

    expect(facts.toolchains).toEqual([
      {
        name: "git",
        version: "git: this build prints something else entirely",
        path: "/usr/local/bin/git",
      },
      { name: "gh", version: "2.99.0", path: "/usr/local/bin/gh" },
    ]);
  });

  it("leaves out a tool that printed nothing at all", async () => {
    // A wrapper script that swallows `--version`. The protocol does not allow
    // a toolchain with an empty version, so including it would make the whole
    // report fail to encode.
    const facts = await probePrinted({ ...FULL, git: "   \n" });

    expect(facts.toolchains.map((one) => one.name)).toEqual(["gh"]);
  });

  it("gives up on a binary whose --version never returns", async () => {
    // A `git` on a hung mount, or a wrapper waiting on something. Waiting for
    // ever would mean the runner could never report its facts.
    const probed = await run(
      Effect.gen(function* () {
        const running = yield* Effect.forkChild(
          probeFacts(
            {
              locate: (binary) => (binary === "git" ? "/usr/local/bin/git" : undefined),
              version: () => Effect.never,
            },
            IDENTITY_PORT,
          ),
        );
        yield* TestClock.adjust(VERSION_DEADLINE);
        return yield* Fiber.join(running);
      }),
    );

    expect(probed.toolchains).toEqual([]);
    expect(probed.os).toBe(platform());
  });

  it("gives a binary five seconds to print its version", () => {
    expect(Duration.toSeconds(VERSION_DEADLINE)).toBe(5);
  });

  it("leaves out a binary it found but could not run", async () => {
    // A `git` that exits non-zero. It is on the PATH but prints no version, so
    // there is nothing to report.
    const facts = await Effect.runPromise(
      probeFacts(
        {
          locate: (binary) => (binary === "git" ? "/usr/local/bin/git" : undefined),
          version: () => Effect.succeed(undefined),
        },
        IDENTITY_PORT,
      ),
    );

    expect(facts.toolchains).toEqual([]);
  });

  it("truncates a value that is too long to the maximum fact length", async () => {
    const deep = `/usr/local/bin/${"nested/".repeat(200)}`;
    const facts = await Effect.runPromise(
      probeFacts(
        {
          locate: (binary) => (binary === "git" ? `${deep}git` : undefined),
          version: () => Effect.succeed("x".repeat(900)),
        },
        IDENTITY_PORT,
      ),
    );

    // A value that is too long for the protocol would make the whole report
    // fail to encode, and the runner would never manage to connect.
    expect(facts.toolchains[0]?.version).toHaveLength(MAX_FACT_LENGTH);
    expect(facts.toolchains[0]?.path).toHaveLength(MAX_FACT_LENGTH);
    expect(() => Schema.encodeUnknownSync(RunnerFacts)(facts)).not.toThrow();
  });
});

describe("provider binaries", () => {
  it("lists every known provider, present or not", async () => {
    const { codex, ...withoutCodex } = FULL;
    expect(codex).toBeDefined();

    const facts = await probePrinted(withoutCodex);
    // Unlike a toolchain, a missing provider is still listed, because the fleet
    // needs to know which machines can host a provider's sessions.
    expect(facts.providers).toEqual([
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: false },
      { name: "pi", present: true, path: "/usr/local/bin/pi" },
    ]);
  });

  it("lists every provider as absent on a machine with none installed", async () => {
    const facts = await probePrinted({ git: GIT });
    expect(facts.providers).toEqual([
      { name: "claude", present: false },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ]);
  });
});

describe("thisMachine", () => {
  it("does not find a binary that is not installed, and probes the machine the test runs on", async () => {
    expect(thisMachine.locate("a-binary-no-machine-has-installed")).toBeUndefined();

    const facts = await Effect.runPromise(probeFacts(thisMachine, IDENTITY_PORT));
    expect(facts.os).toBe(platform());
    expect(facts.arch).toBe(arch());
    expect(facts.totalMemoryBytes).toBe(totalmem());
    expect(facts.providers.map((one) => one.name)).toEqual(["claude", "codex", "pi"]);
  });
});

describe("refreshFacts", () => {
  it("probes again every hour", () => {
    expect(Duration.toMillis(FACTS_REFRESH)).toBe(60 * 60 * 1000);
  });

  it("sends nothing while the facts have not changed", async () => {
    await run(
      Effect.gen(function* () {
        const reported = yield* probeFacts(buildMachine(FULL), IDENTITY_PORT);
        const sent: Array<RunnerFacts> = [];

        const loop = yield* Effect.forkChild(
          refreshFacts({
            probe: probeFacts(buildMachine(FULL), IDENTITY_PORT),
            reported,
            send: (facts) => Effect.sync(() => void sent.push(facts)),
          }),
        );

        yield* settle;
        expect(sent, "the hello already sent these facts").toEqual([]);

        // Six hours pass with no change to the machine.
        for (let hour = 0; hour < 6; hour++) yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toEqual([]);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("sends all the facts once a value differs from the last report", async () => {
    await run(
      Effect.gen(function* () {
        const reported = yield* probeFacts(buildMachine(FULL), IDENTITY_PORT);
        const sent: Array<RunnerFacts> = [];
        // The machine's current binaries. The test changes this while the loop runs.
        let installed: Printed = FULL;

        const loop = yield* Effect.forkChild(
          refreshFacts({
            probe: Effect.suspend(() => probeFacts(buildMachine(installed), IDENTITY_PORT)),
            reported,
            send: (facts) => Effect.sync(() => void sent.push(facts)),
          }),
        );

        yield* settle;
        yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toEqual([]);

        // Somebody uninstalled `gh` from the machine.
        const { gh, ...withoutGh } = FULL;
        expect(gh).toBeDefined();
        installed = withoutGh;
        yield* TestClock.adjust(FACTS_REFRESH);

        expect(sent).toHaveLength(1);
        expect(sent[0]?.toolchains.map((one) => one.name)).toEqual(["git"]);
        // A report holds all the facts, not only the ones that changed.
        expect(sent[0]?.os).toBe(platform());
        expect(sent[0]?.providers).toHaveLength(3);

        // Once the machine stops changing, nothing more is sent. So the probe is
        // compared with the last report sent, not with the hello.
        for (let hour = 0; hour < 3; hour++) yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toHaveLength(1);

        // Changing back also counts, because it differs from the last report.
        installed = FULL;
        yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.toolchains.map((one) => one.name)).toEqual(["git", "gh"]);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("stops reporting as soon as it is interrupted", async () => {
    await run(
      Effect.gen(function* () {
        const reported = yield* probeFacts(buildMachine(FULL), IDENTITY_PORT);
        const sent: Array<RunnerFacts> = [];
        let installed: Printed = FULL;

        const loop = yield* Effect.forkChild(
          refreshFacts({
            probe: Effect.suspend(() => probeFacts(buildMachine(installed), IDENTITY_PORT)),
            reported,
            send: (facts) => Effect.sync(() => void sent.push(facts)),
          }),
        );

        yield* settle;
        yield* Fiber.interrupt(loop);

        // The loop's connection is gone. Changes after that are not queued for
        // a later connection to send.
        installed = { git: GIT };
        for (let hour = 0; hour < 5; hour++) yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toEqual([]);
      }),
    );
  });
});

describe("adapters", () => {
  it("lists the providers this build has an adapter for", async () => {
    // A fact about the build, not the machine: the list is the same whether
    // the harnesses are installed or not.
    expect((await probePrinted(FULL)).adapters).toEqual(["claude-code", "codex", "pi"]);
    expect((await probePrinted({ git: GIT })).adapters).toEqual(["claude-code", "codex", "pi"]);
  });

  it("still reports every provider binary and whether it is installed", async () => {
    const { codex, ...withoutCodex } = FULL;
    expect(codex).toBeDefined();

    const facts = await probePrinted(withoutCodex);
    expect(facts.adapters).toEqual(["claude-code", "codex", "pi"]);
    // Adapters do not replace the binaries: the fleet has to show both that
    // this build can drive Codex and that the machine has no `codex` binary.
    expect(facts.providers).toEqual([
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: false },
      { name: "pi", present: true, path: "/usr/local/bin/pi" },
    ]);
  });
});
