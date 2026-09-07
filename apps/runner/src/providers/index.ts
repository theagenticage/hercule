/**
 * The provider adapters this runner build carries. Only Claude Code exists;
 * Codex and pi get theirs with their own tickets.
 */
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { MAX_FACT_LENGTH, type ProbeResult } from "@hydra/protocol";
import { CLAUDE_CODE, claudeCode } from "./claude-code";
import { logins, type LoginCommand } from "./login";
import { spawnLogin } from "./process";

export interface ProviderRunnerContext {
  /** The instance's own config directory, created 0700 and never the user's own. */
  readonly home: string;
  readonly binary: string | undefined;
  /** Never carries a `HOME` override. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface InstallOutcome {
  readonly ok: boolean;
  readonly message?: string;
}

export interface ProviderAdapter {
  readonly providerId: string;
  /** The harness binary's name on `PATH`, which is how `binary` is resolved. */
  readonly binaryName: string;
  /** Side-effect free: makes no API call and writes nothing outside `ctx.home`. */
  readonly probe: (ctx: ProviderRunnerContext, config: Schema.Json) => Effect.Effect<ProbeResult>;
  /** Takes an environment, not a context: an install is per machine, not per instance. */
  readonly install?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<InstallOutcome>;
  /** The binary is passed separately: a login needs a machine that already has one. */
  readonly login?: (ctx: ProviderRunnerContext, binary: string) => LoginCommand;
}

const ADAPTERS: ReadonlyMap<string, ProviderAdapter> = new Map([[CLAUDE_CODE, claudeCode]]);

export const ADAPTER_IDS: ReadonlyArray<string> = [...ADAPTERS.keys()];

export const adapterFor = (providerId: string): ProviderAdapter | undefined =>
  ADAPTERS.get(providerId);

/** One per process, not per connection: a child outlives a socket that drops. */
export const providerLogins = logins(spawnLogin);

/** Cut to what the protocol carries rather than failing the whole report. */
export const probeFailed = (message: string): ProbeResult => ({
  harnessVersion: null,
  auth: { status: "error", message: message.slice(0, MAX_FACT_LENGTH) },
  models: [],
});

export const noAdapterFor = (providerId: string): string =>
  `no adapter for ${providerId} in this runner build`;
