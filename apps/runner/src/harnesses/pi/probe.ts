/**
 * Probes a pi installation without starting a session: the version the binary
 * prints, whether pi finds a key for the account's provider, and the models pi
 * offers for that provider. Also builds the install command that puts pi on a
 * machine.
 *
 * The version and the key check are one-shot commands. When a key is set, the
 * probe first refreshes pi's stored model list with `pi update --models`; every
 * other pi process stays `--offline` and reads that stored list. The catalog
 * needs a pi that has loaded its providers, so it is read from a child process
 * with no session, which is killed as soon as it has responded.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type { ModelDescriptor, ModelOption, ProbeResult, SnapshotAuth } from "@hercule/protocol";
import type { InstallOutcome } from "../index";
import { makeInstall } from "../install";
import { PROBE_DEADLINE, buildFailedProbe, limitModelCatalog } from "../probe";
import type { Ran, Run } from "../process";
import { truncateFact } from "../text";
import { makeRpc, type PiSpawn } from "./rpc";

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
 * stops its own refresh after 15 seconds, so this only reaches a stuck pi, for
 * example one whose child keeps its pipes open. At the limit Hercule sends pi a
 * stop signal and does not wait for it to exit.
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
  // An API key has no account name to report, and a
  // made-up identity would show a name the user never entered.
  return status === "not_ready"
    ? { status: "unauthenticated" }
    : { status: "error", message: truncateFact(readComplaint(ran)) };
};

const formatLevelLabel = (level: string): string =>
  `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;

/**
 * Builds the model's thinking option from the levels it supports, or returns
 * no option when it supports none. A level mapped to `null` is left out: the
 * provider rejects a turn at that level, so offering it would offer a choice
 * that always fails.
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

const buildCatalog = (
  models: ReadonlyArray<PiModel>,
  provider: string,
): ReadonlyArray<ModelDescriptor> =>
  models
    .filter(
      (model) =>
        model.provider === provider &&
        typeof model.id === "string" &&
        model.id !== "" &&
        typeof model.name === "string" &&
        model.name !== "",
    )
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
 * --models` refreshes every provider pi finds credentials for and cannot be
 * limited to one, while a session uses the account's own key or none. So the
 * refresh must not see the runner's other keys (for example `OPENROUTER_API_KEY`
 * or AWS credentials). The proxy and TLS variables keep pi working behind a
 * corporate proxy. The account's own credential variable is added to these.
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
]);

/**
 * Returns the part of a probe's environment that the model store refresh may
 * use: the variables above, and the account's credential variable when it has
 * one. `PI_OFFLINE` is never in it, and pi turns the network off when that
 * variable is set to any value, `0` included.
 */
const buildRefreshEnv = (
  env: Readonly<Record<string, string | undefined>>,
  credentialVariable: string | undefined,
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => REFRESH_ENV_VARIABLES.has(name) || name === credentialVariable,
    ),
  );

/**
 * Refreshes the model list that pi stores in the Harness Home, by running
 * `pi update --models`, and waits for it at most `MODEL_STORE_REFRESH_WAIT`.
 * Never fails: a refresh that fails or is not finished in time is logged as a
 * warning, and the probe goes on with the list pi has stored, or the one
 * bundled in its release.
 *
 * The refresh is its own command because, in RPC mode, pi answers before its
 * background refresh ends. It runs in a detached fiber and only the wait is
 * bounded: interrupting pi while it writes its store can corrupt the file or
 * leave a lock that blocks readers for 30 seconds. A refresh that ends after
 * the wait is seen by the next probe or session. Two probes of one home close
 * together each start a refresh. pi's lock keeps the store whole, but the
 * refresh that ends last wins even if it fetched a little earlier, which is
 * accepted.
 */
const refreshModelStore = (
  run: Run,
  binary: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  credentialVariable: string | undefined,
): Effect.Effect<void> => {
  const refresh = Effect.suspend(() =>
    run([binary, "update", "--models"], buildRefreshEnv(env, credentialVariable)),
  ).pipe(
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
  );
  return Effect.gen(function* () {
    const refreshing = yield* Effect.forkDetach(refresh);
    const finished = yield* Effect.timeoutOption(Fiber.await(refreshing), MODEL_STORE_REFRESH_WAIT);
    if (Option.isNone(finished)) {
      yield* Effect.logWarning(
        `pi has not refreshed its model list in ${home} within ${Duration.format(MODEL_STORE_REFRESH_WAIT)}, so the probe reads the list stored so far`,
      );
    }
  });
};

/**
 * Reads the model catalog from a separate pi process that saves nothing and
 * makes no network calls, so it returns the list pi has stored. Fails with an
 * error message when pi cannot be started or does not respond. The process is
 * killed as soon as it has responded: left running, it would keep the user's
 * key in its environment long after anyone looked at the Fleet page.
 */
const fetchCatalog = (
  spawn: PiSpawn,
  binary: string,
  env: Readonly<Record<string, string | undefined>>,
  provider: string,
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
        Effect.flatMap((answer) => {
          const models = (
            answer["data"] as { readonly models?: ReadonlyArray<PiModel> } | undefined
          )?.models;
          return limitModelCatalog("pi", buildCatalog(models ?? [], provider));
        }),
      );
    },
    (child) => Effect.sync(() => child.kill()),
  );

/**
 * Builds the probe of one account's provider. `provider` is pi's name for it
 * (see `readPiProvider`), and `credentialVariable` the variable the account's
 * key is in, or undefined for an account without one.
 */
export const makeProbe =
  (spawn: PiSpawn, run: Run) =>
  (
    binary: string,
    home: string,
    env: Readonly<Record<string, string | undefined>>,
    provider: string,
    credentialVariable: string | undefined,
  ): Effect.Effect<ProbeResult> => {
    const gather = Effect.gen(function* () {
      const version = yield* run([binary, "--version"], env);
      if (version.code !== 0) return buildFailedProbe(null, readComplaint(version));
      const harnessVersion = truncateFact(version.stdout.trim());
      const auth = buildAuth(
        yield* run([binary, "auth", "check", "--provider", provider, "--json"], env),
      );
      // pi lists only the providers it has a key for, so a machine with no key
      // has no catalog to read.
      if (auth.status !== "ok") return { harnessVersion, auth, models: [], usage: null };
      yield* refreshModelStore(run, binary, home, env, credentialVariable);
      return yield* Effect.match(fetchCatalog(spawn, binary, env, provider), {
        onFailure: (message) => buildFailedProbe(harnessVersion, message),
        onSuccess: (models) => ({ harnessVersion, auth, models, usage: null }),
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
