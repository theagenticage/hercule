/**
 * The provider adapters this runner build carries.
 *
 * An adapter is what turns a provider instance into something that runs on this
 * machine. Only the Claude Code one exists; Codex and pi get theirs with their
 * own tickets, which is why this is an interface rather than a function.
 *
 * The controller drives every adapter: instance ids and configs live there, so
 * nothing here starts on its own.
 */
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { MAX_FACT_LENGTH, type ProbeResult } from "@hydra/protocol";
import { CLAUDE_CODE, claudeCode } from "./claude-code";
import { logins, type LoginCommand } from "./login";
import { spawnLogin } from "./process";

/** Where one provider instance keeps its state on this machine, and what it drives. */
export interface ProviderRunnerContext {
  /** The instance's own config directory, created 0700 and never the user's own. */
  readonly home: string;
  /** The harness binary the facts probe found, absent on a machine without it. */
  readonly binary: string | undefined;
  /** What the harness is started with. Never carries a `HOME` override. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** How an install ended, in the words the operator reads. */
export interface InstallOutcome {
  readonly ok: boolean;
  readonly message?: string;
}

export interface ProviderAdapter {
  readonly providerId: string;
  /** The harness binary's name on `PATH`, which is how `binary` is resolved. */
  readonly binaryName: string;
  /**
   * Reads what the harness says about itself: its version, whose login it is
   * holding and which models it offers. Side-effect free by construction - it
   * makes no API call and writes nothing outside `ctx.home`.
   */
  readonly probe: (ctx: ProviderRunnerContext, config: Schema.Json) => Effect.Effect<ProbeResult>;
  /**
   * Puts the harness on this machine. Absent on an adapter that cannot. It
   * takes the environment rather than a context: an install is per machine and
   * per harness, so there is no instance whose home it could belong to.
   */
  readonly install?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<InstallOutcome>;
  /**
   * How this vendor's headless login is started. Absent on an adapter with no
   * login of its own. The binary is passed separately because a login can only
   * be started on a machine that has one.
   */
  readonly login?: (ctx: ProviderRunnerContext, binary: string) => LoginCommand;
}

const ADAPTERS: ReadonlyMap<string, ProviderAdapter> = new Map([[CLAUDE_CODE, claudeCode]]);

/** The provider ids this build can drive, which is what the hello reports. */
export const ADAPTER_IDS: ReadonlyArray<string> = [...ADAPTERS.keys()];

export const adapterFor = (providerId: string): ProviderAdapter | undefined =>
  ADAPTERS.get(providerId);

/**
 * The logins this machine is holding. One per process rather than per
 * connection: the child outlives a socket that drops between the URL and the
 * code the user is still pasting.
 */
export const providerLogins = logins(spawnLogin);

/**
 * What a runner answers with when it could not probe at all. The message is
 * what the Fleet row shows, so it is cut to what the protocol carries rather
 * than left to fail the whole report.
 */
export const probeFailed = (message: string): ProbeResult => ({
  harnessVersion: null,
  auth: { status: "error", message: message.slice(0, MAX_FACT_LENGTH) },
  models: [],
});

/** Why a provider cannot be driven here, in the words the user reads. */
export const noAdapterFor = (providerId: string): string =>
  `no adapter for ${providerId} in this runner build`;
