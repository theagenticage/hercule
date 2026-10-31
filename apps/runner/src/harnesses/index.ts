/**
 * The harness adapters built into this runner.
 */
import type * as Effect from "effect/Effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type * as Stream from "effect/Stream";
import type {
  AdapterError,
  AnswerNotDelivered,
  ApprovalDecision,
  ExitReason,
  HarnessCredential,
  LoginMethod,
  ProbeResult,
  TextGenerationOutcome,
  TextGenerationSpec,
  ModelSelection,
  HarnessEvent,
  QuestionAnswers,
  SendResult,
  SessionBinding,
  SessionSpec,
  AttachmentReference,
  UnlistedModel,
  SubagentId,
  TurnInput,
  UsageReading,
} from "@hercule/protocol";
import type { AttachmentUploader } from "../attachments";
import type { ResolvedSkillReference } from "../skills";
import { CLAUDE_CODE, claudeCode } from "./claude-code";
import { CODEX, codex } from "./codex";
import { PI, pi } from "./pi";
import { makeLogins, type LoginCommand } from "./login";
import { spawnLogin } from "./process";

export interface HarnessRunnerContext {
  /**
   * Where a session runs: the workspace path, or the scratch directory the
   * runner made for a session with no workspace. For a text generation, the
   * scratch directory the runner made for that one call. `null` only for
   * operations that run no session and no text generation: a probe, an
   * install or a login (spec 06 section 4).
   */
  readonly cwd: string | null;
  /**
   * The account's Harness Home on this machine, created with mode 0700. Never the user's own
   * config directory.
   */
  readonly home: string;
  readonly binary: string | undefined;
  /**
   * The complete environment the harness is spawned with. The runner builds it
   * once, in layers: its own environment, then Hercule's own keys (spec 06 section 4). It
   * never overrides `HOME`, and it holds no credential: the adapter adds that.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * How the harness names a model for this account's provider, with `{model}`
   * where the model id goes (`{model}`, `zai/{model}`). The adapter formats
   * every model it passes to the harness with it (`formatModelArgument`).
   */
  readonly modelArgument: string;
  /**
   * Every variable the harness reads a key or token from, for any account. The
   * adapter removes all of them from the harness process's environment
   * (`applyCredential`), so a key in the runner's own environment never stands
   * in for the account's login.
   */
  readonly credentialVariables: ReadonlyArray<string>;
  /**
   * The variable the harness reads the account's key or token from, and the
   * key, sent inline on the frame that requested this operation. The field is
   * absent for an account that has no key or token stored, such as one whose
   * login is in the Harness Home. The key stays in this
   * process's memory only while the operation runs. It is never written to
   * disk, never logged, and never added to `env` here: the adapter applies it
   * to the environment of the harness process only (`applyCredential`).
   */
  readonly credential?: HarnessCredential;
  /**
   * Hercule as a tool for the agent, resolved once by the runner. Each adapter
   * installs it in its harness's own way (spec 06 section 9.3). It holds the
   * orientation every session's instructions start with, the skill text, and
   * the Claude plugin directory the runner wrote the skill into.
   */
  readonly herculeTool: {
    readonly orientation: string;
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
   * The folder that holds this session's library skills: the skills its
   * start frame names, from the Skill Library on the controller (spec 06
   * section 9.4). It is the session skills folder (`sessionSkillsFolder`),
   * set only when the start names library skills. It holds one folder per
   * skill in `skills/`, which Codex and pi load by path, and a manifest that
   * makes the whole folder a Claude plugin named `skills`. The runner
   * rebuilds it at every start and resume, and removes it when the session
   * exits. Absent when the start names no library skills, and for a probe,
   * an install or a login.
   */
  readonly librarySkillsFolder?: string;
  /**
   * The session skills folder: the one folder the runner keeps outside the
   * workspace for everything it stages for this session, namely the library
   * skills (`librarySkillsFolder` is this folder), the repository skills
   * folders below it, and the settings file of a Claude session. Set for
   * every session that has a workspace or library skills, even when nothing
   * has been written into it yet. The runner removes it when the session
   * exits. Absent for a probe, an install or a login.
   */
  readonly sessionSkillsFolder?: string;
  /**
   * The directories of the session's checkouts, in the order of the
   * workspace. The Claude adapter lists the skills each of them holds in
   * `.claude/skills` to turn off the ones Claude would load natively. Absent
   * when the workspace has no checkout, and for a probe, an install or a
   * login.
   */
  readonly checkoutPaths?: ReadonlyArray<string>;
  /**
   * The plugin folders of the session's repository skills, one per checkout
   * that has any. Each holds `.claude-plugin/plugin.json` (named
   * `repo-<checkout>`) and `skills/<name>` links into the checkout. Claude
   * loads each folder as a plugin; Codex and pi load `<folder>/skills`. Absent
   * when the workspace has none, and for a probe, an install or a login.
   */
  readonly repositorySkillsFolders?: ReadonlyArray<string>;
  /**
   * The models of the account that the harness's own model list lacks, from
   * the session's start frame or the text generation request, so the
   * harness can run a model the user picked from the catalog. The pi adapter
   * declares them to pi before it starts; every other adapter ignores them.
   * Absent when the frame carried none, and for a probe, an install or a
   * login.
   */
  readonly unlistedModels?: ReadonlyArray<UnlistedModel>;
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
   * Where this session's harness records when its commands and edits run, so
   * the runner can work out which session changed a file (spec 19 section
   * 4.1). `null` for a session whose edits are not observed (it has no
   * workspace, or works in the main one) and for operations that run no
   * session: a probe, an install or a login.
   */
  readonly editMarks: EditMarks | null;
  /**
   * Uploads the images an agent's tools return to the controller, so a
   * session's events carry a reference to each image instead of its bytes.
   * There is one per runner process; a probe, an install and a login are
   * given it too but never use it.
   */
  readonly attachmentUploader: AttachmentUploader;
}

/** How an adapter reports when the commands and edits of its harness run. */
export interface EditMarks {
  /**
   * The session's marks directory, where a gate that runs in the harness's
   * own process leaves a mark file before each tool that can write files
   * (`../edit-marks`). It sits outside the workspace and is removed when the
   * session exits.
   */
  readonly sessionMarksDir: string;
  /**
   * Takes the start mark of the tool call `toolUseId` now, for a gate that
   * runs in the runner's own process, such as Claude Code's hooks.
   * `shellCommand` is the text of a shell command, and `undefined` for any
   * other tool. It records the mark in memory, so it never waits and never
   * fails.
   */
  readonly recordToolStart: (toolUseId: string, shellCommand: string | undefined) => void;
  /** Records that the tool call `itemId` started a process, such as a shell, that can write files until `recordProcessEnd`. */
  readonly recordProcessStart: (itemId: string) => void;
  /** Records that the process of the tool call `itemId` ended. */
  readonly recordProcessEnd: (itemId: string) => void;
  /**
   * Records that the Request `requestId` asks about a tool call that already
   * runs, such as input to a running command. Call it before the Request's
   * `request.opened` is emitted, so the Request does not hold back the call's
   * window. Only the adapter can tell: Claude Code and Codex both report a
   * tool call's start before its first Request, so whether the call started
   * does not show whether it already runs.
   */
  readonly recordRequestOnRunningItem: (requestId: string) => void;
}

/**
 * The context of a text generation. The runner has already found the harness
 * binary and made the call's scratch directory, so both are present here.
 */
export type TextGenerationContext = HarnessRunnerContext & {
  readonly binary: string;
  readonly cwd: string;
};

/**
 * One image of an input, as an adapter receives it: the reference the frame
 * carried, and the path of the copy the runner fetched and checked. An
 * adapter reads the file at `path` and never talks to the controller.
 */
export type LocalAttachment = AttachmentReference & { readonly path: string };

/**
 * The input an adapter delivers: the frame's `TurnInput`, with each image
 * reference replaced by the runner's local copy of the image, and the Skill
 * References of its text that name a skill the session loaded.
 */
export type AdapterTurnInput = Omit<TurnInput, "attachments"> & {
  readonly attachments?: ReadonlyArray<LocalAttachment>;
  /**
   * The Skill References in `text` that name a skill this session loaded, in
   * text order. A skill named twice appears twice. Absent when there is none.
   * Every adapter translates all of them for its harness, and the stored text
   * stays as typed.
   */
  readonly skillReferences?: ReadonlyArray<ResolvedSkillReference>;
};

/**
 * The paths of the user's own material that an adapter passes to its harness
 * for one process. Each path existed on this machine when the runner looked
 * for it; a source that does not exist is left out.
 *
 * Every field is empty for a harness that reads the material through links
 * in its Harness Home instead. Claude Code is that harness: it reads the
 * links only when the adapter asks it to load the user's settings.
 *
 * Skills are not User Material: a session's skills come from the Skill
 * Library, in its library skills folder
 * (`HarnessRunnerContext.librarySkillsFolder`).
 */
export interface UserMaterial {
  /** Directories of prompt templates the harness loads explicitly. */
  readonly promptTemplateDirs: ReadonlyArray<string>;
  /** The user's personal instructions file, or undefined when the user has none. */
  readonly instructionsFile: string | undefined;
}

/**
 * What a harness reported, unasked, about the usage of the Provider Account a
 * running session works for (Claude Code's `rate_limit_event`, for example).
 * `readings` holds only what the harness gave: a window it gave no usage for
 * has no reading.
 */
export interface SessionUsageReport {
  readonly sessionId: string;
  readonly readings: NonEmptyReadonlyArray<UsageReading>;
}

/** What a probe is asked to do besides reading the account and the models. */
export interface ProbeOptions {
  /**
   * Whether to also read the account's usage and return it in
   * `ProbeResult.usage`. The controller sets it only when its read rule
   * allows one, because a usage read is a call to the provider. An adapter
   * with no usage read ignores it and returns `usage: null`.
   */
  readonly readUsage: boolean;
}

export interface InstallOutcome {
  readonly ok: boolean;
  readonly message?: string;
}

export interface HarnessAdapter {
  readonly harnessId: string;
  /** The harness binary's name on `PATH`, used to resolve `binary`. */
  readonly binaryName: string;
  /**
   * Side-effect free: writes nothing outside `ctx.home`, and makes no API call
   * except the usage read that `options.readUsage` asks for.
   */
  readonly probe: (ctx: HarnessRunnerContext, options: ProbeOptions) => Effect.Effect<ProbeResult>;
  /**
   * Takes an environment rather than a context, because an install is per machine, not per
   * account.
   */
  readonly install?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<InstallOutcome>;
  /**
   * Returns the command that makes the login `method` for the account in `ctx`,
   * or `undefined` when this harness has no such login. Takes the binary
   * separately, because a login needs a machine that already has the harness.
   * The command may name a scratch folder it made; the caller must then
   * start the command, which removes the folder when the login ends.
   */
  readonly login?: (
    ctx: HarnessRunnerContext,
    binary: string,
    method: LoginMethod,
  ) => LoginCommand | undefined;

