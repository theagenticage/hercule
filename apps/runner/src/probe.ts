/**
 * Probes the facts a runner reports about its machine: OS, memory, tools and
 * provider binaries.
 *
 * The machine is passed in as a `Machine` instead of being accessed directly.
 * A probe that called `Bun.which` itself could only be tested against the
 * machine the tests run on. Nothing here reads a credential file.
 */
import { arch, platform, totalmem } from "node:os";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  MAX_FACT_LENGTH,
  type ProviderBinary,
  type RunnerFacts,
  type Toolchain,
} from "@hercule/protocol";
import { ADAPTER_IDS } from "./providers";

/** Only these two on purpose: any other tool is installed by hand and marked with a label. */
const TOOLCHAINS = ["git", "gh"] as const;

/**
 * Unlike a missing toolchain, a missing provider binary is still reported, as
 * `present: false`. The fleet needs to know which machines can host a
 * provider's sessions and which cannot.
 */
const PROVIDER_BINARIES = ["claude", "codex", "pi"] as const;

/** Docker is reported as present or absent. The probe never runs it. */
const DOCKER = "docker";

export const VERSION_DEADLINE: Duration.Duration = Duration.seconds(5);

const SEMVER = /\d+\.\d+\.\d+\S*/;

/** How the probe looks at the machine it runs on. */
export interface Machine {
  readonly locate: (binary: string) => string | undefined;
  /** Returns what `<binary> --version` printed, or undefined when it could not be run. */
  readonly version: (path: string) => Effect.Effect<string | undefined>;
}

export const thisMachine: Machine = {
  locate: (binary) => Bun.which(binary) ?? undefined,
  version: (path) =>
    Effect.tryPromise(async (signal) => {
      const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
      // Kill the process when the caller stops waiting. Otherwise a binary that
      // hangs on `--version` would be left running, and one more would pile up
      // every hour.
      signal.addEventListener("abort", () => {
        child.kill();
      });
      const printed = await new Response(child.stdout).text();
      await child.exited;
      return child.exitCode === 0 ? printed : undefined;
    }).pipe(
      // A machine without the tool is normal, not a failed probe.
      Effect.orElseSucceed(() => undefined),
    ),
};

/**
 * Truncates a value to the protocol's maximum fact length. A single value that
 * is too long would make the whole report fail to encode, and the runner would
 * then fail to connect.
 */
const truncateFact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/**
 * Returns the semantic version in a binary's `--version` output. Each binary
 * formats that output its own way, so output with no recognisable version is
 * returned trimmed but otherwise unchanged.
 */
const parseVersion = (printed: string): string =>
  truncateFact(SEMVER.exec(printed)?.[0] ?? printed.trim());

const findToolchain = (machine: Machine, name: string): Effect.Effect<Toolchain | undefined> =>
  Effect.gen(function* () {
    const path = machine.locate(name);
    if (path === undefined) return undefined;
    // The deadline is applied here, not inside `Machine`, so it bounds every
    // `Machine` implementation and a stub can test it.
    const printed = yield* Effect.orElseSucceed(
      Effect.timeout(machine.version(path), VERSION_DEADLINE),
      () => undefined,
    );
    if (printed === undefined) return undefined;
    const version = parseVersion(printed);
    // The protocol does not allow a toolchain with an empty version.
    return version.length === 0 ? undefined : { name, version, path: truncateFact(path) };
  });

export const probeFacts = (machine: Machine, identityPort: number): Effect.Effect<RunnerFacts> =>
  Effect.gen(function* () {
    const toolchains: Array<Toolchain> = [];
    for (const name of TOOLCHAINS) {
      const found = yield* findToolchain(machine, name);
      if (found !== undefined) toolchains.push(found);
    }
    const providers: Array<ProviderBinary> = PROVIDER_BINARIES.map((name) => {
      const path = machine.locate(name);
      return path === undefined
        ? { name, present: false }
        : { name, present: true, path: truncateFact(path) };
    });
    return {
      os: truncateFact(platform()),
      arch: truncateFact(arch()),
      totalMemoryBytes: totalmem(),
      docker: machine.locate(DOCKER) !== undefined,
      toolchains,
      providers,
      // A fact about this build, not about the machine: which provider
      // binaries this runner can drive when they are installed.
      adapters: ADAPTER_IDS,
      identityPort,
    };
  });

export const FACTS_REFRESH: Duration.Duration = Duration.hours(1);

export interface FactsRefresh<E> {
  readonly probe: Effect.Effect<RunnerFacts>;
  /** The facts already reported. At the start of a connection, these are the facts sent in the hello. */
  readonly reported: RunnerFacts;
  readonly send: (facts: RunnerFacts) => Effect.Effect<void, E>;
}

/**
 * Probes the facts every hour and sends them only when they differ from the
 * facts already reported. Facts change rarely, and sending them every hour
 * anyway would rewrite every runner row in the fleet with nothing new.
 *
 * The comparison uses the JSON text of the facts. That works because the probe
 * builds its result in the same order every time.
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
