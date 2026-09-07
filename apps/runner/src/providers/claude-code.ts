/**
 * The Claude Code adapter: the one file in Hydra that imports the vendor SDK.
 *
 * The probe is side-effect free on purpose. It starts a query with no prompt at
 * all and then asks the control protocol two questions, because a prompt that
 * yields makes a real API call at the same instant as the init message - which
 * would bill the user's account for looking at a Fleet page. It reads and
 * writes only the instance's own config directory, never the user's `~/.claude`.
 *
 * Everything the SDK and the machine can do is reached through `ClaudeSeam`, so
 * what this adapter makes of an answer can be stated without a login, a network
 * or a binary.
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

/**
 * Long enough for a cold CLI to start and answer, short enough that a Fleet
 * page waiting on it does not look hung.
 */
export const PROBE_DEADLINE: Duration.Duration = Duration.seconds(15);

/** Downloading and running somebody else's installer over a slow link. */
export const INSTALL_DEADLINE: Duration.Duration = Duration.minutes(5);

/** What the adapter asks the harness, whoever is answering. */
export interface ClaudeSession {
  readonly accountInfo: () => Promise<unknown>;
  readonly supportedModels: () => Promise<ReadonlyArray<unknown>>;
  /** Ends the query. The CLI is a child process, and it does not exit on its own. */
  readonly close: () => void;
}

/** The vendor SDK and the machine, as everything below them needs them. */
export interface ClaudeSeam {
  readonly query: (params: { readonly options: Options }) => ClaudeSession;
  readonly run: Run;
}

/** What `accountInfo()` answers with, as much of it as a snapshot carries. */
interface Account {
  readonly email?: string;
  readonly subscriptionType?: string;
  readonly apiProvider?: string;
}

/** What one row of `supportedModels()` says. */
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

/**
 * Whatever went wrong, in something the protocol will carry: `Fact` refuses an
 * empty string, and an `Error` with an empty message is a real thing to catch.
 */
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
 * Models the CLI has stopped listing but still forwards to the API unchanged.
 * Their options are hand-authored because there is no longer a row describing
 * them; retiring one is deleting a line here in a release.
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

/**
 * One row as the composer reads it. Only the choices the CLI says that model
 * accepts become options: adaptive thinking is reported as a property of the
 * model rather than as something a user picks, so it is not one.
 */
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
 * The probed catalog, then the legacy overlay for whatever it did not list. A
 * probed row always wins: it is what the harness on this machine will really
 * offer, and the overlay is only what it has stopped describing.
 *
 * Cut to what the protocol carries, because a catalog that will not encode is a
 * machine that reports nothing at all rather than one that reports a long list.
 */
const catalogOf = (models: ReadonlyArray<Model>): ReadonlyArray<ModelDescriptor> => {
  // A row the CLI named with nothing is a row nothing can select, and the
  // protocol will not carry an empty slug or name.
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

/**
 * What every way of running the harness is started with. `HOME` is left exactly
 * as it was: overriding it points the CLI at another account's credential and
 * makes it report that one as this instance's.
 */
const envFor = (ctx: ProviderRunnerContext): Record<string, string | undefined> => ({
  ...ctx.env,
  CLAUDE_CONFIG_DIR: ctx.home,
  // A probe that let the harness update itself would install a version nobody
  // chose in the middle of answering a question about versions.
  DISABLE_AUTOUPDATER: "1",
});

/**
 * The one shape the SDK is started with. `settingSources: []` and
 * `strictMcpConfig` keep the user's own settings and MCP servers out of a run
 * that is only meant to read two facts, and `persistSession: false` keeps it
 * from leaving a session behind - though the CLI writes into the config
 * directory regardless, which is why that directory is the instance's own.
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
      // Whatever the binary prints is its own business, so an unrecognisable
      // answer goes raw - but an empty one is not a version, and the protocol
      // will not carry it.
      const printed = fact(SEMVER.exec(ran.stdout)?.[0] ?? ran.stdout.trim());
      return printed === "" ? null : printed;
    });

  /** Both questions over one query, and the query closed however they went. */
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
     * The vendor's paste-a-code login, against this instance's own config
     * directory. `BROWSER` is a command that fails on purpose: a launch that
     * succeeds makes the CLI switch to a `localhost` callback, which a browser
     * on any other machine can never reach.
     */
    login: (ctx: ProviderRunnerContext, binary: string): LoginCommand => ({
      command: [binary, "auth", "login"],
      env: { ...envFor(ctx), BROWSER: "false" },
    }),

    /**
     * The vendor's own installer, pinned to the CLI this build's SDK talks to.
     * The script always downloads the latest binary first and then installs the
     * version it was asked for, so a pin still needs the network.
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

/** What an operator needs off a failed installer: what it was saying at the end. */
const LAST_LINES = 5;

const lastLines = (output: string): string => {
  const said = output.trimEnd().split("\n").slice(-LAST_LINES).join("\n");
  return said === ""
    ? "the installer failed without saying why"
    : said.slice(-MAX_INSTALL_MESSAGE_LENGTH);
};

/** The adapter as it ships: the real SDK, and real child processes. */
export const claudeCode: ProviderAdapter = claudeCodeAdapter({
  query: ({ options }) => {
    const session: Query = sdkQuery({ prompt: noPrompt(), options });
    return {
      accountInfo: () => session.accountInfo(),
      supportedModels: () => session.supportedModels(),
      close: () => {
        // Ending the query waits on the CLI child, which rejects when the
        // transport is already gone - the very case `close` runs in after a
        // crash or a deadline. An unhandled rejection would take the whole
        // daemon down over one bad probe.
        session.return(undefined).catch(() => undefined);
      },
    };
  },
  run: runProcess,
});
