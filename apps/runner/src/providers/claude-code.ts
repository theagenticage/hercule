/**
 * The one file that imports the vendor SDK. The probe runs with no prompt and
 * asks the control protocol instead: a prompt that yields would bill the user's
 * account for opening a Fleet page. It touches only the instance's config
 * directory, never the user's `~/.claude`.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { query as sdkQuery, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION } from "@hydra/home/version";
import {
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  MAX_INSTALL_MESSAGE_LENGTH,
  type ModelDescriptor,
  type ModelOption,
  type ProbeResult,
} from "@hydra/protocol";
import type { InstallOutcome, ProviderAdapter, ProviderRunnerContext } from "./index";
import type { LoginCommand } from "./login";
import { runProcess, type Run } from "./process";

export const CLAUDE_CODE = "claude-code";

const CLAUDE_BINARY = "claude";

/** Long enough for a cold CLI, short enough that a Fleet page does not look hung. */
export const PROBE_DEADLINE: Duration.Duration = Duration.seconds(15);

/** Downloading and running somebody else's installer over a slow link. */
export const INSTALL_DEADLINE: Duration.Duration = Duration.minutes(5);

export interface ClaudeSession {
  readonly accountInfo: () => Promise<unknown>;
  readonly supportedModels: () => Promise<ReadonlyArray<unknown>>;
  /** Ends the query. The CLI is a child process, and it does not exit on its own. */
  readonly close: () => void;
}

export interface ClaudeSeam {
  readonly query: (params: { readonly options: Options }) => ClaudeSession;
  readonly run: Run;
}

interface Account {
  readonly email?: string;
  readonly subscriptionType?: string;
  readonly apiProvider?: string;
}

interface Model {
  readonly value: string;
  readonly displayName: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsFastMode?: boolean;
}

const SEMVER = /\d+\.\d+\.\d+\S*/;

/** The effort level the CLI starts on when nothing chose one. */
const DEFAULT_EFFORT = "medium";

/** Cut to what the protocol carries; one over-long value would fail the report. */
const fact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/** `Fact` refuses an empty string, and an `Error` can carry an empty message. */
const describe = (error: unknown): string => {
  const said = fact(error instanceof Error ? error.message : String(error));
  return said === "" ? "the harness failed without saying why" : said;
};

const failed = (harnessVersion: string | null, message: string): ProbeResult => ({
  harnessVersion,
  auth: { status: "error", message },
  models: [],
});

/** Only ever called with levels the CLI listed, or with the overlay's own. */
function effortOver([first, ...rest]: readonly [string, ...ReadonlyArray<string>]): ModelOption {
  const levels = [first, ...rest];
  return {
    id: "effort",
    label: "Effort",
    kind: "select",
    choices: levels.map((level) => ({
      value: fact(level),
      label: fact(`${level.slice(0, 1).toUpperCase()}${level.slice(1)}`),
    })),
    default: levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : first,
  };
}

const FAST_MODE: ModelOption = {
  id: "fastMode",
  label: "Fast mode",
  kind: "boolean",
  default: false,
};

/**
 * Models the CLI no longer lists but still forwards to the API. Options are
 * hand-authored because no row describes them any more.
 */
const LEGACY_MODELS: ReadonlyArray<ModelDescriptor> = [
  {
    slug: "claude-opus-4-8",
    name: "Opus 4.8",
    isLegacy: true,
    options: [effortOver(["low", "medium", "high"])],
  },
  {
    slug: "claude-fable-5",
    name: "Fable 5",
    isLegacy: true,
    options: [effortOver(["low", "medium", "high"])],
  },
];

/** Adaptive thinking is a property of the model, not a choice, so it is no option. */
const descriptorOf = (model: Model): ModelDescriptor => {
  const options: Array<ModelOption> = [];
  const levels = model.supportedEffortLevels ?? [];
  const [first, ...rest] = levels;
  if (model.supportsEffort === true && first !== undefined) {
    options.push(effortOver([first, ...rest]));
  }
  if (model.supportsFastMode === true) options.push(FAST_MODE);
  return {
    slug: fact(model.value),
    name: fact(model.displayName),
    ...(model.value === "default" ? { isDefault: true } : {}),
    options,
  };
};

/**
 * A probed row wins over the overlay: it is what this machine will really offer.
 * Cut to what the protocol carries, or the whole report fails to encode.
 */
const catalogOf = (models: ReadonlyArray<Model>): ReadonlyArray<ModelDescriptor> => {
  // The protocol will not carry an empty slug or name.
  const probed = models
    .filter((model) => model.value !== "" && model.displayName !== "")
    .map(descriptorOf);
  const listed = new Set(probed.map((model) => model.slug));
  return [...probed, ...LEGACY_MODELS.filter((model) => !listed.has(model.slug))].slice(
    0,
    MAX_FACT_ITEMS,
  );
};