  /**
   * Makes one text generation: a single model call with the spec's
   * instructions as the system prompt and its input as the one user message,
   * answered with a value that matches the spec's output schema (spec 06
   * section 14). The harness runs with no tools, no workspace and nothing
   * persisted, in its own process, which has exited before this returns.
   *
   * Returns an `ok`, `invalid-output` or `failed` outcome for every way the
   * harness can end. Fails with a message when the call cannot run at all,
   * for example when the harness will not start. The runner turns that
   * message into a `failed` outcome.
   *
   * `ctx.cwd` is the scratch directory the runner made for this call, empty
   * and readable by this user only. The adapter runs the harness there and
   * may write files there. The runner removes the directory after this
   * returns or is interrupted, so the adapter must stop the harness first.
   * The runner also finds the binary and stops the call at
   * `TEXT_GENERATION_DEADLINE_MS`.
   */
  readonly generateText: (
    ctx: TextGenerationContext,
    spec: TextGenerationSpec,
  ) => Effect.Effect<TextGenerationOutcome, string>;

  /**
   * The adapter's single output: the normalized events of every session it
   * hosts, on one stream keyed by `sessionId` (spec 06 section 4). The stream
   * is unbounded and does not replay, so a subscriber that starts after a
   * session started misses that session's earlier events. The runner
   * subscribes once, at startup.
   */
  readonly events: Stream.Stream<HarnessEvent>;

