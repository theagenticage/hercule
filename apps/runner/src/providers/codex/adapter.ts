/**
 * The Codex adapter. Everything it knows about the harness it learns over one
 * app-server connection, and everything that connection touches lives under the
 * instance's own home: a runner that read the developer's own Codex directory
 * would mix Hydra's sessions with the user's login, skills and memory.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { CODEX_VERSION, VERSION } from "@hydra/home/version";
import {
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  type ModelDescriptor,
  type ModelOption,
  type ProbeResult,
  type ProviderEvent,
  type SessionBinding,
} from "@hydra/protocol";
import { INSTALL_DEADLINE, lastLines } from "../claude-code";
import type { InstallOutcome, ProviderAdapter, ProviderRunnerContext } from "../index";
import { runProcess, spawnAppServer, type Run } from "../process";
import { rpcOver, type AppServerSpawn, type Rpc, type RpcError } from "./rpc";
import type {
  GetAccountResponse,
  InitializeParams,
  InitializeResponse,
  Model,
  ModelListResponse,
  ThreadStartParams,
  ThreadStartResponse,
} from "./types";

export const CODEX = "codex";

const CODEX_BINARY = "codex";

/** Long enough for a cold app-server, short enough that a Fleet page does not look hung. */
export const PROBE_DEADLINE: Duration.Duration = Duration.seconds(15);

/** What an app-server writes on its way out, kept for the report when it dies. */
const MAX_COMPLAINT_LINES = 5;

export interface CodexSeam {
  readonly appServer: AppServerSpawn;
  readonly run: Run;
}

/** One app-server, and what it said that was not a frame. */
interface Host {
  readonly rpc: Rpc;
  readonly kill: () => void;
  readonly complaint: () => string;
}

/** Cut to what the protocol carries; one over-long value would fail the report. */
const fact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

const failed = (harnessVersion: string | null, message: string): ProbeResult => ({
  harnessVersion,
  auth: { status: "error", message: fact(message) },
  models: [],
});

/**
 * `initialize` carries no version field, so the version is the token after the
 * first `/` of the user agent, which reads `<client>/<version> (os; arch) ...`.
 * A user agent that does not read as one reports nothing rather than a guess,
 * which `versionVerdict` already takes as "unknown".
 */
const USER_AGENT = /^[^/\s]+\/(\S+)/;

const versionOf = (userAgent: string): string | null =>
  USER_AGENT.exec(userAgent)?.[1]?.slice(0, MAX_FACT_LENGTH) ?? null;

const authOf = ({ account }: GetAccountResponse): ProbeResult["auth"] => {
  if (account === null) return { status: "unauthenticated" };
  if (account.type !== "chatgpt") return { status: "ok", backend: account.type };
  return {
    status: "ok",
    ...(account.email === null ? {} : { identity: fact(account.email) }),
    planLabel: account.planType,
    backend: account.type,
  };
};

const selecting = (
  id: string,
  label: string,
  choices: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  preferred: string | null,
): ModelOption => ({
  id,
  label,
  kind: "select",
  choices,
  default: preferred ?? choices[0]!.value,
});

/**
 * Only what the model itself lists: an empty select is a control the composer
 * shows and nothing can be chosen in.
 */
const optionsFor = (model: Model): ReadonlyArray<ModelOption> => {
  const options: Array<ModelOption> = [];
  const efforts = model.supportedReasoningEfforts ?? [];
  if (efforts.length > 0) {
    options.push(
      selecting(
        "reasoningEffort",
        "Reasoning effort",
        efforts.map(({ reasoningEffort }) => ({
          value: fact(reasoningEffort),
          label: fact(`${reasoningEffort.slice(0, 1).toUpperCase()}${reasoningEffort.slice(1)}`),
        })),
        model.defaultReasoningEffort ?? null,
      ),
    );
  }
  const tiers = model.serviceTiers ?? [];
  if (tiers.length > 0) {
    options.push(
      selecting(
        "serviceTier",
        "Service tier",
        // An unnamed tier is still a tier, and the protocol will not carry an
        // empty label.
        tiers.map((tier) => ({
          value: fact(tier.id),
          label: fact(tier.name === "" || tier.name === undefined ? tier.id : tier.name),
        })),
        model.defaultServiceTier ?? null,
      ),
    );
  }
  return options;
};

