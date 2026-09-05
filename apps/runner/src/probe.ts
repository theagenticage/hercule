/**
 * What a runner says about the machine it is on.
 *
 * The machine is handed in rather than reached directly because a probe that
 * calls `Bun.which` itself can only be tested on whatever machine the test runs
 * on. Nothing here reads a credential file.
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

/** Deliberately two: anything else is installed by hand and named with a label. */
const TOOLCHAINS = ["git", "gh"] as const;

/**
 * Unlike a toolchain, an absent one is still reported: the fleet needs to know
 * which machines could host a provider's sessions, including those that could not.
 */
const PROVIDER_BINARIES = ["claude", "codex", "pi"] as const;

/** Presence is whether the binary is there; nothing runs it. */
const DOCKER = "docker";

export const VERSION_DEADLINE: Duration.Duration = Duration.seconds(5);

const SEMVER = /\d+\.\d+\.\d+\S*/;

/** How the probe reaches the machine it is on. */
export interface Machine {
  readonly locate: (binary: string) => string | undefined;
  /** What `<binary> --version` printed, or undefined when it could not be run. */
  readonly version: (path: string) => Effect.Effect<string | undefined>;
}

export const thisMachine: Machine = {
  locate: (binary) => Bun.which(binary) ?? undefined,
  version: (path) =>
    Effect.tryPromise(async (signal) => {
      const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
      // Giving up on the answer is not giving up on the process: a binary that
      // blocks on `--version` would be left running, one more every hour.
      signal.addEventListener("abort", () => {
        child.kill();
      });
      const printed = await new Response(child.stdout).text();
      await child.exited;
      return child.exitCode === 0 ? printed : undefined;
    }).pipe(
      // A machine missing a tool is an ordinary machine, not a failed probe.
      Effect.orElseSucceed(() => undefined),
    ),
};

/**
 * Cut to what the protocol carries. One over-long value would otherwise make the
 * whole report fail to encode, which a runner meets as a connection it cannot make.
 */
const fact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/** What `--version` prints is the binary's business, so the unrecognisable goes raw. */
const versionFrom = (printed: string): string => fact(SEMVER.exec(printed)?.[0] ?? printed.trim());

const toolchainAt = (machine: Machine, name: string): Effect.Effect<Toolchain | undefined> =>
  Effect.gen(function* () {
    const path = machine.locate(name);
    if (path === undefined) return undefined;
    // Here rather than inside the machine, so every way of running a binary is
    // bounded by it and a stub can prove so.
    const printed = yield* Effect.orElseSucceed(
      Effect.timeout(machine.version(path), VERSION_DEADLINE),
      () => undefined,
    );
    if (printed === undefined) return undefined;
    const version = versionFrom(printed);
    // An entry with an empty version is not a fact this protocol carries.
    return version.length === 0 ? undefined : { name, version, path: fact(path) };
  });

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

export const FACTS_REFRESH: Duration.Duration = Duration.hours(1);

export interface FactsRefresh<E> {
  readonly probe: Effect.Effect<RunnerFacts>;
  /** What has already been reported - at the start of a connection, the hello's. */
  readonly reported: RunnerFacts;
  readonly send: (facts: RunnerFacts) => Effect.Effect<void, E>;
}

/**
 * Reports only what differs from what the controller was already told: facts
 * change rarely, and an hourly report regardless would rewrite every row in the
 * fleet to say nothing new. The comparison is over the text the report is sent
 * as, because the probe builds its answer the same way every time.
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
