/**
 * What a runner says about the machine it is on.
 *
 * Part of it the operating system already knows - the platform, the
 * architecture, how much memory is fitted. The rest has to be looked for, and
 * looking is the whole reason the machine is handed in rather than reached
 * directly: a probe that calls `Bun.which` itself can only ever be tested on
 * the machine the test happens to run on.
 *
 * Nothing here reads a credential file. What a runner reports is what is on its
 * PATH and what a binary prints when asked its version, and that is all.
 */
import { arch, platform, totalmem } from "node:os";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  MAX_FACT_LENGTH,
  type ProviderBinary,
  type RunnerFacts,
  type Toolchain,
} from "@hydra/protocol";

/** The loopback port a runner serves `GET /identity` on, before it owns one. */
export const DEFAULT_IDENTITY_PORT = 4939;

/**
 * The toolchains a runner probes for. Deliberately two: anything else the
 * machine owner installs by hand and, if placement needs it, says so with a
 * label.
 */
const TOOLCHAINS = ["git", "gh"] as const;

/**
 * The provider harnesses a runner is asked about. Unlike a toolchain, an absent
 * one is still reported: what the fleet needs to know is which machines could
 * host a given provider's sessions, and that includes the ones that could not.
 */
const PROVIDER_BINARIES = ["claude", "codex", "pi"] as const;

/** Docker presence is whether the binary is there; nothing runs it. */
const DOCKER = "docker";

/** How long a binary has to say what version it is before nobody waits further. */
export const VERSION_DEADLINE: Duration.Duration = Duration.seconds(5);

/** The first thing in a version line that looks like a version. */
const SEMVER = /\d+\.\d+\.\d+\S*/;

/** How the probe reaches the machine it is on. */
export interface Machine {
  /** The absolute path of a binary on the PATH, or undefined when there is none. */
  readonly locate: (binary: string) => string | undefined;
  /** What `<binary> --version` printed, or undefined when it could not be run. */
  readonly version: (path: string) => Effect.Effect<string | undefined>;
}

/** The machine this process is on. */
export const thisMachine: Machine = {
  locate: (binary) => Bun.which(binary) ?? undefined,
  version: (path) =>
    Effect.tryPromise(async (signal) => {
      const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
      // Giving up on the answer is not giving up on the process. A binary that
      // blocks on `--version` - a wrapper waiting on a credential helper, a
      // shim on a wedged mount - would otherwise be left running, one more of
      // them every hour for the life of the runner.
      signal.addEventListener("abort", () => {
        child.kill();
      });
      const printed = await new Response(child.stdout).text();
      await child.exited;
      return child.exitCode === 0 ? printed : undefined;
    }).pipe(
      // A binary that will not start or exits with a failure has said nothing
      // about itself, and a machine missing a tool is an ordinary machine
      // rather than one the probe should fail on.
      Effect.orElseSucceed(() => undefined),
    ),
};

/**
 * Anything this machine states about itself, cut to what the protocol carries.
 * A single over-long value - a version banner, a binary under a deeply nested
 * path - would otherwise make the whole report fail to encode, which a runner
 * discovers as a connection that can never be made.
 */
const fact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/**
 * The version a binary printed. What `--version` prints is the binary's own
 * business, so anything unrecognisable is reported raw rather than dropped.
 */
const versionFrom = (printed: string): string => fact(SEMVER.exec(printed)?.[0] ?? printed.trim());

/** One toolchain, or nothing at all when the machine has none of it to report. */
const toolchainAt = (machine: Machine, name: string): Effect.Effect<Toolchain | undefined> =>
  Effect.gen(function* () {
    const path = machine.locate(name);
    if (path === undefined) return undefined;
    // The deadline is here rather than inside the machine, so that every way of
    // running a binary is bounded by it and a stub can prove that it is.
    const printed = yield* Effect.orElseSucceed(
      Effect.timeout(machine.version(path), VERSION_DEADLINE),
      () => undefined,
    );
    if (printed === undefined) return undefined;
    const version = versionFrom(printed);
    // A tool that printed nothing readable is a tool nothing can be said about,
    // and an entry with an empty version is not a fact this protocol carries.
    return version.length === 0 ? undefined : { name, version, path: fact(path) };
  });

/** Everything this machine can say about itself right now. */
export const probeFacts = (machine: Machine, identityPort: number): Effect.Effect<RunnerFacts> =>
  Effect.gen(function* () {
    const toolchains: Array<Toolchain> = [];
    for (const name of TOOLCHAINS) {
      const found = yield* toolchainAt(machine, name);
      if (found !== undefined) toolchains.push(found);
    }
    const providers: Array<ProviderBinary> = PROVIDER_BINARIES.map((name) => {
      const path = machine.locate(name);
      return path === undefined
        ? { name, present: false }
        : { name, present: true, path: fact(path) };
    });
    return {
      os: fact(platform()),
      arch: fact(arch()),
      totalMemoryBytes: totalmem(),
      docker: machine.locate(DOCKER) !== undefined,
      toolchains,
      providers,
      identityPort,
    };
  });

/** How often a connected runner looks at its machine again. */
export const FACTS_REFRESH: Duration.Duration = Duration.hours(1);

/** What the refresh needs to do its work. */
export interface FactsRefresh<E> {
  readonly probe: Effect.Effect<RunnerFacts>;
  /** What has already been reported - at the start of a connection, the hello's. */
  readonly reported: RunnerFacts;
  readonly send: (facts: RunnerFacts) => Effect.Effect<void, E>;
}

/**
 * Probes again on the interval, reporting only what differs from what the
 * controller has already been told. Facts change when somebody installs
 * something, which is rarely, so a report every hour regardless would rewrite
 * every row in the fleet hourly to say nothing new.
 *
 * The comparison is over the text the report is sent as: the probe builds its
 * answer the same way every time, so a difference in the text is a difference
 * in the machine.
 *
 * Runs until it is interrupted, which is the end of the connection it belongs
 * to. Nothing is held for a later one: a report is worth only what it says now.
 */
export const refreshFacts = <E>(refresh: FactsRefresh<E>): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    let reported = JSON.stringify(refresh.reported);
    while (true) {
      yield* Effect.sleep(FACTS_REFRESH);
      const facts = yield* refresh.probe;
      const probed = JSON.stringify(facts);
      if (probed === reported) continue;
      yield* refresh.send(facts);
      reported = probed;
    }
  });
