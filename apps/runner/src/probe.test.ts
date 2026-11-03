/**
 * Tests the facts a runner reports about its machine, and when it reports them
 * again.
 *
 * The probe is the one part of the runner that looks outside the process, so
 * the machine is passed in: `locate` stands in for the PATH, and `version` for
 * running a binary. That lets one test file cover a machine with no `gh`, a
 * machine whose `git --version` prints something unexpected, and a machine
 * with every harness installed.
 *
 * The refresh runs every hour, so it runs on a `TestClock`, like the reconnect
 * loop's tests. The tests check that a report is sent only when a value
 * differs from the one already reported, so the fleet's rows are not rewritten
 * every hour for nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Cause, Duration, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { IDENTITY_PORT, MAX_FACT_LENGTH, PROBED_TOOLCHAINS, RunnerFacts } from "@hercule/protocol";
import {
  DISK_SIZE_DEADLINE,
  FACTS_REFRESH,
  VERSION_DEADLINE,
  probeFacts,
  refreshFacts,
  buildThisMachine,
  type Machine,
} from "./probe";

/** What each installed binary prints when asked for its version, by binary name. */
type Printed = Record<string, string>;

/**
 * Builds a machine with exactly the binaries in `printed` on its PATH. Each
 * binary's path is built from its name, so a test only states what is
 * installed.
 */
const buildMachine = (printed: Printed): Machine => ({
  locate: (binary) => (binary in printed ? `/usr/local/bin/${binary}` : undefined),
  version: (path) => Effect.succeed(printed[path.slice("/usr/local/bin/".length)]),
  diskTotalBytes: Effect.succeed(DISK),
});

/** The size of the stub machine's disk: 1 TiB. */
const DISK = 1024 ** 4;

/**
 * Real version output of every probed tool, with the version the probe must
 * report for it. The rows are in the order the probe reports the tools.
 */
const TOOLS = [
  { name: "git", printed: "git version 2.50.1", version: "2.50.1" },
  {
    name: "gh",
    printed: "gh version 2.103.3 (2025-10-01)\nhttps://github.com/cli/cli",
    version: "2.103.3",
  },
  { name: "node", printed: "v22.11.0", version: "22.11.0" },
  { name: "pnpm", printed: "9.12.3", version: "9.12.3" },
  { name: "bun", printed: "1.4.4", version: "1.4.4" },
  { name: "go", printed: "go version go1.25.1 darwin/arm64", version: "1.25.1" },
  { name: "rustc", printed: "rustc 1.82.0 (f6e511eec 2024-10-15)", version: "1.82.0" },
  { name: "python3", printed: "Python 3.12.4", version: "3.12.4" },
  { name: "uv", printed: "uv 0.4.18 (7b55e9790 2024-10-01)", version: "0.4.18" },
  // The comma after the version must not end up in it.
  { name: "docker", printed: "Docker version 27.3.1, build ce12230", version: "27.3.1" },
  { name: "terraform", printed: "Terraform v1.9.5\non darwin_arm64", version: "1.9.5" },
  { name: "dotnet", printed: "9.0.100", version: "9.0.100" },
] as const;

const TOOL_NAMES = TOOLS.map((tool) => tool.name);

const GIT = TOOLS[0].printed;

/** A machine with every binary installed. Tests remove binaries from it. */
const FULL: Printed = {
  ...Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.printed])),
  claude: "1.0.0",
  codex: "1.0.0",
  pi: "1.0.0",
};

/** Returns `printed` without the binary `name`. */
const without = (printed: Printed, name: string): Printed =>
  Object.fromEntries(Object.entries(printed).filter(([binary]) => binary !== name));

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

  it("reports the size of the disk", async () => {
    expect((await probePrinted(FULL)).diskTotalBytes).toBe(DISK);
  });

  it("leaves the disk size out when the disk cannot be read", async () => {
    const unreadable = await Effect.runPromise(
      probeFacts(
        {
          ...buildMachine(FULL),
          diskTotalBytes: Effect.fail(new Cause.UnknownError(new Error("statfs failed"))),
        },
        IDENTITY_PORT,
      ),
    );
    // Absent, not null or zero: the schema allows the key to be missing, and a
    // missing disk must not fail the whole probe.
    expect("diskTotalBytes" in unreadable).toBe(false);
    expect(unreadable.toolchains).toHaveLength(TOOLS.length);
    expect(Schema.is(RunnerFacts)(unreadable)).toBe(true);
  });

  it("gives up on a disk read that never completes, and leaves the size out", async () => {
    // A `statfs` on a dead mount. Waiting for ever would stop the runner from
    // connecting because of a display fact.
    const probed = await run(
      Effect.gen(function* () {
        const running = yield* Effect.forkChild(
          probeFacts({ ...buildMachine(FULL), diskTotalBytes: Effect.never }, IDENTITY_PORT),
        );
        yield* TestClock.adjust(DISK_SIZE_DEADLINE);
        return yield* Fiber.join(running);
      }),
    );

    expect("diskTotalBytes" in probed).toBe(false);
    expect(probed.toolchains).toHaveLength(TOOLS.length);
    expect(Schema.is(RunnerFacts)(probed)).toBe(true);
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

    expect((await probePrinted(without(FULL, "docker"))).docker).toBe(false);
  });

  it("reports docker as present even when its version cannot be read", async () => {
    // Placement filters on the boolean fact, so a docker that is installed but
    // prints nothing must still count as present.
    const facts = await Effect.runPromise(
      probeFacts(
        {
          ...buildMachine(FULL),
          version: (path) => Effect.succeed(path.endsWith("/docker") ? undefined : "1.0.0"),
        },
        IDENTITY_PORT,
      ),
    );

    expect(facts.docker).toBe(true);
    expect(facts.toolchains.map((one) => one.name)).not.toContain("docker");
  });
});