const catalogOf = (models: ReadonlyArray<Model>): ReadonlyArray<ModelDescriptor> =>
  models
    // The protocol will not carry an empty slug or name.
    .filter((model) => model.id !== "" && model.displayName !== "")
    .slice(0, MAX_FACT_ITEMS)
    .map((model) => ({
      slug: fact(model.id),
      name: fact(model.displayName),
      ...(model.isDefault === true ? { isDefault: true } : {}),
      options: optionsFor(model),
    }));

/**
 * Attestation is declined here rather than left to a request nobody answers,
 * and the experimental surface is off because this build talks the methods the
 * pinned release declares.
 */
const INITIALIZE: InitializeParams = {
  clientInfo: { name: "hydra", title: "Hydra", version: VERSION },
  capabilities: { experimentalApi: false, requestAttestation: false },
};

export const codexAdapter = (seam: CodexSeam): ProviderAdapter => {
  // Creating an unbounded PubSub allocates and nothing more, so it is safe to
  // run here and keeps `adapterFor` the synchronous lookup every other caller
  // already treats it as.
  const published = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  const bindings = new Map<string, SessionBinding>();
  /** One app-server per instance: its sessions share the auth refresh and the model catalog. */
  const hosts = new Map<string, Host>();

  /**
   * `CODEX_HOME` alone does not isolate a session: Codex reads skills out of
   * the user's `~/.agents/skills`, so `HOME` is relocated to an empty directory
   * of the instance's own. Doing it here rather than in the session context is
   * what keeps Claude's Keychain lookup working, which a relocated `HOME`
   * breaks.
   */
  const envFor = (ctx: ProviderRunnerContext): Record<string, string | undefined> => {
    const codexHome = join(ctx.home, "codex");
    const neutral = join(ctx.home, "home");
    for (const directory of [codexHome, neutral]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    return { ...ctx.env, CODEX_HOME: codexHome, HOME: neutral };
  };

  const startHost = (ctx: ProviderRunnerContext, binary: string): Host => {
    const complaints: Array<string> = [];
    const child = seam.appServer(
      // `--strict-config` turns a knob renamed in an upgrade from silent drift
      // into a start failure, and the updater is off because a harness that
      // updated itself would run a version nobody chose.
      [binary, "app-server", "--strict-config", "-c", "check_for_update_on_startup=false"],
      envFor(ctx),
    );
    const remember = (line: string): void => {
      complaints.push(line);
      if (complaints.length > MAX_COMPLAINT_LINES) complaints.shift();
    };
    void (async () => {
      try {
        for await (const line of child.stderr) if (line.trim() !== "") remember(line);
      } catch {
        // A child killed mid-read has nothing more to complain about, and what
        // it already said is still worth reporting.
      }
    })();
    const rpc = rpcOver(child, {
      onServerRequest: () => undefined,
      onNotification: () => undefined,
      onWarning: remember,
    });
    Effect.runFork(rpc.pump);
    return { rpc, kill: child.kill, complaint: () => complaints.join("\n") };
  };

  /** A home this runner may not write is an ordinary state, not a defect. */
  const openHost = (ctx: ProviderRunnerContext, binary: string): Effect.Effect<Host, string> =>
    Effect.try({
      try: () => startHost(ctx, binary),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    });

  /** Nothing else may be asked of an app-server until this has been answered. */
  const handshake = (host: Host): Effect.Effect<InitializeResponse, RpcError> =>
    Effect.map(host.rpc.request("initialize", INITIALIZE), (answer) => {
      host.rpc.notify("initialized");
      return answer as InitializeResponse;
    });

  /** What the app-server said, in preference to what the codec made of it. */
  const saidBy = (host: Host, error: RpcError): string => {
    const said = host.complaint();
    return said === "" ? error.message : said;
  };

  const hostFor = (
    instanceId: string,
    ctx: ProviderRunnerContext,
    binary: string,
  ): Effect.Effect<Host, string> =>
    Effect.suspend(() => {
      const running = hosts.get(instanceId);
      if (running !== undefined) return Effect.succeed(running);
      return Effect.flatMap(openHost(ctx, binary), (host) =>
        Effect.matchEffect(handshake(host), {
          // Registered only once it has answered: a host kept under an instance
          // id without a handshake is one every later session would talk to and
          // none of them could, and its child would outlive the runner.
          onFailure: (error) => {
            const said = saidBy(host, error);
            host.kill();
            return Effect.fail(said);
          },
          onSuccess: () => {
            hosts.set(instanceId, host);
            return Effect.succeed(host);
          },
        }),
      );
    });

  const unbuilt = (what: string): Effect.Effect<never> =>
    Effect.die(new Error(`${what} is not implemented in this runner build`));

  return {
    providerId: CODEX,
    binaryName: CODEX_BINARY,

    events: Stream.fromPubSub(published),

    // Every shipped provider's config schema is empty, so the Codex adapter
    // takes nothing from it and does not name the argument.
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> => {
      const binary = ctx.binary;
      if (binary === undefined) {
        return Effect.succeed(failed(null, `no ${CODEX_BINARY} on this machine`));
      }
      // A probe runs on a process of its own and kills it: sharing the
      // connection a session runs on would keep an app-server alive for a Fleet
      // page nobody is looking at any more.
      const gather = Effect.acquireUseRelease(
        openHost(ctx, binary),
        (host) =>
          Effect.matchEffect(handshake(host), {
            onFailure: (error) => Effect.succeed(failed(null, saidBy(host, error))),
            onSuccess: (initialized) =>
              Effect.match(
                Effect.all([
                  host.rpc.request("account/read", {}),
                  host.rpc.request("model/list", {}),
                ]),
                {
                  onFailure: (error) =>
                    failed(versionOf(initialized.userAgent), saidBy(host, error)),
                  onSuccess: ([account, models]) => ({
                    harnessVersion: versionOf(initialized.userAgent),
                    auth: authOf(account as GetAccountResponse),
                    models: catalogOf((models as ModelListResponse).data),
                  }),
                },
              ),
          }),
        (host) => Effect.sync(() => host.kill()),
      ).pipe(Effect.catch((message) => Effect.succeed(failed(null, message))));
      return Effect.map(
        Effect.timeoutOption(gather, PROBE_DEADLINE),
        Option.getOrElse(() =>
          failed(null, `the app-server did not answer within ${Duration.format(PROBE_DEADLINE)}`),
        ),
      );
    },

    startSession: (sessionId, spec, ctx) =>
      Effect.gen(function* () {
        const binary = ctx.binary;
        if (binary === undefined) return yield* Effect.fail(`no ${CODEX_BINARY} on this machine`);
        const host = yield* hostFor(spec.instanceId, ctx, binary);
        const params: ThreadStartParams = {
          cwd: ctx.cwd,
          model: spec.modelSelection.model,
          ephemeral: false,
        };
        const started = yield* Effect.mapError(
          host.rpc.request("thread/start", params),
          (error) => error.message,
        );
        const binding: SessionBinding = {
          sessionId,
          nativeSessionId: (started as ThreadStartResponse).thread.id,
          instanceId: spec.instanceId,
        };
        bindings.set(sessionId, binding);
        return binding;
      }),

    sendInput: () => unbuilt("sending to a Codex session"),

    interrupt: () => unbuilt("interrupting a Codex turn"),

    respondToRequest: () => unbuilt("answering a Codex request"),

    stopSession: () => unbuilt("stopping a Codex session"),

    listSessions: Effect.sync(() => [...bindings.values()]),

    /** The script URL is pinned to the tag, so it and the release it fetches move together. */
    install: (env: Readonly<Record<string, string | undefined>>): Effect.Effect<InstallOutcome> =>
      Effect.map(
        Effect.timeoutOption(
          seam.run(
            [
              "bash",
              "-c",
              `curl -fsSL https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/scripts/install/install.sh | CODEX_RELEASE=${CODEX_VERSION} CODEX_NON_INTERACTIVE=1 sh`,
            ],
            env,
          ),
          INSTALL_DEADLINE,
        ),
        Option.match({
          onNone: () => ({
            ok: false,
            message: `the installer did not finish within ${Duration.format(INSTALL_DEADLINE)}`,
          }),
          onSome: (ran) =>
            ran.code === 0
              ? { ok: true }
              : { ok: false, message: lastLines(ran.stderr === "" ? ran.stdout : ran.stderr) },
        }),
      ),
  };
};

export const codex: ProviderAdapter = codexAdapter({ appServer: spawnAppServer, run: runProcess });
