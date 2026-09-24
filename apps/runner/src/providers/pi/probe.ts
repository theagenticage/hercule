/**
 * What the runner learns about a pi installation without hosting a session on
 * it: the version the binary prints, whether Z.ai's credential is where pi
 * looks for it, and the models it would offer - plus the install that puts pi
 * on a machine.
 *
 * The version and the credential are one-shot commands; the catalog needs a pi
 * that has loaded its providers, so it is asked of a session-less child that is
 * killed as soon as it has answered.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  MAX_FACT_ITEMS,
  type ModelDescriptor,
  type ModelOption,
  type ProbeResult,
  type SnapshotAuth,
} from "@hercule/protocol";
import type { InstallOutcome } from "../index";
import { makeInstall } from "../install";
import { PROBE_DEADLINE, buildFailedProbe } from "../probe";
import type { Ran, Run } from "../process";
import { truncateFact } from "../text";
import { makeRpc, type PiSpawn } from "./rpc";

/** The upstream Hercule runs pi against; nothing else is offered or asked about. */
export const ZAI = "zai";

/** The level a session runs on when the user picked none. */
export const DEFAULT_THINKING = "low";

/** One model as pi's catalog declares it. */
interface PiModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly provider?: unknown;
  /** The levels this model takes, mapping the ones it cannot to `null`. */
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

/** What a command said, in preference to the fact that it failed. */
const readComplaint = (ran: Ran): string => {
  const said = (ran.stderr.trim() === "" ? ran.stdout : ran.stderr).trim();
  return said === "" ? `pi exited ${ran.code} without saying why` : said;
};

/**
 * pi answers `auth check` with a status object and exits 1 when no credential
 * is configured, so the exit code alone cannot tell a machine nobody has
 * entered a key on from a machine with no working pi: what it printed can.
 */
const buildAuth = (ran: Ran): SnapshotAuth => {
  let status: unknown;
  try {
    status = (JSON.parse(ran.stdout) as { readonly status?: unknown }).status;
  } catch {
    return { status: "error", message: truncateFact(readComplaint(ran)) };
  }
  if (status === "ready") return { status: "ok" };
  // The Z.ai upstream is an API key: there is no account to name, and a
  // made-up identity would be a name the user never entered.
  return status === "not_ready"
    ? { status: "unauthenticated" }
    : { status: "error", message: truncateFact(readComplaint(ran)) };
};

const formatLevelLabel = (level: string): string =>
  `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;

/**
 * The thinking option the model offers, or none: the levels it maps to
 * something. A level it maps to `null` is one the upstream refuses the turn
 * for, so offering it would be a choice that fails.
 */
const buildThinkingOption = (model: PiModel): ReadonlyArray<ModelOption> => {
  const levels = Object.entries(model.thinkingLevelMap ?? {}).flatMap(([level, mapped]) =>
    mapped === null || mapped === undefined ? [] : [level],
  );
  if (levels.length === 0) return [];
  return [
    {
      // The option id the composer labels and sends back under.
      id: "thinking",
      label: "Thinking",
      kind: "select",
      choices: levels.map((level) => ({
        value: truncateFact(level),
        label: truncateFact(formatLevelLabel(level)),
      })),
      default: levels.includes(DEFAULT_THINKING) ? DEFAULT_THINKING : levels[0]!,
    },
  ];
};

const buildCatalog = (models: ReadonlyArray<PiModel>): ReadonlyArray<ModelDescriptor> =>
  models
    .filter(
      (model) =>
        model.provider === ZAI &&
        typeof model.id === "string" &&
        model.id !== "" &&
        typeof model.name === "string" &&
        model.name !== "",
    )
    .slice(0, MAX_FACT_ITEMS)
    .map((model) => ({
      slug: truncateFact(model.id as string),
      name: truncateFact(model.name as string),
      options: buildThinkingOption(model),
    }));

/**
 * The catalog, off a pi of its own that persists nothing and reaches nowhere
 * but its own installed providers. It is killed as soon as it has answered: a
 * child left running for a Fleet page nobody is looking at any more is a
 * process with the user's key in its environment.
 */
const fetchCatalog = (
  spawn: PiSpawn,
  binary: string,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<ReadonlyArray<ModelDescriptor>, string> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        spawn(
          [
            binary,
            "--mode",
            "rpc",
            "--no-session",
            "--offline",
            "--no-context-files",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
          ],
          env,
          // A probe runs nothing and belongs to no session, so it has no
          // directory of its own to run in.
          null,
        ),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }),
    (child) => {
      const rpc = makeRpc(child, () => undefined);
      Effect.runFork(rpc.pump);
      return Effect.map(rpc.send({ type: "get_available_models" }), (answer) => {
        const models = (answer["data"] as { readonly models?: ReadonlyArray<PiModel> } | undefined)
          ?.models;
        return buildCatalog(models ?? []);
      });
    },
    (child) => Effect.sync(() => child.kill()),
  );

export const makeProbe =
  (spawn: PiSpawn, run: Run) =>
  (
    binary: string,
    env: Readonly<Record<string, string | undefined>>,
  ): Effect.Effect<ProbeResult> => {
    const gather = Effect.gen(function* () {
      const version = yield* run([binary, "--version"], env);
      if (version.code !== 0) return buildFailedProbe(null, readComplaint(version));
      const harnessVersion = truncateFact(version.stdout.trim());
      const auth = buildAuth(
        yield* run([binary, "auth", "check", "--provider", ZAI, "--json"], env),
      );
      // pi lists only the providers whose credentials it found, so a machine
      // nobody has entered a key on has no catalog to read.
      if (auth.status !== "ok") return { harnessVersion, auth, models: [] };
      return yield* Effect.match(fetchCatalog(spawn, binary, env), {
        onFailure: (message) => buildFailedProbe(harnessVersion, message),
        onSuccess: (models) => ({ harnessVersion, auth, models }),
      });
    });
    return Effect.map(
      Effect.timeoutOption(gather, PROBE_DEADLINE),
      Option.getOrElse(() =>
        buildFailedProbe(null, `pi did not answer within ${Duration.format(PROBE_DEADLINE)}`),
      ),
    );
  };

/** The vendor ships one install script and pins no release, so this is all of it. */
export const makePiInstall = (
  run: Run,
): ((env: Readonly<Record<string, string | undefined>>) => Effect.Effect<InstallOutcome>) =>
  makeInstall(run, ["bash", "-c", "curl -fsSL https://pi.dev/install.sh | sh"]);