const authOf = (account: Account): ProbeResult["auth"] =>
  account.email === undefined
    ? { status: "unauthenticated" }
    : {
        status: "ok",
        identity: fact(account.email),
        ...(account.subscriptionType === undefined
          ? {}
          : { planLabel: fact(account.subscriptionType) }),
        ...(account.apiProvider === undefined ? {} : { backend: fact(account.apiProvider) }),
      };

/** `HOME` is left alone: overriding it makes the CLI report another account's login. */
const envFor = (ctx: ProviderRunnerContext): Record<string, string | undefined> => ({
  ...ctx.env,
  CLAUDE_CONFIG_DIR: ctx.home,
  // A probe that let the harness update itself would install a version nobody
  // chose in the middle of answering a question about versions.
  DISABLE_AUTOUPDATER: "1",
});

/**
 * The user's own settings and MCP servers stay out of a run that only reads two
 * facts. The CLI writes into the config directory regardless, which is why that
 * directory is the instance's own.
 */
const optionsFor = (ctx: ProviderRunnerContext, binary: string): Options => ({
  pathToClaudeCodeExecutable: binary,
  settingSources: [],
  strictMcpConfig: true,
  persistSession: false,
  env: envFor(ctx),
});

/** The prompt the SDK insists on, yielding nothing, so the run costs nothing. */
const noPrompt = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined as never }),
  }),
});

export const claudeCodeAdapter = (seam: ClaudeSeam): ProviderAdapter => {
  const versionOf = (ctx: ProviderRunnerContext, binary: string): Effect.Effect<string | null> =>
    Effect.map(seam.run([binary, "--version"], envFor(ctx)), (ran) => {
      if (ran.code !== 0) return null;
      // An unrecognisable version goes raw; an empty one the protocol will not carry.
      const printed = fact(SEMVER.exec(ran.stdout)?.[0] ?? ran.stdout.trim());
      return printed === "" ? null : printed;
    });

  const ask = (
    ctx: ProviderRunnerContext,
    binary: string,
  ): Effect.Effect<{ account: Account; models: ReadonlyArray<Model> }, string> =>
    Effect.acquireUseRelease(
      Effect.sync(() => seam.query({ options: optionsFor(ctx, binary) })),
      (session) =>
        Effect.gen(function* () {
          const account = yield* Effect.tryPromise({
            try: () => session.accountInfo(),
            catch: describe,
          });
          const models = yield* Effect.tryPromise({
            try: () => session.supportedModels(),
            catch: describe,
          });
          return { account: account as Account, models: models as ReadonlyArray<Model> };
        }),
      (session) => Effect.sync(() => session.close()),
    );

  return {
    providerId: CLAUDE_CODE,
    binaryName: CLAUDE_BINARY,

    // Every shipped provider's config schema is empty, so the Claude adapter
    // takes nothing from it and does not name the argument.
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> => {
      const binary = ctx.binary;
      if (binary === undefined) {
        return Effect.succeed(failed(null, `no ${CLAUDE_BINARY} on this machine`));
      }
      const gather = Effect.gen(function* () {
        const harnessVersion = yield* versionOf(ctx, binary);
        return yield* Effect.match(ask(ctx, binary), {
          onFailure: (message) => failed(harnessVersion, message),
          onSuccess: ({ account, models }) => ({
            harnessVersion,
            auth: authOf(account),
            models: catalogOf(models),
          }),
        });
      });
      return Effect.map(
        Effect.timeoutOption(gather, PROBE_DEADLINE),
        Option.getOrElse(() =>
          failed(null, `the harness did not answer within ${Duration.format(PROBE_DEADLINE)}`),
        ),
      );
    },

    /**
     * `BROWSER` fails on purpose: a successful launch makes the CLI switch to a
     * `localhost` callback, which a browser on another machine cannot reach.
     */
    login: (ctx: ProviderRunnerContext, binary: string): LoginCommand => ({
      command: [binary, "auth", "login"],
      env: { ...envFor(ctx), BROWSER: "false" },
    }),

    /**
     * Pinned to the CLI this build's SDK talks to. The script needs the network
     * even so.
     */
    install: (env: Readonly<Record<string, string | undefined>>): Effect.Effect<InstallOutcome> =>
      Effect.map(
        Effect.timeoutOption(
          seam.run(
            [
              "bash",
              "-c",
              `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}`,
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

const LAST_LINES = 5;

const lastLines = (output: string): string => {
  const said = output.trimEnd().split("\n").slice(-LAST_LINES).join("\n");
  return said === ""
    ? "the installer failed without saying why"
    : said.slice(-MAX_INSTALL_MESSAGE_LENGTH);
};

export const claudeCode: ProviderAdapter = claudeCodeAdapter({
  query: ({ options }) => {
    const session: Query = sdkQuery({ prompt: noPrompt(), options });
    return {
      accountInfo: () => session.accountInfo(),
      supportedModels: () => session.supportedModels(),
      close: () => {
        // The child is usually already gone when close runs, and the rejection
        // would take the daemon down over one bad probe.
        session.return(undefined).catch(() => undefined);
      },
    };
  },
  run: runProcess,
});
