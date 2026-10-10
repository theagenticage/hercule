/**
 * The provider adapters built into this runner.
 */
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type {
  ApprovalDecision,
  ExitReason,
  ProbeResult,
  ProviderEvent,
  QuestionAnswers,
  SendResult,
  SessionBinding,
  SessionSpec,
  AttachmentReference,
  SubagentId,
  TurnInput,
} from "@hercule/protocol";
import type { AttachmentUploader } from "../attachments";
import { CLAUDE_CODE, claudeCode } from "./claude-code";
import { CODEX, codex } from "./codex";
import { PI, pi } from "./pi";
import { makeLogins, type LoginCommand } from "./login";
import { spawnLogin } from "./process";

export interface ProviderRunnerContext {
  /**
   * Where a session runs: the workspace path, or the scratch directory the
   * runner made for a session with no workspace. `null` only for operations
   * that run no session: a probe, an install or a login (spec 06 section 4).
   */
  readonly cwd: string | null;
  /**
   * The instance's own config directory, created with mode 0700. Never the user's own config
   * directory.
   */
  readonly home: string;
  readonly binary: string | undefined;
  /**
   * The complete environment the harness is spawned with. The runner builds it
   * once, in layers: its own environment, then the instance config's, then
   * Hercule's own keys (spec 06 section 4). It never overrides `HOME`.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The instance's secret config fields, keyed by the name the plugin gave each.
   * The controller decrypts them and sends them inline on the frame that
   * requested this operation. They stay in this process's memory only while the
   * operation runs. They are never written to disk, never logged, and never
   * added to `env` here, because each adapter decides which variable a
   * credential belongs in.
   */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * Hercule as a tool for the agent, resolved once by the runner. Each adapter
   * installs it in its harness's own way (spec 06 section 9.3). It holds the
   * skill text, and the Claude plugin directory the runner wrote the skill
   * into. Exactly one function per adapter reads this.
   */
  readonly herculeTool: {
    readonly skill: string;
    readonly claudePluginDir: string;
  };
  /**
   * The paths of the user's own material this session's harness is given.
   * The field being present is what marks the session as one that sees User
   * Material: a Thread on the controller's local runner, whose start frame
   * has the `userMaterial` flag set (spec 06 section 9.1). The field is
   * absent for every other session, and for a probe, an install or a login,
   * so their adapters keep the harness isolated.
   */
  readonly userMaterial?: UserMaterial;
  /**
   * The directory the runner caches this session's attached images in, one
   * file per image. It sits outside the workspace, so git never sees the
   * files, and it is removed when the session exits. The Claude adapter gives
   * its harness read access to it when the harness starts, because Claude
   * takes extra directories only as a start option. `null` only for
   * operations that run no session: a probe, an install or a login.
   */
  readonly attachmentsDir: string | null;
  /**
   * Uploads the images an agent's tools return to the controller, so a
   * session's events carry a reference to each image instead of its bytes.
   * There is one per runner process; a probe, an install and a login are
   * given it too but never use it.
   */
  readonly attachmentUploader: AttachmentUploader;
}

/**
 * One image of an input, as an adapter receives it: the reference the frame
 * carried, and the path of the copy the runner fetched and checked. An
 * adapter reads the file at `path` and never talks to the controller.
 */
export type LocalAttachment = AttachmentReference & { readonly path: string };

/**
 * The input an adapter delivers: the frame's `TurnInput`, with each image
 * reference replaced by the runner's local copy of the image.
 */
export type AdapterTurnInput = Omit<TurnInput, "attachments"> & {
  readonly attachments?: ReadonlyArray<LocalAttachment>;
};

/**
 * The paths of the user's own material that an adapter passes to its harness
 * for one process. Each path existed on this machine when the runner looked
 * for it; a source that does not exist is left out.
 *
 * Every field is empty for a harness that reads the material through links
 * in its instance home instead. Claude Code is that harness: it reads the
 * links only when the adapter asks it to load the user's settings.
 */
export interface UserMaterial {
  /** Directories of skills the harness is told to load by path. */
  readonly skillDirs: ReadonlyArray<string>;
  /** Directories of prompt templates the harness loads explicitly. */
  readonly promptTemplateDirs: ReadonlyArray<string>;
  /** The user's personal instructions file, or undefined when the user has none. */
  readonly instructionsFile: string | undefined;
}

export interface InstallOutcome {
  readonly ok: boolean;
  readonly message?: string;
}

