/**
 * What a runner says about the machine it is on, and when it says it again.
 *
 * The probe is the one piece of the runner that has to look outside the
 * process, so the machine is handed to it: `locate` stands in for the PATH and
 * `version` for running a binary. That is what lets a machine with no `gh`, a
 * machine with a `git` whose `--version` prints something nobody expected, and
 * a machine with every provider installed all exist in the same test file.
 *
 * The refresh is on an hour's interval, so it runs on a `TestClock` exactly as
 * the reconnect loop's schedule does. What is asserted about it is the rule
 * that keeps a fleet's rows from being rewritten hourly for nothing: a report
 * goes out only when a value differs from the one already reported.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { arch, platform, totalmem } from "node:os";
import { MAX_FACT_LENGTH, RunnerFacts } from "@hydra/protocol";
import {
  DEFAULT_IDENTITY_PORT,
  FACTS_REFRESH,
  VERSION_DEADLINE,
  probeFacts,
  refreshFacts,
  thisMachine,
  type Machine,
} from "./probe";

/** What each binary this test installs prints for `--version`. */
type Printed = Record<string, string>;

/**
 * A machine with exactly the binaries named on its PATH. The path of one is
 * derived from its name, so a test states what is installed and nothing else.
 */
const machineWith = (printed: Printed): Machine => ({
  locate: (binary) => (binary in printed ? `/usr/local/bin/${binary}` : undefined),
  version: (path) => Effect.succeed(printed[path.slice("/usr/local/bin/".length)]),
});

/** Real `--version` output, captured from the pinned toolchain. */
const GIT = "git version 2.50.1";
const GH = "gh version 2.99.0 (2025-01-01)";

/** Everything a machine could have, so a test can take things away from it. */
const FULL: Printed = {
  git: GIT,
  gh: GH,
  docker: "Docker version 27.0.0, build abc",
  claude: "1.0.0",
  codex: "1.0.0",
  pi: "1.0.0",
};

const probe = (printed: Printed, port = DEFAULT_IDENTITY_PORT): Promise<RunnerFacts> =>
  Effect.runPromise(probeFacts(machineWith(printed), port));

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

/** Lets a forked loop run without moving time. */
const settle = TestClock.adjust(Duration.zero);

describe("probing the machine", () => {
  it("reports the operating system, the architecture and the memory fitted", async () => {
    const facts = await probe(FULL);

    expect(facts.os).toBe(platform());
    expect(facts.arch).toBe(arch());
    expect(facts.totalMemoryBytes).toBe(totalmem());
    // Bytes, never a unit: the session-cap rule is arithmetic on this number.
    expect(Number.isInteger(facts.totalMemoryBytes)).toBe(true);
    expect(facts.totalMemoryBytes).toBeGreaterThan(0);
  });

  it("reports the identity port it was given, defaulting to 4939", async () => {
    expect(DEFAULT_IDENTITY_PORT).toBe(4939);
    expect((await probe(FULL)).identityPort).toBe(DEFAULT_IDENTITY_PORT);
    // The listener falls back to a free port when 4939 is taken, and the facts
    // say where it really ended up rather than where it meant to be.
    expect((await probe(FULL, 51234)).identityPort).toBe(51234);
  });

  it("reads docker presence off the PATH and nothing else", async () => {
    expect((await probe(FULL)).docker).toBe(true);

    const { docker, ...rest } = FULL;
    expect(docker).toBeDefined();
    expect((await probe(rest)).docker).toBe(false);
  });
});

