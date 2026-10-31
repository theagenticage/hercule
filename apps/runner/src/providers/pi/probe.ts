/**
 * Probes a pi installation without starting a session: the version the binary
 * prints, whether pi finds a Z.ai key, and the models pi offers. Also builds
 * the install command that puts pi on a machine.
 *
 * The version and the key check are one-shot commands. Every pi process of
 * Hercule except the refresh runs with `--offline`, so none of them fetches
 * the model list that pi.dev publishes. The probe is the one place that does:
 * when a key is set, it first runs `pi update --models`, which stores a fresh
 * model list in the instance's home, where the offline processes read it. The
 * probe waits for the refresh only for a while, and a slower refresh still
 * runs to its end: its result is seen by the next probe or session. The
 * catalog itself needs a pi that has loaded its providers, so it is read from
 * a child process with no session, which is killed as soon as it has
 * responded.
 */
import * as Deferred from "effect/Deferred";
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

/**
 * The Z.ai key: its secret name in the instance config, and the environment
 * variable pi reads it from. The runner cannot import the pi plugin, so the
 * pi adapter owns this mapping, the same way the Claude adapter owns
 * `CLAUDE_CONFIG_DIR`.
 */
export const ZAI_KEY = { secret: "zaiApiKey", variable: "ZAI_API_KEY" };

/** The only pi provider Hercule uses; no other provider is offered or checked. */
export const ZAI = "zai";

/** The thinking level a session uses when the user picked none. */
export const DEFAULT_THINKING = "low";

/**
 * How long the probe waits for the model store refresh before it reads the
 * catalog pi has stored. The whole probe gets `PROBE_DEADLINE` (15 seconds),
 * and the version, the key check and the catalog read need the rest of it.
 */
const MODEL_STORE_REFRESH_WAIT: Duration.Duration = Duration.seconds(8);

/**
 * How long a model store refresh may run before Hercule gives up on it. pi
 * aborts its own refresh after 15 seconds, so this only concerns a pi that is
 * already stuck, for example one whose child keeps its pipes open. Without it,
 * the home's entry in the in-flight map would stay forever and the home would
 * never refresh again.
 *
 * At the limit Hercule sends pi a stop signal and frees the home without
 * waiting for pi to exit. A pi that ignores the signal may therefore overlap
 * with the next refresh. That is accepted: it needs a pi that is both stuck and
 * ignores the signal, and costs at most one extra process per probe.
 */
const MODEL_STORE_REFRESH_LIMIT: Duration.Duration = Duration.seconds(30);

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

/**
 * The largest image pi takes, in bytes before base64. pi drops an image whose
 * base64 is over 4.5 MiB from the prompt, and 4.5 MiB of base64 holds
 * 3.375 MiB (3,538,944 bytes) of image. The probe declares this limit on
 * every model that takes images, so the controller refuses or holds a larger
 * image before it is sent, instead of pi dropping it without a word.
 */
const PI_MAX_IMAGE_BYTES = 3_538_944;

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
      imageInput:
        Array.isArray(model.input) && model.input.includes("image")
          ? { maxBytes: PI_MAX_IMAGE_BYTES }
          : null,
      options: buildThinkingOption(model),
    }));

/**
 * The environment variables the model store refresh keeps. `pi update
 * --models` refreshes the list of every provider pi finds credentials for, and
 * pi has no option to name one provider. The runner's own environment may hold
 * keys of other providers (for example `OPENROUTER_API_KEY` or AWS
 * credentials), and a refresh with those would send them to those providers,
 * while a session uses the instance's own key or none. So the refresh gets
 * this list and nothing else. The proxy and TLS variables keep pi working
 * behind a corporate proxy.
 */
const REFRESH_ENV_VARIABLES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((name) => [
    name,
    name.toLowerCase(),
  ]),
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "PI_CODING_AGENT_DIR",
  "PI_SKIP_VERSION_CHECK",
  ZAI_KEY.variable,
]);

/**
 * Returns the part of a probe's environment that the model store refresh may
 * use. `PI_OFFLINE` is never in it, and pi turns the network off when that
 * variable is set to any value, `0` included.
 */
const buildRefreshEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => REFRESH_ENV_VARIABLES.has(name)));