describe("toolchains", () => {
  it("reports every tool with its parsed version and path, in the fixed order", async () => {
    const facts = await probePrinted(FULL);

    expect(facts.toolchains).toEqual(
      TOOLS.map((tool) => ({
        name: tool.name,
        version: tool.version,
        path: `/usr/local/bin/${tool.name}`,
      })),
    );
  });

  it.each(TOOL_NAMES)(
    "leaves out %s when it is missing, without failing the probe",
    async (name) => {
      const facts = await probePrinted(without(FULL, name));

      expect(facts.toolchains.map((one) => one.name)).toEqual(
        TOOL_NAMES.filter((other) => other !== name),
      );
      // The rest of the probe is unaffected: a machine without one tool is
      // normal, not broken.
      expect(facts.os).toBe(platform());
    },
  );

  it("reports an empty list on a machine with none of the tools", async () => {
    const facts = await probePrinted({ claude: "1.0.0" });
    expect(facts.toolchains).toEqual([]);
  });

  it("names the tools it looked for, found or not", async () => {
    expect((await probePrinted(FULL)).probedToolchains).toEqual(PROBED_TOOLCHAINS);
    expect((await probePrinted({ claude: "1.0.0" })).probedToolchains).toEqual(PROBED_TOOLCHAINS);
  });

  it.each(TOOL_NAMES)("keeps the raw output of %s when it holds no version", async (name) => {
    const facts = await probePrinted({ ...FULL, [name]: `  ${name}: something else entirely\n` });

    expect(facts.toolchains.find((one) => one.name === name)?.version).toBe(
      `${name}: something else entirely`,
    );
  });

  it("keeps the raw output of a version with no patch number", async () => {
    const facts = await probePrinted({ ...FULL, go: "go version go1.25 darwin/arm64" });

    expect(facts.toolchains.find((one) => one.name === "go")?.version).toBe(
      "go version go1.25 darwin/arm64",
    );
  });

  it("keeps a prerelease and a build suffix in the version", async () => {
    const facts = await probePrinted({ ...FULL, node: "v23.0.0-rc.1+build.5, extra" });

    expect(facts.toolchains.find((one) => one.name === "node")?.version).toBe(
      "23.0.0-rc.1+build.5",
    );
  });

  it("leaves out a tool that printed nothing at all", async () => {
    // A wrapper script that swallows `--version`. The protocol does not allow
    // a toolchain with an empty version, so including it would make the whole
    // report fail to encode.
    const facts = await probePrinted({ ...FULL, git: "   \n" });

    expect(facts.toolchains.map((one) => one.name)).toEqual(TOOL_NAMES.slice(1));
  });

  it("asks go for `version` and every other tool for `--version`", async () => {
    const asked = new Map<string, ReadonlyArray<string>>();
    await Effect.runPromise(
      probeFacts(
        {
          ...buildMachine(FULL),
          version: (path, args) => {
            asked.set(path.slice("/usr/local/bin/".length), args);
            return Effect.succeed("1.0.0");
          },
        },
        IDENTITY_PORT,
      ),
    );

    expect(Object.fromEntries(asked)).toMatchObject(
      Object.fromEntries(
        TOOL_NAMES.map((name) => [name, name === "go" ? ["version"] : ["--version"]]),
      ),
    );
  });

  it("keeps the fixed order when a later tool answers first", async () => {
    // `git` answers last. Tools are probed at the same time, but the report
    // must not depend on which probe finishes first.
    const probed = await run(
      Effect.gen(function* () {
        const running = yield* Effect.forkChild(
          probeFacts(
            {
              ...buildMachine(FULL),
              version: (path) =>
                path.endsWith("/git")
                  ? Effect.delay(Effect.succeed("git version 2.50.1"), Duration.seconds(3))
                  : Effect.succeed("1.0.0"),
            },
            IDENTITY_PORT,
          ),
        );
        yield* TestClock.adjust(Duration.seconds(3));
        return yield* Fiber.join(running);
      }),
    );

    expect(probed.toolchains.map((one) => one.name)).toEqual(TOOL_NAMES);
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
              diskTotalBytes: Effect.succeed(DISK),
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
          diskTotalBytes: Effect.succeed(DISK),
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
          diskTotalBytes: Effect.succeed(DISK),
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

describe("harness binaries", () => {
  it("lists every known harness, present or not", async () => {
    const { codex, ...withoutCodex } = FULL;
    expect(codex).toBeDefined();

    const facts = await probePrinted(withoutCodex);
    // Unlike a toolchain, a missing harness is still listed, because the fleet
    // needs to know which machines can host a harness's sessions.
    expect(facts.harnesses).toEqual([
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: false },
      { name: "pi", present: true, path: "/usr/local/bin/pi" },
    ]);
  });

  it("lists every harness as absent on a machine with none installed", async () => {
    const facts = await probePrinted({ git: GIT });
    expect(facts.harnesses).toEqual([
      { name: "claude", present: false },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ]);
  });
});

describe("buildThisMachine", () => {
  it("does not find a binary that is not installed, and probes the machine the test runs on", async () => {
    const thisMachine = buildThisMachine(tmpdir());
    expect(thisMachine.locate("a-binary-no-machine-has-installed")).toBeUndefined();

    const facts = await Effect.runPromise(probeFacts(thisMachine, IDENTITY_PORT));
    expect(facts.diskTotalBytes).toBeGreaterThan(0);
    expect(facts.os).toBe(platform());
    expect(facts.arch).toBe(arch());
    expect(facts.totalMemoryBytes).toBe(totalmem());
    expect(facts.harnesses.map((one) => one.name)).toEqual(["claude", "codex", "pi"]);
  });

  describe("running a version command", () => {
    const scratch = mkdtempSync(join(tmpdir(), "probe-version-"));

    afterAll(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    /** Writes an executable shell script into the scratch directory and returns its path. */
    const writeScript = (name: string, body: string): string => {
      const path = join(scratch, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };

    it("runs it in the storage directory, with the tools' network calls switched off", async () => {
      const storage = mkdtempSync(join(scratch, "storage-"));
      const script = writeScript(
        "report",
        'echo "$PWD|$CHECKPOINT_DISABLE|$RUSTUP_AUTO_INSTALL|$COREPACK_ENABLE_NETWORK"',
      );

      const printed = await Effect.runPromise(buildThisMachine(storage).version(script, []));

      expect(printed?.trim()).toBe(`${realpathSync(storage)}|1|0|0`);
    });

    it("stops reading a tool that floods its output, and stops the tool", async () => {
      const script = writeScript("flood", "exec yes 0123456789");

      const printed = await Effect.runPromise(buildThisMachine(scratch).version(script, []));

      expect(printed).toBeDefined();
      expect(printed!.length).toBeLessThanOrEqual(4096);
      expect(printed!.length).toBeGreaterThan(0);
    });

    it("returns nothing when the tool exits with an error", async () => {
      const script = writeScript("fail", "echo 1.2.3; exit 1");

      expect(
        await Effect.runPromise(buildThisMachine(scratch).version(script, [])),
      ).toBeUndefined();
    });
  });

  it("fails the disk size read when the storage directory cannot be read", async () => {
    const machine = buildThisMachine("/no/such/directory/on/this/machine");

    expect((await Effect.runPromise(Effect.result(machine.diskTotalBytes)))._tag).toBe("Failure");
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
        installed = without(FULL, "gh");
        yield* TestClock.adjust(FACTS_REFRESH);

        expect(sent).toHaveLength(1);
        expect(sent[0]?.toolchains.map((one) => one.name)).not.toContain("gh");
        // A report holds all the facts, not only the ones that changed.
        expect(sent[0]?.os).toBe(platform());
        expect(sent[0]?.harnesses).toHaveLength(3);

        // Once the machine stops changing, nothing more is sent. So the probe is
        // compared with the last report sent, not with the hello.
        for (let hour = 0; hour < 3; hour++) yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toHaveLength(1);

        // Changing back also counts, because it differs from the last report.
        installed = FULL;
        yield* TestClock.adjust(FACTS_REFRESH);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.toolchains.map((one) => one.name)).toEqual(TOOL_NAMES);

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
  it("lists the harnesses this build has an adapter for", async () => {
    // A fact about the build, not the machine: the list is the same whether
    // the harnesses are installed or not.
    expect((await probePrinted(FULL)).adapters).toEqual([
      "claude-code/claude-code",
      "codex/codex",
      "pi/pi",
    ]);
    expect((await probePrinted({ git: GIT })).adapters).toEqual([
      "claude-code/claude-code",
      "codex/codex",
      "pi/pi",
    ]);
  });

  it("still reports every harness binary and whether it is installed", async () => {
    const { codex, ...withoutCodex } = FULL;
    expect(codex).toBeDefined();

    const facts = await probePrinted(withoutCodex);
    expect(facts.adapters).toEqual(["claude-code/claude-code", "codex/codex", "pi/pi"]);
    // Adapters do not replace the binaries: the fleet has to show both that
    // this build can drive Codex and that the machine has no `codex` binary.
    expect(facts.harnesses).toEqual([
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: false },
      { name: "pi", present: true, path: "/usr/local/bin/pi" },
    ]);
  });
});