  /**
   * The adapter's second output: what its harness reports about the usage of
   * a hosted session's Provider Account, keyed by `sessionId`. It is outside
   * `events` because a report is the account's, not a step of the session's
   * conversation, and losing one costs nothing: the next report replaces it.
   * Like `events`, the stream is unbounded and does not replay, and the
   * runner subscribes once, at startup. An adapter whose harness reports no
   * usage uses `Stream.empty`.
   */
  readonly usageReports: Stream.Stream<SessionUsageReport>;

  /**
   * Starts one session and returns its binding. The caller passes the Hercule
   * session id because the controller assigns it, not the harness. The binding
   * links it to the harness's native session id (spec 06 section 4.1).
   *
   * Each adapter decides where the native id comes from. The Claude CLI sends
   * no init message until the first turn, so waiting for the id there would
   * block until somebody sent input. The Claude adapter picks the native
   * session id itself instead.
   *
   * Fails with an `AdapterError` whose tag and message give the reason the
   * session did not start (for example `HarnessNotInstalled` or
   * `ResumeTranscriptMissing`).
   * `AdapterFailed` covers every cause that has no tag of its own.
   */
  readonly startSession: (
    sessionId: string,
    spec: SessionSpec,
    ctx: HarnessRunnerContext,
  ) => Effect.Effect<SessionBinding, AdapterError>;

