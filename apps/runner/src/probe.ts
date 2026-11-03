/**
 * Probes the facts a runner reports about its machine: OS, memory, tools and
 * harness binaries.
 *
 * The machine is passed in as a `Machine` instead of being accessed directly.
 * A probe that called `Bun.which` itself could only be tested against the
 * machine the tests run on. Nothing here reads a credential file.
 */
import { arch, platform, totalmem } from "node:os";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  PROBED_TOOLCHAINS,
  type HarnessBinary,
  type RunnerFacts,
  type Toolchain,
} from "@hercule/protocol";
import { readDiskSpace } from "./disk";
import { ADAPTER_IDS } from "./harnesses";
import { truncateFact } from "./harnesses/text";

/**
 * The arguments that make a tool print its version. Every tool takes
 * `--version` except `go`, which has a `version` subcommand instead.
 */
const VERSION_ARGUMENTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  go: ["version"],
};

const DEFAULT_VERSION_ARGUMENTS: ReadonlyArray<string> = ["--version"];

/**
 * How many tools are probed at once. Each probe can wait out its whole
 * deadline, so probing one at a time could hold the hello back by a minute.
 */
const PROBE_CONCURRENCY = 4;

/**
 * Unlike a missing toolchain, a missing harness binary is still reported, as
 * `present: false`. The fleet needs to know which machines can host a
 * harness's sessions and which cannot.
 */
const HARNESS_BINARIES = ["claude", "codex", "pi"] as const;

/**
 * The `docker` fact says whether the binary is on the PATH, found with
 * `locate` alone. It does not depend on `docker --version` working, because
 * placement filters on the fact. Docker is also one of the probed toolchains,
 * for its version.
 */
const DOCKER = "docker";

export const VERSION_DEADLINE: Duration.Duration = Duration.seconds(5);

/**
 * The longest the probe waits for the disk size. The probe must finish before
 * the runner connects, and the size is only a display fact, so a `statfs` on a
 * dead mount must not hold the connection back.
 */
export const DISK_SIZE_DEADLINE: Duration.Duration = Duration.seconds(5);

/**
 * A semantic version: the three numbers, an optional `-prerelease` and an
 * optional `+build`. It stops at punctuation, so `27.3.1, build ce12230` gives
 * `27.3.1`.
 */
const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;

/** How the probe looks at the machine it runs on. */
export interface Machine {
  readonly locate: (binary: string) => string | undefined;
  /**
   * Returns what the binary at `path` printed when run with `args`, or
   * undefined when it could not be run or exited with an error.
   */
  readonly version: (
    path: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string | undefined>;
  /** Returns the size of the disk that holds the runner's storage directory. Fails when it cannot be read. */
  readonly diskTotalBytes: Effect.Effect<number, Cause.UnknownError>;
}

/**
 * Returns the machine this process runs on. `storageDir` is the runner's
 * storage directory: the disk size is the size of the file system that holds
 * it, the same file system the metrics read the free space from.
 */
export const buildThisMachine = (storageDir: string): Machine => ({
  locate: (binary) => Bun.which(binary) ?? undefined,
  version: (path, args) =>
    Effect.tryPromise(async (signal) => {
      const child = Bun.spawn([path, ...args], { stdout: "pipe", stderr: "ignore" });
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
  diskTotalBytes: Effect.map(readDiskSpace(storageDir), (disk) => disk.totalBytes),
});

/**
 * Returns the semantic version in the text a binary printed for its version.
 * Each binary formats that text its own way, so output with no recognisable
 * version (such as `go1.25` with no patch number) is returned trimmed but
 * otherwise unchanged.
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
      Effect.timeout(
        machine.version(path, VERSION_ARGUMENTS[name] ?? DEFAULT_VERSION_ARGUMENTS),
        VERSION_DEADLINE,
      ),
      () => undefined,
    );
    if (printed === undefined) return undefined;
    const version = parseVersion(printed);
    // The protocol does not allow a toolchain with an empty version.
    return version.length === 0 ? undefined : { name, version, path: truncateFact(path) };
  });

/**
 * Returns the disk size, or `undefined` when it cannot be read within
 * `DISK_SIZE_DEADLINE`. A failed or late read is logged as a warning and the
 * size is left out of the facts: the facts hold much the fleet needs besides
 * it, so it must not fail the probe. The deadline stops the wait only; it does
 * not cancel a `statfs` that is already running in the kernel.
 */
const readDiskTotalBytes = (machine: Machine): Effect.Effect<number | undefined> =>
  Effect.map(
    Effect.option(
      Effect.tapCause(Effect.timeout(machine.diskTotalBytes, DISK_SIZE_DEADLINE), (cause) =>
        Effect.logWarning(
          "The runner could not read the size of its disk, so it left the disk size out of its facts",
          cause,
        ),
      ),
    ),
    Option.getOrUndefined,
  );

export const probeFacts = (machine: Machine, identityPort: number): Effect.Effect<RunnerFacts> =>
  Effect.gen(function* () {
    // `forEach` returns its results in the order of the list, whichever probe
    // finishes first.
    const found = yield* Effect.forEach(PROBED_TOOLCHAINS, (name) => findToolchain(machine, name), {
      concurrency: PROBE_CONCURRENCY,
    });
    const toolchains = found.filter((toolchain) => toolchain !== undefined);
    const harnesses: Array<HarnessBinary> = HARNESS_BINARIES.map((name) => {
      const path = machine.locate(name);
      return path === undefined
        ? { name, present: false }
        : { name, present: true, path: truncateFact(path) };
    });
    const diskTotalBytes = yield* readDiskTotalBytes(machine);
    return {
      os: truncateFact(platform()),
      arch: truncateFact(arch()),
      totalMemoryBytes: totalmem(),
      // Left out, not null, when unreadable: the schema allows the key to be absent.
      ...(diskTotalBytes === undefined ? {} : { diskTotalBytes }),
      docker: machine.locate(DOCKER) !== undefined,
      toolchains,
      harnesses,
      // A fact about this build, not about the machine: which harnesses
      // this runner can drive when their binaries are installed.
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
 * builds its result in the same order every time, including the optional
 * `diskTotalBytes`, which sits at a fixed place or is absent.
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