/**
 * Refreshes the model list that pi stores in the instance's home, by running
 * `pi update --models`, and waits for it at most `MODEL_STORE_REFRESH_WAIT`.
 * Never fails: a refresh that fails or is not finished in time is logged as a
 * warning, and the probe goes on with the catalog pi has stored, or the one
 * bundled in its release. So a probe does not always report a fresh catalog:
 * the result of a refresh that ends after the wait is seen by the next probe
 * or session.
 *
 * The refresh runs in a fiber of its own, and only the wait for that fiber has
 * a time limit. Interrupting the command would kill pi while it writes its
 * model file, which can leave a corrupt file that pi never repairs, or a lock
 * file that blocks every later read for 30 seconds. The fiber is detached, so
 * the probe's own deadline does not interrupt it either, and it keeps the
 * runner's logger. Nothing stops it when the runner shuts down. pi bounds the
 * refresh itself, with a timer that starts once pi has started up, and
 * `MODEL_STORE_REFRESH_LIMIT` caps the rest.
 *
 * `inFlight` holds, for each instance home with a refresh running, a signal
 * that the refresh completes when it ends. A probe that finds one waits for it
 * instead of starting another refresh. pi's lock makes writes take turns but
 * not the network fetches, so two overlapping refreshes would fetch twice, and
 * the older answer could be stored last. The entry is stored and the refresh
 * started in one uninterruptible step, so an interrupted probe can never leave
 * an entry that no refresh will complete. The refresh removes its entry when
 * it ends, not when a probe stops waiting for it. Probes of different homes
 * never wait on each other.
 *
 * The command runs with the environment `buildRefreshEnv` builds.
 */
const refreshModelStore = (
  inFlight: Map<string, Deferred.Deferred<void>>,
  run: Run,
  binary: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void> => {
  const refreshEnv = buildRefreshEnv(env);
  const refresh = (ended: Deferred.Deferred<void>) =>
    Effect.suspend(() => run([binary, "update", "--models"], refreshEnv)).pipe(
      Effect.timeoutOption(MODEL_STORE_REFRESH_LIMIT),
      // The warnings are written here, in the fiber that ran the command, so a
      // refresh that fails after its probe has returned is still reported.
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.logWarning(
              `pi did not refresh its model list in ${home} within ${Duration.format(MODEL_STORE_REFRESH_LIMIT)}, so Hercule sent it a stop signal`,
            ),
          onSome: (ran) =>
            ran.code === 0
              ? Effect.void
              : Effect.logWarning(
                  `pi could not refresh its model list in ${home}: ${readComplaint(ran)}`,
                ),
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          inFlight.delete(home);
          return Deferred.succeed(ended, undefined);
        }),
      ),
    );
  const startOrFindRefresh = Effect.uninterruptible(
    Effect.suspend(() => {
      const running = inFlight.get(home);
      if (running !== undefined) return Effect.succeed(running);
      const ended = Deferred.makeUnsafe<void>();
      inFlight.set(home, ended);
      // A forked fiber inherits the uninterruptible region, and the limit above
      // needs to interrupt the command.
      return Effect.as(Effect.forkDetach(Effect.interruptible(refresh(ended))), ended);
    }),
  );
  return Effect.gen(function* () {
    const ended = yield* startOrFindRefresh;
    const finished = yield* Effect.timeoutOption(Deferred.await(ended), MODEL_STORE_REFRESH_WAIT);
    if (Option.isNone(finished)) {
      yield* Effect.logWarning(
        `pi has not refreshed its model list in ${home} within ${Duration.format(MODEL_STORE_REFRESH_WAIT)}, so the probe reads the list stored so far`,
      );
    }
  });
};

/**
 * Reads the model catalog from a separate pi process that saves nothing and
 * makes no network calls, so it returns the catalog pi has stored, which the
 * probe refreshes first. Fails with an error message when pi cannot be
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
      return rpc.send({ type: "get_available_models" }).pipe(
        Effect.mapError((failure) => failure.message),
        Effect.map((answer) => {
          const models = (
            answer["data"] as { readonly models?: ReadonlyArray<PiModel> } | undefined
          )?.models;
          return buildCatalog(models ?? []);
        }),
      );
    },
    (child) => Effect.sync(() => child.kill()),
  );

export const makeProbe = (spawn: PiSpawn, run: Run) => {
  const refreshesInFlight = new Map<string, Deferred.Deferred<void>>();
  return (
    binary: string,
    home: string,
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
      yield* refreshModelStore(refreshesInFlight, run, binary, home, env);
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
};

/** Builds the pi install: the vendor's install script, which cannot pin a release. */
export const makePiInstall = (
  run: Run,
): ((env: Readonly<Record<string, string | undefined>>) => Effect.Effect<InstallOutcome>) =>
  makeInstall(run, ["bash", "-c", "curl -fsSL https://pi.dev/install.sh | sh"]);