  /**
   * Opens a turn on an idle session or steers the running turn of a busy one,
   * and returns which it did. Only the adapter knows this: nothing downstream
   * may work it out from the order events arrive in (ADR 0007).
   *
   * An adapter does not turn input away because the session is busy. The one
   * exception is an input its harness cannot take into a running turn but
   * would run as the next one: the adapter then fails with `SteerRefused`
   * before it changes anything, and the input waits in the queue.
   *
   * Every other failure is an `AdapterError` too, and means the input failed.
   * The tag tells which of three cases it is:
   *
   * - the harness certainly did not take the input (`InputNotDelivered`,
   *   `SessionNotRunning`);
   * - it is unknown whether the harness took the input (`HarnessProtocolError`);
   * - neither of those (`AdapterFailed`).
   */
  readonly sendInput: (
    sessionId: string,
    input: AdapterTurnInput,
  ) => Effect.Effect<SendResult, AdapterError>;

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
   * `events`, with the answers, as the only report.
   *
   * Fails with `AnswerNotDelivered` when the adapter is not holding that
   * question (it was never opened here, it was already answered, it is an
   * approval, or its agent stopped), when the answer did not reach the agent,
   * or when the adapter cannot confirm that it did.
   *
   * `modelSelection` is the session's current model. A harness takes a model
   * change only on the input that starts a turn, and an answer can start one,
   * so an adapter that starts a turn for the answer applies it there and
   * ignores it otherwise.
   */
  readonly respondToQuestion: (
    sessionId: string,
    requestId: string,
    answers: QuestionAnswers,
    modelSelection: ModelSelection,
  ) => Effect.Effect<void, AnswerNotDelivered>;

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

const ADAPTERS: ReadonlyMap<string, HarnessAdapter> = new Map([
  [CLAUDE_CODE, claudeCode],
  [CODEX, codex],
  [PI, pi],
]);

/** Every adapter in this build. The session supervisor listens to the events of each. */
export const adapters: ReadonlyArray<HarnessAdapter> = [...ADAPTERS.values()];

export const ADAPTER_IDS: ReadonlyArray<string> = [...ADAPTERS.keys()];

export const findAdapter = (harnessId: string): HarnessAdapter | undefined =>
  ADAPTERS.get(harnessId);

/**
 * One per process rather than per connection, because a login's child process outlives a dropped
 * connection.
 */
export const harnessLogins = makeLogins(spawnLogin);

export { PROBE_DEADLINE, buildFailedProbe, limitProbeModels } from "./probe";

export { removeStaleSetupTokenFolders } from "./setup-token-folder";

export { CLAUDE_CODE, CODEX, PI };

/**
 * Returns the message for a harness that this runner has no adapter for,
 * which happens when the controller knows a harness that this runner build does not.
 */
export const describeMissingAdapter = (harnessId: string): string =>
  `This runner does not support the harness "${harnessId}". Update the runner, or run the session on another runner.`;