describe("the toolchains a runner reports", () => {
  it("lists git and gh with the version each printed and where it found it", async () => {
    const facts = await probe(FULL);

    expect(facts.toolchains).toEqual([
      { name: "git", version: "2.50.1", path: "/usr/local/bin/git" },
      { name: "gh", version: "2.99.0", path: "/usr/local/bin/gh" },
    ]);
  });

  it("leaves out a binary that is not there, without failing the probe", async () => {
    const { gh, ...withoutGh } = FULL;
    expect(gh).toBeDefined();

    const facts = await probe(withoutGh);
    expect(facts.toolchains.map((one) => one.name)).toEqual(["git"]);
    // The rest of the probe is unaffected: a machine with no `gh` is an
    // ordinary machine, not a broken one.
    expect(facts.os).toBe(platform());
  });

  it("reports nothing at all on a machine with neither", async () => {
    const facts = await probe({ docker: "Docker version 27.0.0, build abc" });
    expect(facts.toolchains).toEqual([]);
  });

  it("keeps what a binary printed when it is not a version it can read", async () => {
    const facts = await probe({
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
    // A wrapper script that swallows `--version`. There is no fact to state
    // about it, and an entry with an empty version is not one this protocol
    // carries: the whole report would fail to encode over one such machine.
    const facts = await probe({ ...FULL, git: "   \n" });

    expect(facts.toolchains.map((one) => one.name)).toEqual(["gh"]);
  });

  it("gives up on a binary that will not say what version it is", async () => {
    // A `git` on a wedged mount, or a wrapper waiting on something. Waiting for
    // it for ever would leave the runner unable to say anything about itself.
    const probed = await run(
      Effect.gen(function* () {
        const running = yield* Effect.forkChild(
          probeFacts(
            {
              locate: (binary) => (binary === "git" ? "/usr/local/bin/git" : undefined),
              version: () => Effect.never,
            },
            DEFAULT_IDENTITY_PORT,
          ),
        );
        yield* TestClock.adjust(VERSION_DEADLINE);
        return yield* Fiber.join(running);
      }),
    );

    expect(probed.toolchains).toEqual([]);
    expect(probed.os).toBe(platform());
  });

  it("gives a binary five seconds to answer", () => {
    expect(Duration.toSeconds(VERSION_DEADLINE)).toBe(5);
  });

  it("leaves out a binary it found but could not run", async () => {
    // A `git` on a wedged mount, or one that exits non-zero. It is on the PATH
    // and it still says nothing about itself, so there is no fact to report.
    const facts = await Effect.runPromise(
      probeFacts(
        {
          locate: (binary) => (binary === "git" ? "/usr/local/bin/git" : undefined),
          version: () => Effect.succeed(undefined),
        },
        DEFAULT_IDENTITY_PORT,
      ),
    );

    expect(facts.toolchains).toEqual([]);
  });

  it("cuts anything far too long to be a fact down to what a fact may hold", async () => {
    const deep = `/usr/local/bin/${"nested/".repeat(200)}`;
    const facts = await Effect.runPromise(
      probeFacts(
        {
          locate: (binary) => (binary === "git" ? `${deep}git` : undefined),
          version: () => Effect.succeed("x".repeat(900)),
        },
        DEFAULT_IDENTITY_PORT,
      ),
    );

    // A value the protocol will not carry makes the whole report unsendable,
    // which a runner only discovers as a connection it can never make.
    expect(facts.toolchains[0]?.version).toHaveLength(MAX_FACT_LENGTH);
    expect(facts.toolchains[0]?.path).toHaveLength(MAX_FACT_LENGTH);
    expect(() => Schema.encodeUnknownSync(RunnerFacts)(facts)).not.toThrow();
  });
});

describe("the provider binaries a runner reports", () => {
  it("names every provider it knows of, present or not", async () => {
    const { codex, ...withoutCodex } = FULL;
    expect(codex).toBeDefined();

    const facts = await probe(withoutCodex);
    // Unlike a toolchain, an absent provider is still listed: what a fleet
    // needs to know is which machines could host a provider's sessions.
    expect(facts.providers).toEqual([
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: false },
      { name: "pi", present: true, path: "/usr/local/bin/pi" },
    ]);
  });

  it("lists them all as absent on a machine with none installed", async () => {
    const facts = await probe({ git: GIT });
    expect(facts.providers).toEqual([
      { name: "claude", present: false },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ]);
  });
});

describe("the real machine", () => {
  it("locates nothing that is not there and probes the machine this test runs on", async () => {
    expect(thisMachine.locate("a-binary-no-machine-has-installed")).toBeUndefined();

    const facts = await Effect.runPromise(probeFacts(thisMachine, DEFAULT_IDENTITY_PORT));
    expect(facts.os).toBe(platform());
    expect(facts.arch).toBe(arch());
    expect(facts.totalMemoryBytes).toBe(totalmem());
    expect(facts.providers.map((one) => one.name)).toEqual(["claude", "codex", "pi"]);
  });
});

describe("the hourly refresh", () => {
  it("probes again every hour", () => {
    expect(Duration.toMillis(FACTS_REFRESH)).toBe(60 * 60 * 1000);
  });

  it("says nothing while nothing about the machine has changed", async () => {
    await run(
      Effect.gen(function* () {
        const reported = yield* probeFacts(machineWith(FULL), DEFAULT_IDENTITY_PORT);
        const sent: Array<RunnerFacts> = [];

        const loop = yield* Effect.forkChild(
          refreshFacts({
            probe: probeFacts(machineWith(FULL), DEFAULT_IDENTITY_PORT),
            reported,
            send: (facts) => Effect.sync(() => void sent.push(facts)),
          }),
        );

        yield* settle;
        expect(sent, "the hello already carried these").toEqual([]);

        // Six hours of a machine nobody touched.
        for (let hour = 0; hour < 6; hour++) yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toEqual([]);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("reports the whole facts once a value differs from what was reported", async () => {
    await run(
      Effect.gen(function* () {
        const reported = yield* probeFacts(machineWith(FULL), DEFAULT_IDENTITY_PORT);
        const sent: Array<RunnerFacts> = [];
        // What the machine looks like now, which the test changes underneath it.
        let installed: Printed = FULL;

        const loop = yield* Effect.forkChild(
          refreshFacts({
            probe: Effect.suspend(() => probeFacts(machineWith(installed), DEFAULT_IDENTITY_PORT)),
            reported,
            send: (facts) => Effect.sync(() => void sent.push(facts)),
          }),
        );

        yield* settle;
        yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toEqual([]);

        // Somebody installed `gh` on the machine an hour ago.
        const { gh, ...withoutGh } = FULL;
        expect(gh).toBeDefined();
        installed = withoutGh;
        yield* TestClock.adjust(FACTS_REFRESH);

        expect(sent).toHaveLength(1);
        expect(sent[0]?.toolchains.map((one) => one.name)).toEqual(["git"]);
        // A report is the whole of the facts, not the part that moved.
        expect(sent[0]?.os).toBe(platform());
        expect(sent[0]?.providers).toHaveLength(3);

        // And the machine standing still again says nothing further, so what a
        // report is compared against is the last one sent, not the hello.
        for (let hour = 0; hour < 3; hour++) yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toHaveLength(1);

        // A change back is a change: it differs from what was last reported.
        installed = FULL;
        yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.toolchains.map((one) => one.name)).toEqual(["git", "gh"]);

        yield* Fiber.interrupt(loop);
      }),
    );
  });

  it("stops reporting the moment it is interrupted", async () => {
    await run(
      Effect.gen(function* () {
        const reported = yield* probeFacts(machineWith(FULL), DEFAULT_IDENTITY_PORT);
        const sent: Array<RunnerFacts> = [];
        let installed: Printed = FULL;

        const loop = yield* Effect.forkChild(
          refreshFacts({
            probe: Effect.suspend(() => probeFacts(machineWith(installed), DEFAULT_IDENTITY_PORT)),
            reported,
            send: (facts) => Effect.sync(() => void sent.push(facts)),
          }),
        );

        yield* settle;
        yield* Fiber.interrupt(loop);

        // The connection this loop belonged to is gone, and what the machine
        // does afterwards is nobody's report to make: nothing is held for a
        // later socket to deliver.
        installed = { git: GIT };
        for (let hour = 0; hour < 5; hour++) yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toEqual([]);
      }),
    );
  });
});
