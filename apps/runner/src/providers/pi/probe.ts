/**
 * Probes a pi installation without starting a session: the version the binary
 * prints, whether pi finds a Z.ai key, and the models pi offers. Also builds
 * the install command that puts pi on a machine.
 *
 * The version and the key check are one-shot commands. The model catalog needs
 * a pi that has loaded its providers, so it is read from a child process with
 * no session, which is killed as soon as it has responded.
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

/** The only pi provider Hercule uses; no other provider is offered or checked. */
export const ZAI = "zai";

/** The thinking level a session uses when the user picked none. */
export const DEFAULT_THINKING = "low";

/** A model as pi's catalog lists it. */
interface PiModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly provider?: unknown;
  /** The input types the model takes, such as `["text", "image"]`. */
  readonly input?: unknown;
  /** The model's thinking levels; a level the model does not support maps to `null`. */
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

/**
 * Returns a failed command's error text: its stderr, else its stdout, else a
 * message with the exit code.
 */
const readComplaint = (ran: Ran): string => {
  const said = (ran.stderr.trim() === "" ? ran.stdout : ran.stderr).trim();
  return said === "" ? `pi exited with code ${ran.code} and printed nothing` : said;
};

/**
 * Converts the output of `pi auth check` to an auth state. pi prints a status
 * object and exits with code 1 when no key is configured, so the exit code
 * alone cannot tell a machine with no key from a machine with a broken pi.
 * The printed status can.
 */
const buildAuth = (ran: Ran): SnapshotAuth => {
  let status: unknown;
  try {
    status = (JSON.parse(ran.stdout) as { readonly status?: unknown }).status;
  } catch {
    return { status: "error", message: truncateFact(readComplaint(ran)) };
  }
  if (status === "ready") return { status: "ok" };
  // Z.ai uses an API key, so there is no account name to report, and a
  // made-up identity would show a name the user never entered.
  return status === "not_ready"
    ? { status: "unauthenticated" }
    : { status: "error", message: truncateFact(readComplaint(ran)) };
};

const formatLevelLabel = (level: string): string =>
  `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;

/**
 * Builds the model's thinking option from the levels it supports, or returns
 * no option when it supports none. A level mapped to `null` is left out: Z.ai
 * rejects a turn at that level, so offering it would offer a choice that
 * always fails.
 */
const buildThinkingOption = (model: PiModel): ReadonlyArray<ModelOption> => {
  const levels = Object.entries(model.thinkingLevelMap ?? {}).flatMap(([level, mapped]) =>
    mapped === null || mapped === undefined ? [] : [level],
  );
  if (levels.length === 0) return [];
  return [
    {
      // The option id the composer shows and sends back with the choice.
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
      // A catalog entry with no input list is read as text only, so a missing
      // list never lets images through.
      acceptsImages: Array.isArray(model.input) && model.input.includes("image"),
      options: buildThinkingOption(model),
    }));

/**
 * Reads the model catalog from a separate pi process that saves nothing and
 * makes no network calls. Fails with an error message when pi cannot be
 * started or does not respond. The process is killed as soon as it has
 * responded: left running, it would keep the user's key in its environment
 * long after anyone looked at the Fleet page.
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
          // A probe belongs to no session, so it has no working directory.
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
      // pi lists only the providers it has a key for, so a machine with no key
      // has no catalog to read.
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

/** Builds the pi install: the vendor's install script, which cannot pin a release. */
export const makePiInstall = (
  run: Run,
): ((env: Readonly<Record<string, string | undefined>>) => Effect.Effect<InstallOutcome>) =>
  makeInstall(run, ["bash", "-c", "curl -fsSL https://pi.dev/install.sh | sh"]);
