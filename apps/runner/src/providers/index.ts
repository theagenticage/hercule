/**
 * The provider adapters this runner build carries. Only Claude Code exists;
 * Codex and pi get theirs with their own tickets.
 */
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import {
  MAX_FACT_LENGTH,
  type ApprovalDecision,
  type ExitReason,
  type ProbeResult,
  type ProviderEvent,
  type SendResult,
  type SessionBinding,
  type SessionSpec,
  type TurnInput,
} from "@hydra/protocol";
import { CLAUDE_CODE, claudeCode } from "./claude-code";
import { logins, type LoginCommand } from "./login";
import { spawnLogin } from "./process";

export interface ProviderRunnerContext {
  /**
   * Where a session runs: the workspace path, or the scratch directory the
   * runner made for a workspace-less one. `null` only where nothing runs - a
   * probe, an install, a login (spec 06 section 4).
   */
  readonly cwd: string | null;
  /** The instance's own config directory, created 0700 and never the user's own. */
  readonly home: string;
  readonly binary: string | undefined;
  /**
   * The whole environment the harness is spawned with, layered once by the
   * runner: its own, then the instance config's, then Hydra's own keys (spec 06
   * section 4). Never carries a `HOME` override.
   */
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

  /**
   * The one output channel: every session this adapter hosts, normalized, on
   * one stream keyed by `sessionId` (spec 06 section 4). Unbounded and without
   * replay, so a subscriber that starts after a session did misses what it
   * missed; the runner subscribes once, at startup.
   */
  readonly events: Stream.Stream<ProviderEvent>;

  /**
   * Starts one session and answers with the binding. The Hydra session id is
   * passed in because it is the controller's, not the harness's; the binding is
   * what joins the two (spec 06 section 4.1). Where the native id comes from is
   * the adapter's business: spec 06 section 4.1 says Claude's arrives on the
   * init message, but the CLI sends none until a first turn does, so the Claude
   * adapter names the native session itself instead.
   */
  readonly startSession: (
    sessionId: string,
    spec: SessionSpec,
    ctx: ProviderRunnerContext,
  ) => Effect.Effect<SessionBinding, string>;

  /**
   * Opens a turn on an idle session, steers a busy one, and says which it did.
   * The adapter is the only authority on that: nothing downstream may read it
   * off the order events arrive in (ADR 0007). Never bounces input.
   */
  readonly sendInput: (sessionId: string, input: TurnInput) => Effect.Effect<SendResult, string>;

  /**
   * Ends the running turn. It completes as `interrupted` on `events`, which is
   * the only report; a session this adapter does not hold has no turn to end.
   */
  readonly interrupt: (sessionId: string) => Effect.Effect<void>;

  /**
   * Answers the question the session is parked on, by the id the adapter minted
   * for it. The harness resumes and `request.resolved` follows on `events`,
   * which is the only report. A request this adapter is not holding - never
   * opened here, already answered, or one that does not take this answer - is
   * a no-op.
   */
  readonly respondToRequest: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void>;

  /**
   * Ends the harness cleanly. `session.exited { reason }` follows on `events`,
   * carrying the reason the caller gave: the supervisor is the one that knows
   * why. A session this adapter does not hold is already stopped.
   */
  readonly stopSession: (sessionId: string, reason: ExitReason) => Effect.Effect<void>;

  /** What this adapter is hosting right now, as bindings. */
  readonly listSessions: Effect.Effect<ReadonlyArray<SessionBinding>>;
}

const ADAPTERS: ReadonlyMap<string, ProviderAdapter> = new Map([[CLAUDE_CODE, claudeCode]]);

/** Every adapter this build carries: what the session supervisor listens to. */
export const adapters: ReadonlyArray<ProviderAdapter> = [...ADAPTERS.values()];

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