export interface ProviderAdapter {
  readonly providerId: string;
  /** The harness binary's name on `PATH`, used to resolve `binary`. */
  readonly binaryName: string;
  /** Side-effect free: makes no API call and writes nothing outside `ctx.home`. */
  readonly probe: (ctx: ProviderRunnerContext, config: Schema.Json) => Effect.Effect<ProbeResult>;
  /**
   * Takes an environment rather than a context, because an install is per machine, not per
   * instance.
   */
  readonly install?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<InstallOutcome>;
  /** Takes the binary separately, because a login needs a machine that already has the harness. */
  readonly login?: (ctx: ProviderRunnerContext, binary: string) => LoginCommand;

  /**
   * The adapter's single output: the normalized events of every session it
   * hosts, on one stream keyed by `sessionId` (spec 06 section 4). The stream
   * is unbounded and does not replay, so a subscriber that starts after a
   * session started misses that session's earlier events. The runner
   * subscribes once, at startup.
   */
  readonly events: Stream.Stream<ProviderEvent>;

  /**
   * Starts one session and returns its binding. The caller passes the Hercule
   * session id because the controller assigns it, not the harness. The binding
   * links it to the harness's native session id (spec 06 section 4.1).
   *
   * Each adapter decides where the native id comes from. The Claude CLI sends
   * no init message until the first turn, so waiting for the id there would
   * block until somebody sent input. The Claude adapter picks the native
   * session id itself instead.
   */
  readonly startSession: (
    sessionId: string,
    spec: SessionSpec,
    ctx: ProviderRunnerContext,
  ) => Effect.Effect<SessionBinding, string>;

  /**
   * Opens a turn on an idle session or steers the running turn of a busy one,
   * and returns which it did. Only the adapter knows this: nothing downstream
   * may work it out from the order events arrive in (ADR 0007). Never turns
   * input away because the session is busy.
   */
  readonly sendInput: (
    sessionId: string,
    input: AdapterTurnInput,
  ) => Effect.Effect<SendResult, string>;

  /**
   * Stops work in a session. The only report is each stopped turn completing
   * as `interrupted` on `events`, and each Request of a stopped agent
   * resolving as `cancel`. Does nothing for a session this adapter does not
   * hold.
   *
   * - Without `subagentId`, it stops all work: the turn of the session's own
   *   agent and every running subagent.
   * - With `subagentId`, it stops that subagent and every subagent below it
   *   (spec 06 section 13.4).
   */
  readonly interrupt: (sessionId: string, subagentId?: SubagentId) => Effect.Effect<void>;

  /**
   * Decides one approval an agent of the session is parked on, by the id the
   * adapter gave it. That agent resumes, and `request.resolved` follows on `events` as the
   * only report. Does nothing when the adapter is not holding that approval:
   * it was never opened here, it was already decided, it is a question, or it
   * does not offer this decision.
   */
  readonly respondToApprovalRequest: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void>;

  /**
   * Answers the questions one agent of the session is parked on, by the id the
   * adapter gave the request. That agent resumes, and `request.resolved` follows on
   * `events`, with the answers, as the only report. Does nothing when the
   * adapter is not holding that question: it was never opened here, it was
   * already answered, or it is an approval.
   */
  readonly respondToQuestion: (
    sessionId: string,
    requestId: string,
    answers: QuestionAnswers,
  ) => Effect.Effect<void>;

  /**
   * Stops the harness cleanly. `session.exited { reason }` follows on
   * `events`, with the reason the caller gave, because the supervisor is the
   * one that knows why the session stopped. Does nothing for a session this
   * adapter does not hold.
   */
  readonly stopSession: (sessionId: string, reason: ExitReason) => Effect.Effect<void>;

  /** The bindings of the sessions this adapter is hosting right now. */
  readonly listSessions: Effect.Effect<ReadonlyArray<SessionBinding>>;
}

const ADAPTERS: ReadonlyMap<string, ProviderAdapter> = new Map([
  [CLAUDE_CODE, claudeCode],
  [CODEX, codex],
  [PI, pi],
]);

/** Every adapter in this build. The session supervisor listens to the events of each. */
export const adapters: ReadonlyArray<ProviderAdapter> = [...ADAPTERS.values()];

export const ADAPTER_IDS: ReadonlyArray<string> = [...ADAPTERS.keys()];

export const findAdapter = (providerId: string): ProviderAdapter | undefined =>
  ADAPTERS.get(providerId);

/**
 * One per process rather than per connection, because a login's child process outlives a dropped
 * connection.
 */
export const providerLogins = makeLogins(spawnLogin);

export { PROBE_DEADLINE, buildFailedProbe } from "./probe";

export { CLAUDE_CODE, CODEX, PI };

export const describeMissingAdapter = (providerId: string): string =>
  `no adapter for ${providerId} in this runner build`;
