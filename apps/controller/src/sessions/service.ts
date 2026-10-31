/**
 * The session service: the session row, its lifecycle, the inputs waiting on
 * it, and the stream of events it leaves behind.
 *
 * This service stores a session from a spec that is already decided, and
 * turns what a runner reports about a session into rows. It also builds the
 * frames sent to a runner about a session, because the frame contents belong
 * to this domain. But nothing here talks to a runner: the controller daemon,
 * one layer up, decides when a frame is sent and over which connection. So the
 * methods the daemon calls return frames, or return what is left to do,
 * instead of doing it.
 *
 * A method that takes only ids does not decode them again: the transport has
 * already decoded a request's ids against the contract, and a caller inside
 * the controller passes ids it read from stored rows.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  buildAgentStepResultRequest,
  SessionSpec,
  type AccessMode,
  type AccountUsageReported,
  type AgentStepResultRequest,
  type ApprovalDecision,
  type ContinuedSubagent,
  type Delivery,
  type FilesEdited,
  type GitIdentity,
  type HarnessAccount,
  SubagentId,
  type ModelSelection,
  type UnlistedModel,
  type HarnessEvent,
  type QuestionAnswers,
  type SessionBinding,
  type SessionInput,
  type SessionInputResult,
  type SessionInterrupt,
  type SessionRespondToApprovalRequest,
  type SessionRespondToQuestion,
  type SessionStart,
  type SessionStop,
  type WorkspaceStepKey,
  SKILLS_CAPABILITY,
} from "@hercule/protocol";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  DEFAULT_PAGE_LIMIT,
  Id,
  INPUT_SORT_FIELDS,
  EMPTY_PROMPT_MESSAGE,
  INPUT_UPDATE_FIELDS,
  refuseEmptyInputUpdate,
  InvalidState,
  NotFound,
  SESSION_SORT_FIELDS,
  SessionFilter,
  SessionRole,
  SUBAGENT_SORT_FIELDS,
  TRANSCRIPT_SORT_FIELDS,
  TranscriptPosition,
  type Forbidden,
  OWN_AGENT_ALIAS,
  OWN_SESSION_ALIAS,
  PASSAGE_SORT_FIELDS,
  PassageFilter,
  type Input,
  type Passage,
  type Session,
  type SessionIdsInput,
  type SessionKind,
  type SessionRequest,
  type SessionStatus,
  type Subagent,
  type SortDirection,
  type TranscriptRow,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { buildSessionStamp, currentStamp, requireGrant, SYSTEM_ACTOR, type Actor } from "../actor";
import { excludeDigest, claimAttachments, readClaimableAttachments } from "../attachments";
import { findAccountKind, PluginHost } from "../plugins";
import { providerAccountRepository } from "../provider-accounts";
import {
  afterCommit,
  announce,
  buildMatchExpression,
  nowIso,
  buildPageInputFields,
  mintUuid,
  refuseCursor,
  resolveSortDirection,
  uuidToString,
  withTransaction,
  type Page,
} from "../db";
import { mintToken, hashToken } from "../credentials";
import { AuditLog } from "../events";
import { Notifier } from "../notifications";
import {
  buildPermissionRequestSubject,
  permissionRequestRepository,
  SessionTokens,
} from "../permissions";
import type { SendOutcome } from "../runners";
import { decideSessionSkills, type SessionLibrarySkill } from "../skills";
import { permissionRequestSubscriptions } from "../subscriptions";
import { AccountUsage } from "../usage";
import { WorkspaceService, type GithubAccount } from "../workspaces";
import {
  APPROVAL_ANSWER_IDS,
  buildApprovalNotification,
  buildRequestSubject,
  buildWaitEndedWithdrawReason,
  buildWithdrawReason,
  WITHDRAW_REASON_SESSION_ENDED,
  type WaitEndedBy,
} from "./approval-notification";
import {
  findAttachmentRefusal,
  refuseUnacceptedAttachments,
  type AttachmentTurn,
} from "./attachment-refusal";
import {
  inputRepository,
  type EarlierReason,
  type LostWakeUp,
  type NewMatchedInput,
  type StoredInput,
} from "./inputs";
import { SessionEditObserver } from "./edit-observer";
import { SessionObserver, type SessionEndReason } from "./observer";
import { sessionRecordComposer } from "./records";
import { isResumeHeld } from "./resume-hold";
import {
  readSessionOrFail,
  sessionRepository,
  type QueuePosition,
  type SessionAccess,
  type StoredSession,
} from "./repository";
import {
  attributeEvent,
  compareOpenRequests,
  computeOpenRequestsAfter,
  fold,
  isRequestEvent,
  startTracking,
  type Folded,
  type RequestEvent,
  type Tracked,
} from "./stream";
import { subagentRepository } from "./subagent-repository";
import {
  collectSubagentTree,
  computeSubagentsAfter,
  findSubagentsToRead,
  stopSubagent,
  toSubagentRecord,
  type StoredSubagent,
  type SubagentEventFacts,
} from "./subagents";
import { hasOtherTurn, readAssistantTexts, readOpenTurnId } from "./transcript-log";
import { buildStepKey, buildTurnInput } from "./turn-input";
import { addUsageReport, clearProcessShare } from "./usage";

const QueryInput = Schema.Struct({
  ...SessionFilter.fields,
  ...buildPageInputFields(SESSION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const TranscriptInput = Schema.Struct({
  id: Id,
  subagentId: Schema.optionalKey(SubagentId),
  after: Schema.optionalKey(TranscriptPosition),
  ...buildPageInputFields(TRANSCRIPT_SORT_FIELDS),
});

export type TranscriptInput = Schema.Schema.Type<typeof TranscriptInput>;

const PassageQueryInput = Schema.Struct({
  ...PassageFilter.fields,
  ...buildPageInputFields(PASSAGE_SORT_FIELDS),
});

export type PassageQueryInput = Schema.Schema.Type<typeof PassageQueryInput>;

const SubagentQueryInput = Schema.Struct({
  id: Id,
  ...buildPageInputFields(SUBAGENT_SORT_FIELDS),
});

export type SubagentQueryInput = Schema.Schema.Type<typeof SubagentQueryInput>;

const InputQueryInput = Schema.Struct({ id: Id, ...buildPageInputFields(INPUT_SORT_FIELDS) });

export type InputQueryInput = Schema.Schema.Type<typeof InputQueryInput>;

const InputUpdate = Schema.Struct({ id: Id, inputId: Id, ...INPUT_UPDATE_FIELDS }).check(
  refuseEmptyInputUpdate,
);

export type InputUpdate = Schema.Schema.Type<typeof InputUpdate>;

export interface SessionPage {
  readonly items: ReadonlyArray<Session>;
  readonly nextCursor?: string;
}

export interface TranscriptPage {
  readonly items: ReadonlyArray<TranscriptRow>;
  readonly nextCursor?: string;
}

export interface PassagePage {
  readonly items: ReadonlyArray<Passage>;
  readonly nextCursor?: string;
}

export interface SubagentPage {
  readonly items: ReadonlyArray<Subagent>;
  readonly nextCursor?: string;
}

export interface InputPage {
  readonly items: ReadonlyArray<Input>;
  readonly nextCursor?: string;
}

/**
 * Everything needed to store one new session, whether it starts a
 * conversation or continues another session. Every value is already decided:
 * the controller daemon chose the runner and opened the workspace before this
 * row is written.
 */
export interface CreateRequest {
  /**
   * Created by the caller, not by the insert. The workspace is opened in the
   * same transaction, and a thread's own worktree is created on a branch named
   * after the thread, so the id has to exist before either row does.
   */
  readonly id: string;
  readonly permissionProfileId: string;
  /** The Agent the session was spawned from; `undefined` for a Thread. */
  readonly agentId: string | undefined;
  /** The assistant's conversation the session answers; `undefined` for any other session. */
  readonly conversationId: string | undefined;
  /**
   * The run, agent step and iteration whose prompt the session opens with;
   * `undefined` for any other session. The run and step are stored on the
   * session, and the iteration on its first input.
   */
  readonly step: WorkspaceStepKey | undefined;
  readonly runnerId: string;
  /**
   * The qualified id of the harness the session runs in. The caller resolves
   * it when it places the session, and the session keeps it for good.
   */
  readonly harnessId: string;
  readonly requestedAccessMode: AccessMode;
  readonly parentSessionId: string | undefined;
  /** The spec sent to the runner. The row's stored fields are taken from it. */
  readonly spec: SessionSpec;
  readonly prompt: string;
  /** The ids of the prompt's images, from `attachment.create`, in order. */
  readonly attachments: ReadonlyArray<string>;
  /**
   * The session's title, chosen by the caller, or `undefined` to take it
   * from the prompt (`buildTitle`).
   */
  readonly title: string | undefined;
  /** The role the caller chose; `undefined` for a session that starts without one. */
  readonly role: string | undefined;
  readonly kind: "session.spawned" | "session.continued";
  /** The audit entry's payload, apart from the new session's id. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectId: string | undefined;
  /** The branch the main workspace is switched to before the harness starts. */
  readonly checkoutBranch: string | undefined;
  /** The GitHub account this session pushes as. */
  readonly githubConnectionId: string | undefined;
  /**
   * The timestamp, chosen by the caller: the workspace it opened and this row
   * are written together and share one timestamp. The actor is read from the
   * ambient context, so it is not passed.
   */
  readonly at: string;
}

/**
 * A session claimed for starting, the complete frame that starts it, and the
 * input the frame carries, claimed with it.
 */
export interface StartRequest {
  readonly sessionId: string;
  readonly frame: SessionStart;
  /** The session's oldest waiting input, claimed (`sentAt` set) in the same transaction. */
  readonly input: StoredInput;
}

/**
 * What a start frame needs from outside this domain, passed in by the caller:
 * the credential readers, the builder of the coordination paragraph, the
 * runner, and the id of the controller's local runner. The controller daemon
 * passes its own credential readers, so this domain never reads a secret
 * itself.
 */
export interface StartNeeds {
  /**
   * Returns the GitHub account of a Connection with its token and the token's
   * expiry, or `undefined` when the Connection has no usable token. This is a
   * plain read: it never refreshes, because a refresh calls GitHub and a
   * transaction never waits on anything outside the database. The runner asks
   * the controller for a fresh token when it prepares the session.
   */
  readonly readGithubAccount: (connectionId: string) => Effect.Effect<GithubAccount | undefined>;
  /**
   * Returns the identity a Connection's account commits as, or `undefined`
   * when the Connection does not exist or is not a GitHub Connection. It does
   * not depend on the token: a Connection whose token is unusable still has
   * its login, and the runner commits as it once it has fetched a new token.
   */
  readonly readGitIdentity: (
    connectionId: string,
  ) => Effect.Effect<GitIdentity | undefined, SqlError>;
  /**
   * Checks that the account can run in the harness on the runner the sessions
   * start on, as it can now rather than when the session was queued. Fails
   * with `InvalidState` and the reason when it cannot, such as a sign-in that
   * has since ended or a harness that was removed from the runner. That ends
   * the session like a failed `prepareHarnessAccount`.
   */
  readonly requireAccountRunnable: (
    providerAccountId: string,
    harnessId: string,
  ) => Effect.Effect<void, InvalidState | SqlError>;
  /**
   * Returns what the runner needs to run the harness for the account: its
   * home, model argument and credential, the credential decrypted for this
   * frame and stored nowhere (`prepareHarnessAccount`). Fails when the account
   * is gone or the pair cannot run, or when the key cannot be decrypted. That
   * skips the session: a session started without its key would report that it
   * is not signed in.
   */
  readonly prepareHarnessAccount: (
    providerAccountId: string,
    harnessId: string,
  ) => Effect.Effect<HarnessAccount, NotFound | InvalidState | SqlError>;
  /**
   * Returns the models of the account's Model Catalog that the harness's own
   * list on the runner lacks, for the frame's `unlistedModels`
   * (`UnlistedModels.listUnlistedModels`), where `model` is the model the
   * session runs. Empty when the harness is told of none. A database read only.
   */
  readonly listUnlistedModels: (
    providerAccountId: string,
    harnessId: string,
    runnerId: string,
    model: string,
  ) => Effect.Effect<ReadonlyArray<UnlistedModel>, SqlError>;
  /**
   * Builds the session's coordination paragraph (spec 19 section 7.1), or
   * returns `undefined` when the session gets none.
   */
  readonly buildCoordination: (sessionId: string) => Effect.Effect<string | undefined, SqlError>;
  /**
   * The runner the sessions start on: its name, for the warning a runner too
   * old for skills gets, and the capabilities it negotiated at hello, which
   * are `null` before its first hello.
   */
  readonly runner: {
    readonly name: string;
    readonly negotiatedCapabilities: ReadonlyArray<string> | null;
  };
  /**
   * The id of the controller's local runner, or `undefined` while it is not
   * known. A Thread starting on this runner gets the `userMaterial` flag.
   */
  readonly localRunnerId: string | undefined;
}

/**
 * Returns the warning a Thread's conversation shows when the session should
 * get skills from the Skill Library but its runner is too old to load them.
 */
const buildOldRunnerSkillsWarning = (runnerName: string): string =>
  `This runner (\`${runnerName}\`) is too old to load skills. Update it to use them.`;

/** One user input to store, and the model selection the session runs under from then on. */
export interface TakeInputRequest<E> {
  readonly sessionId: string;
  /** The model selection the session runs under from this input on. */
  readonly modelSelection: ModelSelection;
  /**
   * Builds the encoded spec a resumed session goes back on the queue with,
   * from the session as it is read inside the transaction, for an input that
   * resumes an exited session; `undefined` for a session that is still live.
   * It runs only once `resume` has decided the session is resumed.
   */
  readonly buildResumeSpec: ((session: StoredSession) => Effect.Effect<string, E>) | undefined;
  readonly text: string;
  /** The ids of the input's images, from `attachment.create`, in order. */
  readonly attachments: ReadonlyArray<string>;
  readonly at: string;
  /**
   * Claims the row in the insert when the session is idle and has no input on
   * the wire, for a caller that sends a claimed row itself once the write is
   * committed. The stored row's `sentAt` shows whether it was claimed. An
   * idle session will not change to idle again, so no flush would send the
   * input, and a claimed row is one nothing else sends or cancels.
   *
   * An idle session with an input on the wire is treated like a busy one: the
   * runner takes one input per turn boundary, so the new input waits, and the
   * flush at the end of that input's turn sends it.
   */
  readonly claimWhenIdle: boolean;
  /** The agent step iteration this input is the prompt for; `undefined` for any other input. */
  readonly stepIteration?: number;
}

/**
 * What the controller daemon still has to do after a report's rows are
 * committed. Each item means sending a frame to a runner, which this domain
 * never does itself.
 */
export interface AppliedReport {
  /** The session's new status, or `undefined` when this report did not change it. */
  readonly moved: SessionStatus | undefined;
  /**
   * `true` when the session exited while input it keeps was still waiting
   * for it. The caller resumes the session after the commit, so the input
   * runs.
   */
  readonly exitedHoldingInput?: true;
  /**
   * The input claimed because the session's turn ended, which the caller
   * sends after the commit. The claim is in the same transaction as the
   * change to idle, so no delivery pass can read the session as idle and
   * claim an input of its own first.
   */
  readonly claimedInput?: StoredInput;
  /**
   * `true` when the session's turn ended and no input was claimed for it, so
   * it stays idle. The caller may then tell the session about Discussions
   * after the commit (spec 19 section 5.3).
   */
  readonly turnEndedIdle?: true;
}

/**
 * What `recordInputAnswer` recorded for an input that was sent to a runner:
 *
 * - `delivered`: the delivery the runner reported;
 * - `notDelivered`: the reason the input went back to waiting, or was
 *   cancelled because the runner failed it, its session exited or its step's
 *   run ended;
 * - `steerDeferred`: the runner could not fold the input into the running
 *   turn, and the input is waiting again, to run as the next turn. It is not
 *   a failure, so the caller tells its own caller the input is queued;
 * - `unconfirmed`: the input is an agent step's prompt that got no answer,
 *   so it is marked `sent` and never sent again. `resultRequest` asks the
 *   runner how the step's turn ended; the caller tells it to the runner.
 */
export type RecordedInputAnswer =
  | { readonly _tag: "delivered"; readonly delivery: Delivery }
  | { readonly _tag: "notDelivered"; readonly reason: string }
  | { readonly _tag: "steerDeferred" }
  | { readonly _tag: "unconfirmed"; readonly resultRequest: AgentStepResultRequest };

/** Returns a stored input as the API shows it: each image without the digest only a runner checks. */
const buildInputRecord = (row: StoredInput): Input => ({
  ...row,
  attachments: row.attachments.map(excludeDigest),
});

/** Converts a page to the contract's shape, where a missing cursor is an absent key, not `null`. */
const toPageOutput = <A>(listing: Page<A>): { items: ReadonlyArray<A>; nextCursor?: string } => ({
  items: listing.items,
  ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
});

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeTranscript = Schema.decodeUnknownEffect(TranscriptInput);
const decodePassageQuery = Schema.decodeUnknownEffect(PassageQueryInput);
const decodeSubagentQuery = Schema.decodeUnknownEffect(SubagentQueryInput);
const decodeInputQuery = Schema.decodeUnknownEffect(InputQueryInput);
const decodeInputUpdate = Schema.decodeUnknownEffect(InputUpdate);
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);
const decodeSpecDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionSpec));

/** Newest first: a session list is read as a history. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** Oldest first: a transcript is read forwards, the way it happened. */
const TRANSCRIPT_DIRECTION: SortDirection = "asc";

/** Newest first: a search of past conversations is read from the most recent. */
const PASSAGE_DIRECTION: SortDirection = "desc";

/**
 * Returns the Agent `agentId: "me"` names: the Agent the calling session runs
 * as. Fails with `Validation` for a session that runs as no Agent, such as a
 * Thread, and for any caller that is not a session. The message says what to
 * pass instead.
 */
const resolveOwnAgent = (actor: Actor): Effect.Effect<string, Validation> => {
  if (actor._tag === "session" && actor.agentId !== null) return Effect.succeed(actor.agentId);
  const message =
    actor._tag === "session"
      ? `"${OWN_AGENT_ALIAS}" names the Agent this session runs as, and this session runs as no Agent; name the Agent by its id`
      : `"${OWN_AGENT_ALIAS}" names the Agent of the calling session, and only a session has one; name the Agent by its id`;
  return Effect.fail(createValidationError([{ path: ["agentId"], message }]));
};

/**
 * Returns the actor stamp `actor: "me"` names: the stamp of the calling
 * session, which the sessions it created carry. Fails with `Validation` for
 * any caller that is not a session, saying what to do instead.
 */
const resolveOwnStamp = (actor: Actor): Effect.Effect<string, Validation> =>
  actor._tag === "session"
    ? Effect.succeed(buildSessionStamp(actor.sessionId))
    : Effect.fail(
        createValidationError([
          {
            path: ["actor"],
            message: `"${OWN_SESSION_ALIAS}" keeps the sessions the calling session created, and only a session creates sessions as itself; leave actor out`,
          },
        ]),
      );

/** Oldest first: a session's subagents are listed in the order they started. */
const SUBAGENT_DIRECTION: SortDirection = "asc";

/** Oldest first: inputs are sent in the order the caller sent them. */
const INPUT_DIRECTION: SortDirection = "asc";

const NO_SUCH_INPUT = "no such input on that session";

/**
 * The error message for a session whose Provider Account was deleted. The
 * session is kept as history, but nothing can run it any more.
 */
export const ACCOUNT_DELETED = "The account this thread ran on was deleted.";

/**
 * Returns the refusal of `markDone` for the session `id`, which is not a
 * Thread. The whole call changed nothing, so the message says which id to
 * remove.
 */
const describeMarkDoneRefusal = (id: string, kind: SessionKind): string =>
  `${id} is not a Thread (its kind is ${kind}), and only a Thread can be marked Done; stop it with session.stop instead. Nothing was marked Done, so remove that id and try again`;

/**
 * Returns the refusal of `reopen` for the session `id`, which is not a
 * Thread. The whole call changed nothing, so the message says which id to
 * remove.
 */
const describeReopenRefusal = (id: string, kind: SessionKind): string =>
  `${id} is not a Thread (its kind is ${kind}), so it is never Done and there is nothing to reopen. Nothing was reopened, so remove that id and try again`;

const NO_SUCH_SUBAGENT =
  "no such subagent on that session; list the session's subagents to find their ids";

const ALREADY_SENT = "that input has already been sent to the runner";

/**
 * The refusal of `input.cancel` on the input a session's start carries: the
 * oldest waiting input while the session is `queued`, and the input on the
 * wire while it is `starting`. A start always carries an input, so without it
 * the session would start with nothing to do.
 */
const FIRST_INPUT_NOT_CANCELLABLE =
  "this input is what the session starts with, so it cannot be cancelled; stop the session instead";

/**
 * The reason stored on an input whose frame left the controller but got no
 * answer: the connection ended before the runner answered, or no answer
 * came in time. Both look the same to the caller. The row goes back to
 * waiting, whether it was sent on its own or carried by a start, and the
 * next send of the session's input tries again. An agent step's prompt is
 * never handled this way, because the runner may have run it.
 */
const NOT_DELIVERED =
  "that session's runner did not take the input, so it is waiting to be sent again";

/**
 * The reason stored on an input whose frame never left the controller,
 * because the session's runner had no connection. The row goes back to
 * waiting, an agent step's prompt too, and the next send of the session's
 * input tries again once the runner connects.
 */
const NOT_SENT =
  "that session's runner is not connected; the input stays queued and is sent when the runner connects";

/**
 * The refusal of a second answer to one request. The runner still reports
 * the request as open until the harness has taken the first answer, so
 * without this check a second click would send the harness a second answer.
 */
const ALREADY_ANSWERED =
  "that request was already answered, so this answer was not sent; " +
  "read the session again to see whether it is waiting on a request now";

/**
 * The refusal of an answer to a request whose wait already ended without an
 * answer: the user interrupted the turn or stopped the session, or the
 * harness moved on. The runner may still report the request as open for a
 * moment, but the harness no longer waits for this answer.
 */
const WAIT_ENDED =
  "that request no longer waits for an answer: the turn was interrupted, the session was stopped, " +
  "or the harness moved on, so this answer was not sent; " +
  "read the session again to see whether it is waiting on a request now";

/**
 * The refusal of `input.update` and `input.cancel` on a session that answers
 * an assistant's conversation. The conversation already shows the input as
 * the owner's message. A changed text would reach the assistant as words the
 * owner never wrote there, and a cancelled one would leave the owner with no
 * reply and no notice.
 */
const CONVERSATION_INPUT_FIXED =
  "this input is the owner's message in an assistant's conversation, so it cannot be changed or cancelled; " +
  "to correct or withdraw it, send a follow-up message with conversation.send";

/**
 * The refusal of `input.update`, `input.cancel` and `input.steer` on the
 * prompt of an agent step. The workflow run waits for the turn that prompt
 * starts:
 *
 * - a changed text would run a step the workflow never defined;
 * - a cancelled prompt would leave the run waiting for a turn that never
 *   comes;
 * - a prompt steered into a running turn would end the step with that
 *   turn's answer.
 */
const STEP_INPUT_FIXED =
  "this input is the prompt of a workflow run's agent step, so it cannot be changed, cancelled or steered; " +
  "it is sent when the session starts or its current turn ends; to stop the step, cancel the run with run.cancel";

/**
 * Why a step prompt was cancelled when its run ended before a runner took
 * it: the prompt was never sent, or the runner refused it.
 */
const STEP_RUN_ENDED = "the step's run ended before a runner took this prompt";

/** Why an input was cancelled on a session that `endOnLostRunners` ended. */
const RUNNER_LOST =
  "that session's runner was not heard from for longer than the session's absolute timeout, " +
  "so the session was ended before this input was sent";

/**
 * Returns why a queued input was never sent. It is stored on the input when
 * its session exits, for a session that does not keep its input, unless the
 * input already has a reason, such as the runner's refusal (`cancelQueued`).
 */
const describeExited = (reason: string): string =>
  `that session's harness exited (${reason}) before this input was sent`;

/**
 * Returns the harness-native session id from a `session.started` event, if
 * it has one. The key is the same as `SessionBinding`'s field, because it is
 * the same value. When the event has none, the id stays null until the next
 * sessions report.
 */
const findNativeId = (event: HarnessEvent): string | undefined =>
  event._tag === "session.started" ? event.harnessRefs?.nativeSessionId : undefined;

/** The maximum length of a session title, as shown in a sidebar row. */
const MAX_TITLE_LENGTH = 80;

/**
 * Trims a title and cuts it to `MAX_TITLE_LENGTH` characters, counted by code
 * point so the cut never splits an emoji or another character outside the
 * Basic Multilingual Plane. The cut can land right after a space, so the end
 * is trimmed again: a title never ends in whitespace.
 */
const cutTitle = (title: string): string =>
  Array.from(title.trim()).slice(0, MAX_TITLE_LENGTH).join("").trimEnd();

/**
 * Cleans text a model generated: line breaks and repeated spaces become
 * single spaces, and control and format characters are removed. It does not
 * trim or cut. A model can emit zero-width or direction-changing characters,
 * which would show up as nothing in a sidebar row but break searching and
 * copying. The zero-width non-joiner and joiner (U+200C and U+200D) stay,
 * because Persian and other scripts need them to shape letters, and emoji
 * sequences need them to stay one emoji.
 */
const cleanGeneratedText = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .replace(/(?![\u200C\u200D])[\p{Cc}\p{Cf}]/gu, "")
    // Removing a character between two spaces leaves a double space.
    .replace(/ {2,}/g, " ");

/** Checks a role a model generated: the same rule as a role given at spawn. */
const isAcceptableRole = Schema.is(SessionRole);

/**
 * Builds a session's short title, trimmed and cut by `cutTitle`:
 * `chosen` when the caller chose a title, otherwise the first non-blank line
 * of the session's first prompt, otherwise the name of the prompt's first
 * image. That way a sidebar row has something to show without reading the
 * transcript.
 */
const buildTitle = (
  chosen: string | undefined,
  prompt: string,
  firstAttachmentName: string | undefined,
): string => {
  const title =
    chosen ??
    prompt.split("\n").find((line) => line.trim().length > 0) ??
    firstAttachmentName ??
    "";
  return cutTitle(title);
};

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

type InputError = ReadError | NotFound | InvalidState | Schema.SchemaError;

/**
 * Checks whether a session keeps its inputs that are still waiting when it
 * exits, so they go to the next process when it is resumed. Only a session
 * that answers an assistant's conversation keeps them, whatever the reason,
 * because they are the owner's messages. A session whose conversation was
 * deleted keeps nothing: it is history, and nobody reads its answers.
 */
const keepsInputsOnExit = (
  session: Pick<StoredSession, "conversationId" | "conversationDeleted">,
): boolean => session.conversationId !== null && !session.conversationDeleted;

/**
 * Checks whether an agent step's session keeps its waiting step prompt
 * through its last exit, so the prompt resumes the session in place.
 * `exited` is the session as read after the exit. It keeps the prompt when
 * all of these hold:
 *
 * - an agent step started the session;
 * - the exit left the harness's native state behind (`exitReason` is
 *   `idle_unload` or `runner_restart`), so the next turn continues the same
 *   transcript;
 * - the session can be resumed (`resumable`);
 * - the crash-loop guard is not armed: a session that was resumed for this
 *   prompt and exited before it started a turn would most likely fail the
 *   same way again.
 *
 * Otherwise the prompt is cancelled, and the runs domain fails the step. Any
 * other exit, such as a stop or a timeout, ends the step's session for good.
 * When the step's run ends, the run cancels the prompts it still has waiting
 * (`cancelStepPromptsOfEndedRun`), and a prompt the runner refuses after
 * that is cancelled rather than put back to waiting (`returnUndeliveredInput`). So
 * a kept prompt never resumes a session for a run that has ended.
 */
const keepsStepPromptOnExit = (
  exited: Pick<StoredSession, "runId" | "exitReason" | "resumable" | "crashGuardArmed">,
): boolean =>
  exited.runId !== null &&
  (exited.exitReason === "idle_unload" || exited.exitReason === "runner_restart") &&
  exited.resumable &&
  !exited.crashGuardArmed;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const permissionRequests = yield* permissionRequestRepository;
  const requestSubscriptions = yield* permissionRequestSubscriptions;
  const recordComposer = yield* sessionRecordComposer;
  const inputs = yield* inputRepository;
  const providerAccounts = yield* providerAccountRepository;
  const subagents = yield* subagentRepository;
  const readSession = readSessionOrFail(sessions);
  const tokens = yield* SessionTokens;
  const audit = yield* AuditLog;
  const observer = yield* SessionObserver;
  const editObserver = yield* SessionEditObserver;
  const workspaces = yield* WorkspaceService;
  const notifier = yield* Notifier;
  const accountUsage = yield* AccountUsage;
  const host = yield* PluginHost;
  // The attachment claim, the image check and the skills decision read
  // through this service's client.
  const provideSql = Effect.provideService(SqlClient.SqlClient, sql);
  // The attachment check also reads the plugin host, to tell which models a
  // harness runs from the account's Model Catalog.
  const provideAttachmentCheck = <A, E>(
    check: Effect.Effect<A, E, SqlClient.SqlClient | PluginHost>,
  ): Effect.Effect<A, E> => check.pipe(provideSql, Effect.provideService(PluginHost, host));

  /**
   * Each session's ingest state: its last sequence number and the delta text
   * held for it. This lives in memory only. After a restart the sequence is
   * read again from the rows, and no text is held. An entry is removed when
   * the session exits, whatever ends it.
   */
  const tracking = new Map<string, Tracked>();

  /**
   * Records a change to a session, to announce once the caller's transaction
   * commits. The announcement names the conversation the session answers, so
   * a client can tell which assistant's current session may have changed.
   */
  const announceSessionChange = (
    session: Pick<StoredSession, "id" | "conversationId">,
  ): Effect.Effect<void> =>
    announce({
      _tag: "record",
      topic: "session",
      id: session.id,
      conversationId: session.conversationId,
      kind: "updated",
    });

  /**
   * Reads the session `id` and checks that it is a Thread. Fails with
   * `NotFound` when there is no such session, and with `InvalidState`
   * carrying `describeRefusal(id, kind)` as its message when the session is not a
   * Thread.
   */
  const readThread = (
    id: string,
    describeRefusal: (id: string, kind: SessionKind) => string,
  ): Effect.Effect<StoredSession, NotFound | InvalidState | SqlError> =>
    Effect.flatMap(readSession(id), (session) =>
      session.kind === "thread"
        ? Effect.succeed(session)
        : Effect.fail(createInvalidStateError(describeRefusal(id, session.kind))),
    );

  /**
   * Takes the Done mark off a session, in the caller's transaction, and
   * writes the `session.reopened` audit entry, whose record announces the
   * change. Writes nothing when the session is not Done.
   *
   * `inputId` names the input that reopened it, and is left out for an
   * explicit reopen, so a reader of the audit entry can tell the two apart.
   */
  const reopenThread = (
    sessionId: string,
    actor: string,
    at: string,
    inputId: string | undefined,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (!(yield* sessions.reopen(sessionId, at))) return;
      // `reopen` changes only a Done Thread, and a Done Thread is always
      // finished, so a reopen that wrote a row made it unfinished again,
      // unless it has exited. `rejoinOverlaps` checks that itself, and the
      // resume that brings an exited Thread back runs the steps then.
      yield* editObserver.becameUnfinishedAgain(sessionId);
      yield* audit.append({
        kind: "session.reopened",
        actor,
        // Only a Thread is ever Done, and a Thread answers no conversation.
        record: { topic: "session", id: sessionId, conversationId: null },
        payload: { sessionId, ...(inputId === undefined ? {} : { inputId }) },
        at,
      });
    });

  /**
   * Writes a `runtime.warning` event stamped `at` to the session's stream, in the caller's
   * transaction, and announces the session's transcript. The write moves the
   * session's sequence offset (`sessions.appendRuntimeWarning`), so the session's
   * cached ingest state is dropped once the transaction commits, and ingest
   * reads the new offset.
   */
  const appendRuntimeWarning = (
    sessionId: string,
    message: string,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* sessions.appendRuntimeWarning(sessionId, message, at);
      yield* afterCommit(() => {
        tracking.delete(sessionId);
      });
      yield* announce({ _tag: "transcript", sessionId });
    });

  /**
   * Reads a session and records a change to it, as `announceSessionChange`
   * does, for a caller that holds only the session's id. Records nothing for
   * a session that does not exist.
   */
  const announceSessionChangeById = (id: string): Effect.Effect<void, SqlError> =>
    Effect.flatMap(
      sessions.one(id),
      Option.match({ onNone: () => Effect.void, onSome: announceSessionChange }),
    );

  /**
   * Checks that a waiting input's attachments can go to the runner and model
   * the turn would run on (`findAttachmentRefusal`). Returns `true` when they
   * cannot, after storing the refusal as the input's reason. The input stays
   * waiting and unsent, where the user sees why and can change the input or
   * the model. A later check that passes lets it be claimed as usual.
   *
   * The reason is written, and the session announced, only when it changed.
   * The check repeats on every delivery pass while the refusal lasts, and
   * each pass would otherwise rewrite the row and notify every client.
   */
  const holdInputWithRefusedAttachments = (
    input: StoredInput,
    turn: Omit<AttachmentTurn, "attachments">,
  ): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const refusal = yield* provideAttachmentCheck(
        findAttachmentRefusal({ ...turn, attachments: input.attachments }),
      );
      if (refusal === undefined) return false;
      if (input.reason !== refusal) {
        yield* inputs.requeue(input.id, null, refusal);
        yield* announceSessionChangeById(input.sessionId);
      }
      return true;
    });

  /**
   * Puts an exited session back on the queue, with the spec that resumes its
   * own transcript, when the session may be resumed now. Returns whether it
   * did. It refuses, writing nothing, when:
   *
   * - the session is no longer exited, or its transcript cannot be resumed
   *   (`resumable` on the row);
   * - no input is waiting for it, so a resumed process would have nothing to
   *   do;
   * - an input is still on the wire: the send that claimed it has not heard
   *   back yet, and it will put the input back to waiting or record it as
   *   delivered. Resuming before that would let the input be sent twice;
   * - the crash-loop guard holds the session back (`isResumeHeld`).
   *
   * `buildSpec` is given the session as read inside the transaction, and
   * runs only once the session is resumed, because building an assistant's
   * resume spec also writes the session's access. The check and
   * the write run in one transaction, joining the caller's as a savepoint
   * when there is one, so two callers racing to resume the same session
   * resume it once.
   *
   * A caller that writes more than this one change passes
   * `announceTheMove: false` and announces once for everything it wrote. A
   * caller that writes only this change passes `true`.
   */
  const resume = <E>(
    sessionId: string,
    buildSpec: (session: StoredSession) => Effect.Effect<string, E>,
    at: string,
    announceTheMove: boolean,
  ): Effect.Effect<boolean, E | SqlError | InvalidState> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const found = yield* sessions.one(sessionId);
        if (Option.isNone(found)) return false;
        const session = found.value;
        if (session.status !== "exited" || !session.resumable) return false;
        if (!session.inputWaiting) return false;
        if (yield* inputs.holdsInputOnTheWire(sessionId)) return false;
        if (isResumeHeld(session)) return false;
        // Checked here, in the transaction that queues the session, and not
        // before it: an account deleted in between would leave a queued
        // session that dispatch can never prepare. The account delete runs
        // in a transaction too, so one of the two sees the other.
        if (Option.isNone(yield* providerAccounts.one(session.providerAccountId))) {
          return yield* Effect.fail(createInvalidStateError(ACCOUNT_DELETED));
        }
        // Whether a resume makes the session unfinished again depends on its
        // kind (a step's session by its Run, a Done Thread not at all). So
        // the one rule for "unfinished" is asked before and after the change.
        const wasUnfinished = yield* sessions.isUnfinished(sessionId);
        yield* sessions.resume(sessionId, yield* buildSpec(session));
        if (!wasUnfinished && (yield* sessions.isUnfinished(sessionId))) {
          yield* editObserver.becameUnfinishedAgain(sessionId);
        }
        if (session.workspaceId !== null) {
          yield* workspaces.acquire({ kind: "session", id: sessionId }, session.workspaceId, at);
        }
        // Armed until the resumed process starts a turn or new input is
        // stored. If it exits before either, it is not resumed again for the
        // same input (`isResumeHeld`).
        yield* sessions.setCrashGuardArmed(sessionId, true);
        // The resumed process numbers its events from zero again, so the held
        // ingest state no longer applies. It is dropped once the resume is
        // committed, like any other cache invalidation.
        yield* afterCommit(() => {
          tracking.delete(sessionId);
        });
        if (announceTheMove) {
          yield* announceSessionChange(session);
        }
        return true;
      }),
    );

  /**
   * Returns an input that a caller can still edit, cancel or steer. Fails when:
   *
   * - the session has no input with that id (`NotFound`);
   * - the input was already delivered or cancelled (`InvalidState`);
   * - the input was already sent to the runner (`InvalidState`). The runner
   *   already has its text and it cannot be taken back, so reporting it as
   *   edited or cancelled would be wrong;
   * - the input is the prompt of an agent step (`InvalidState`).
   */
  const queuedInput = (
    sessionId: string,
    inputId: string,
  ): Effect.Effect<StoredInput, NotFound | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const found = yield* inputs.one(sessionId, inputId);
      if (Option.isNone(found)) return yield* Effect.fail(createNotFoundError(NO_SUCH_INPUT));
      if (found.value.status !== "queued") {
        return yield* Effect.fail(
          createInvalidStateError(`that input was already ${found.value.status}`),
        );
      }
      if (found.value.sentAt !== null)
        return yield* Effect.fail(createInvalidStateError(ALREADY_SENT));
      if (found.value.stepIteration !== null)
        return yield* Effect.fail(createInvalidStateError(STEP_INPUT_FIXED));
      return found.value;
    });

  /**
   * Checks that the queued inputs of a session may be changed or cancelled.
   * Fails with `NotFound` when there is no such session, and with
   * `InvalidState` when the session answers an assistant's conversation:
   * input to an assistant goes only through `conversation.send`, and the
   * conversation keeps what was sent.
   */
  const requireChangeableInputs = (
    sessionId: string,
  ): Effect.Effect<void, NotFound | InvalidState | SqlError> =>
    Effect.flatMap(readSession(sessionId), (session) =>
      session.conversationId === null
        ? Effect.void
        : Effect.fail(createInvalidStateError(CONVERSATION_INPUT_FIXED)),
    );

  /**
   * Announces each session that moved to `exited` and forgets its token and
   * ingest state, without touching its inputs. Part of `endSessions`.
   */
  const forgetSessions = (ended: ReadonlyArray<StoredSession>): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.forEach(ended, announceSessionChange, { discard: true });
      const ids = ended.map((session) => session.id);
      // From now on the row's status is what makes the token invalid. This
      // only drops what was cached from the token while the session ran. It
      // runs after the commit, so a call in flight cannot cache the old row
      // again between the drop and the write becoming visible.
      yield* afterCommit(() => {
        tokens.forgetSessions(ids);
        for (const id of ids) tracking.delete(id);
      });
    });

  /**
   * Withdraws the approval notifications about some of a session's open
   * Requests. A Request already answered through the controller has its
   * notification resolved, and a `question` never raised one, so for those
   * this does nothing.
   */
  const withdrawRequestNotifications = (
    sessionId: string,
    requests: ReadonlyArray<SessionRequest>,
    reason: string,
  ): Effect.Effect<void, SqlError> =>
    requests.length === 0
      ? Effect.void
      : notifier.withdrawDecisionsAbout(
          requests.map((request) => buildRequestSubject(sessionId, request.requestId)),
          reason,
        );

  /**
   * Stores the Requests a session waits on after one reported event, and
   * keeps the approval notifications in step with them, in the caller's
   * transaction:
   *
   * - the notification about each Request the event closed is withdrawn,
   *   with the reason that names the event;
   * - each approval Request the event opened raises a notification. When a
   *   subagent asked it, the notification names the subagent by its
   *   description, else its agent type, as the session record does. Both are
   *   read from `askers`, which holds the subagents the event names.
   *
   * `session` is the row as it was before the event, and `after` is the list
   * `computeOpenRequestsAfter` returned for it.
   */
  const replaceOpenRequests = (
    session: StoredSession,
    after: ReadonlyArray<SessionRequest>,
    event: RequestEvent,
    askers: ReadonlyMap<SubagentId, StoredSubagent>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* sessions.setOpenRequests(session.id, after);
      const { closed, opened } = compareOpenRequests(session.openRequests, after);
      // A new Request never closes an older one, so only the other events
      // can have closed any.
      if (closed.length > 0 && event._tag !== "request.opened") {
        yield* withdrawRequestNotifications(session.id, closed, buildWithdrawReason(event));
      }
      for (const request of opened) {
        const asker = request.subagentId === undefined ? undefined : askers.get(request.subagentId);
        const notification = buildApprovalNotification(
          session,
          request,
          asker?.description ?? asker?.agentType,
        );
        if (notification !== undefined) yield* notifier.createCoreNotification(notification);
      }
    });

  /**
   * Applies one reported event to the subagent records it changes, and
   * writes back each one it changed. Returns the subagents the event names,
   * by id, as they are after the event: the asker of a Request the event
   * opens is among them.
   *
   * Reads only what the event can change (`findSubagentsToRead`): nothing
   * for the many events of the session's own agent, the named records for a
   * subagent's events, and every record only for `session.started`. A
   * session's exit is handled by `endSessions`, like every other end.
   *
   * A visible change is announced on the `subagent` topic by its session's
   * id. Clearing the process's share of Token Usage is not announced,
   * because the API does not show it. When a subagent that asked one of the
   * session's open Requests gains a `description` or an `agentType`, the
   * session is announced too: each such Request carries the subagent's
   * name, so a client that reads only sessions shows the new name.
   */
  const applySubagentEvent = (
    session: StoredSession,
    event: HarnessEvent,
  ): Effect.Effect<ReadonlyMap<SubagentId, StoredSubagent>, SqlError> =>
    Effect.gen(function* () {
      const sessionId = session.id;
      const toRead = findSubagentsToRead(event);
      if (toRead !== "all" && toRead.length === 0) return new Map();
      const read =
        toRead === "all"
          ? yield* subagents.listAll(sessionId)
          : yield* subagents.listByIds(sessionId, toRead);
      const records = new Map(read.map((record) => [record.id, record]));
      const changed = computeSubagentsAfter(
        sessionId,
        event,
        records,
        yield* readSubagentEventFacts(sessionId, event, records),
      );
      let askerRenamed = false;
      for (const record of changed) {
        const before = records.get(record.id);
        askerRenamed ||=
          (before === undefined ||
            before.description !== record.description ||
            before.agentType !== record.agentType) &&
          session.openRequests.some((request) => request.subagentId === record.id);
        yield* subagents.save(record);
        records.set(record.id, record);
      }
      if (changed.length > 0 && event._tag !== "session.started") {
        yield* announce({ _tag: "record", topic: "subagent", id: sessionId, kind: "updated" });
      }
      if (askerRenamed) yield* announceSessionChange(session);
      return records;
    });

  /**
   * Reads from the transcript what an event of a subagent does not carry
   * itself, and only when the event needs it:
   *
   * - for a `turn.completed`, the turn's last assistant text, the result;
   * - for a `user_message` while the description is empty, whether the
   *   message belongs to the subagent's first turn, whose input is the brief.
   */
  const readSubagentEventFacts = (
    sessionId: string,
    event: HarnessEvent,
    records: ReadonlyMap<SubagentId, StoredSubagent>,
  ): Effect.Effect<SubagentEventFacts, SqlError> =>
    Effect.gen(function* () {
      if (event._tag === "turn.completed" && event.subagentId !== undefined) {
        return {
          lastAssistantText: yield* readLastAssistantText(
            sessionId,
            event.subagentId,
            event.turnId,
          ),
        };
      }
      if (
        event._tag === "item.started" &&
        event.kind === "user_message" &&
        event.subagentId !== undefined &&
        records.get(event.subagentId)?.description === undefined
      ) {
        const later = yield* hasOtherTurn(sql, {
          sessionId,
          subagentId: event.subagentId,
          turnId: event.turnId,
        });
        return { inFirstTurn: !later };
      }
      return {};
    });

  /**
   * Applies one event to the session's own Token Usage, and returns whether
   * the stored usage changed:
   *
   * - `session.started` starts a new process, which counts from zero, so the
   *   process's share is cleared. The total does not change.
   * - `session.usage.updated` from the session's own agent replaces the
   *   process's share of the total. A subagent's snapshot feeds only that
   *   subagent's record (`computeSubagentsAfter`).
   */
  const applySessionUsage = (
    session: StoredSession,
    event: HarnessEvent,
  ): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      if (event._tag === "session.started") {
        if (session.usageProcess !== undefined) {
          yield* sessions.setUsage(session.id, clearProcessShare(session));
        }
        return false;
      }
      if (event._tag !== "session.usage.updated" || event.subagentId !== undefined) return false;
      yield* sessions.setUsage(
        session.id,
        addUsageReport(
          session,
          event.usage === undefined
            ? event.usageReport
            : { status: "complete", counts: event.usage },
        ),
      );
      return true;
    });

  /**
   * Stops every running subagent of a session that ended, at `at`. This is
   * the one place that does so: `endSessions` calls it for every way a
   * session ends, an exit the harness reported included.
   *
   * Each subagent's `result` becomes the first line of the last assistant
   * message in the turn the end cut off, read from the transcript.
   *
   * - For an exit the harness reported, the text still held back in the
   *   ingest buffers was flushed as rows by the same report, and those rows
   *   were written before this runs, in the same transaction.
   * - For any other end, such as a lost runner or a stop, nothing is flushed,
   *   so only the text already written counts.
   */
  const stopRunningSubagents = (sessionId: string, at: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const running = yield* subagents.listRunning(sessionId);
      for (const record of running) {
        const turnId = yield* readOpenTurnId(sql, sessionId, record.id);
        const lastAssistantText =
          turnId === undefined
            ? undefined
            : yield* readLastAssistantText(sessionId, record.id, turnId);
        yield* subagents.save(stopSubagent(record, at, lastAssistantText));
      }
      if (running.length > 0) {
        yield* announce({ _tag: "record", topic: "subagent", id: sessionId, kind: "updated" });
      }
    });

  /**
   * Returns the text of the last assistant message in one turn of a
   * subagent, or `undefined` when the turn wrote none. It becomes the
   * subagent's `result`.
   */
  const readLastAssistantText = (
    sessionId: string,
    subagentId: SubagentId,
    turnId: string,
  ): Effect.Effect<string | undefined, SqlError> =>
    Effect.map(
      readAssistantTexts(sql, { sessionId, subagentId, turnId }),
      (texts) => texts.at(-1)?.text,
    );

  /**
   * Fails with `NotFound` when the session has no subagent with this id.
   * Callers read the session first, so a missing session fails before this.
   */
  const requireSubagent = (
    sessionId: string,
    subagentId: SubagentId,
  ): Effect.Effect<StoredSubagent, NotFound | SqlError> =>
    Effect.flatMap(subagents.one(sessionId, subagentId), (found) =>
      Option.isNone(found)
        ? Effect.fail(createNotFoundError(NO_SUCH_SUBAGENT))
        : Effect.succeed(found.value),
    );

  /**
   * Does the cleanup after sessions move to `exited`, whatever ended them.
   * Every path that ends a session calls this, in the transaction that ended
   * it. For each session, it:
   *
   * - stores `reason` on the row, where `keepsStepPromptOnExit` reads it;
   * - cancels its inputs not yet sent, storing `cancelReason` on them when
   *   one is given, unless the session keeps them (`keepsInputsOnExit`,
   *   `keepsStepPromptOnExit`). `earlierReason` decides whether a reason an
   *   input already has is replaced (`EarlierReason`);
   * - releases its lease on its workspace: `idle` when it can be resumed,
   *   so a thread the user may come back to keeps its files for the long
   *   window, and `orphan` when it cannot;
   * - withdraws the approval notifications about the Requests it was
   *   waiting on;
   * - withdraws its open Permission Requests, their notifications and the
   *   subscriptions waiting on their decisions, with one query each for all
   *   the ended sessions together;
   * - stops its running subagents;
   * - tells `SessionObserver` that the session exited, whether the
   *   crash-loop guard now holds it back from a resume, and which agent
   *   step prompts it cancelled before any runner saw them;
   * - forgets its token and ingest state, and announces it once.
   *
   * `ended` holds the rows as they were just before the end.
   */
  const endSessions = (
    ended: ReadonlyArray<StoredSession>,
    reason: SessionEndReason,
    cancelReason?: string,
    earlierReason?: EarlierReason,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      for (const session of ended) {
        yield* sessions.setExitReason(session.id, reason);
        // Read again after the exit: whether the session can be resumed is
        // computed only for an exited row.
        const after = yield* sessions.one(session.id);
        const keeps =
          Option.isSome(after) &&
          (keepsInputsOnExit(after.value) || keepsStepPromptOnExit(after.value));
        const cancelled = keeps
          ? undefined
          : yield* inputs.cancelQueued(session.id, cancelReason, earlierReason);
        // For an exit the harness reported, `applyReport` has already
        // withdrawn the notifications, so this call finds them resolved and
        // does nothing. For every other end, they are withdrawn here.
        yield* withdrawRequestNotifications(
          session.id,
          session.openRequests,
          WITHDRAW_REASON_SESSION_ENDED,
        );
        yield* stopRunningSubagents(
          session.id,
          Option.isSome(after) && after.value.exitedAt !== null
            ? after.value.exitedAt
            : yield* nowIso,
        );
        if (session.workspaceId !== null && Option.isSome(after)) {
          yield* workspaces.release(
            { kind: "session", id: session.id },
            after.value.resumable ? "idle" : "orphan",
            after.value.exitedAt ?? (yield* nowIso),
          );
        }
        // A session whose inputs were cancelled has nothing waiting, so the
        // guard cannot hold it.
        yield* observer.sessionExited({
          session,
          reason,
          resumeHeld: keeps && isResumeHeld(after.value),
          droppedStepIterations: cancelled?.stepIterations ?? [],
        });
      }
      // No decision can reach an ended session, so its open requests are
      // withdrawn rather than left for the user to answer.
      const endedIds = ended.map((session) => session.id);
      const withdrawn = yield* permissionRequests.withdrawOpen(endedIds);
      if (withdrawn.length > 0) {
        yield* notifier.withdrawDecisionsAbout(
          withdrawn.map(buildPermissionRequestSubject),
          WITHDRAW_REASON_SESSION_ENDED,
        );
        yield* requestSubscriptions.endWithdrawn(endedIds, withdrawn);
      }
      yield* forgetSessions(ended);
    });

  /**
   * Ends a queued session whose start can never be sent, such as one whose
   * Provider Account is gone, and stores `message` as a `session.exited` row
   * on its stream, where the user reads why. Does nothing when the session is
   * no longer queued. Joins the caller's transaction.
   *
   * The exit reason is `crash`, which spec 06 section 4.1 gives to a failed
   * start (`session.exited` with reason `crash`). No process ever ran here,
   * but the start failed before it could be sent, and it was not a person's
   * stop. The protocol has no more specific reason, and adding one would
   * change the wire format for the same outcome.
   */
  const endUnstartable = (
    sessionId: string,
    message: string,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const ended = yield* sessions.endQueued(sessionId, at);
      if (Option.isNone(ended)) return;
      yield* sessions.append(sessionId, {
        seq: 0,
        at,
        event: {
          _tag: "session.exited",
          eventId: crypto.randomUUID(),
          sessionId,
          at,
          reason: "crash",
          message,
        },
      });
      yield* audit.append({
        kind: "session.stopped",
        actor: SYSTEM_ACTOR,
        payload: { sessionId, reason: "crash", message },
        at,
      });
      yield* announce({ _tag: "transcript", sessionId });
      yield* endSessions([ended.value], "crash", message);
    });

  /**
   * Ends every session waiting on a workspace that could not be created. The
   * sessions never started, so there is no harness to stop and nothing to send
   * to the runner. The user needs the reason, so the runner's error message is
   * stored as a `session.exited` row on each session's stream, where the exit
   * is shown.
   */
  const endForWorkspace = (
    workspaceId: string,
    message: string | null,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        const ended = yield* sessions.endInWorkspace(workspaceId, at);
        for (const { id } of ended) {
          yield* sessions.append(id, {
            seq: 0,
            at,
            event: {
              _tag: "session.exited",
              eventId: crypto.randomUUID(),
              sessionId: id,
              at,
              reason: "workspace_failed",
              ...(message === null ? {} : { message }),
            },
          });
          yield* audit.append({
            kind: "session.stopped",
            actor: SYSTEM_ACTOR,
            payload: { sessionId: id, workspaceId, reason: "workspace_failed" },
            at,
          });
          // The exit is a row on this session's stream, so clients watching
          // the session's transcript must be notified.
          yield* announce({ _tag: "transcript", sessionId: id });
        }
        yield* endSessions(ended, "workspace_failed", message ?? undefined);
      }),
    );

  /**
   * Moves an `idle` or `starting` session to `busy`, because an input the
   * runner received opened a turn. Leaves the session alone when it is in
   * any other status, or when another runner holds it now. Runs inside the
   * caller's transaction.
   *
   * A `starting` session moves too, because the input its start carried can
   * open a turn before the controller folds the runner's `session.started`:
   * the answer to the input is read as soon as it arrives, while
   * `session.started` waits in the ingest queue behind every other session's
   * events.
   *
   * From that answer until the turn ends, a turn is running, even before the
   * runner reports `turn.started`. So an exit in between is an exit during a
   * turn, and the owner is told.
   */
  const openTurn = (runnerId: string, sessionId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const found = yield* sessions.one(sessionId);
      if (Option.isNone(found)) return;
      const session = found.value;
      if (session.runnerId !== runnerId) return;
      if (session.status !== "idle" && session.status !== "starting") return;
      yield* sessions.moved(session.id, "busy", yield* nowIso);
      // A turn opened, so the process did work: the crash-loop guard no
      // longer applies to it, as when `turn.started` moves it to `busy`.
      yield* sessions.setCrashGuardArmed(session.id, false);
    });

  /**
   * Records the delivery the runner reported for an input it received, as
   * the send that waited for the answer. Part of `recordInputAnswer`. The row
   * changes only while it still holds this send's claim (`row.sentAt`).
   *
   * An input that opened a turn also moves the session held by `runnerId` to
   * `busy` (`openTurn`), in the same transaction. The same answer reaches
   * `applyInputResult` on another fiber, and it can get there later. If only
   * that method moved the session, the session would for a moment read
   * `idle` with no input sent and unanswered, and the next delivery pass
   * would send a second input into the turn that just opened.
   */
  const recordDelivery = (
    row: StoredInput,
    delivery: Delivery,
    runnerId: string,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const recorded = yield* inputs.markDelivered(row.id, row.sentAt, delivery, yield* nowIso);
        // Only the first to record the answer moves the session. When
        // `applyInputResult` recorded it already, the turn may have ended
        // since, and moving the session now would leave it `busy` for good.
        if (recorded && delivery === "opened") yield* openTurn(runnerId, row.sessionId);
        yield* announceSessionChangeById(row.sessionId);
      }),
    );

  /**
   * Cancels an input with `reason` that cannot be sent again, and tells
   * `SessionObserver`: the step fails when the input is an agent step's
   * prompt, and the conversation gets a notice when the session answers one.
   * Part of `returnUndeliveredInput` and `failUndeliveredInput`. The row
   * changes only while it still holds this send's claim (`row.sentAt`), and
   * `SessionObserver` is told only when it changed: a concurrent path may
   * have settled the input already (ordered ingestion marked it delivered, or
   * the conversation's abandonment cancelled it), and a second notice or step
   * failure for it would be false.
   */
  const cancelUndeliveredInput = (
    row: StoredInput,
    session: StoredSession,
    reason: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (!(yield* inputs.cancelWithReason(row.id, row.sentAt, reason))) return;
      yield* observer.inputsDropped({
        session,
        refusal: reason,
        droppedStepIterations: row.stepIteration === null ? [] : [row.stepIteration],
      });
    });

  /**
   * Puts an input the runner did not take back to waiting with `reason`, so
   * the next send of the session's input tries again. Part of
   * `recordInputAnswer`. Returns `true` when this call put the input back to
   * waiting. Returns `false` when the input was cancelled instead (three
   * cases below), or when a concurrent path had already settled it (marked it
   * delivered, or cancelled it), so the row did not change. The three cases:
   *
   * - The input is an agent step's prompt and the step's run has ended. The
   *   run's end cancelled the step's prompts still waiting
   *   (`cancelStepPromptsOfEndedRun`), but not this one, because it was on
   *   the wire. Put back to waiting, it could resume the session for a turn
   *   the run no longer wants. It is cancelled with `STEP_RUN_ENDED`, and
   *   `SessionObserver` is not told, because the run's end already settled
   *   the step.
   * - The session exited in the meantime and does not keep its input
   *   through that exit. The rule is the same as for the inputs not yet sent
   *   when the session exited (`keepsInputsOnExit`, `keepsStepPromptOnExit`).
   *   `SessionObserver` is told (`cancelUndeliveredInput`).
   * - The input is a Discussion Input. It is always cancelled with `reason`,
   *   never put back to waiting: the session is told again at the end of its
   *   next turn.
   *
   * The session and its run are read inside this transaction, so the checks
   * cannot race the write that exits the session or ends the run. A step
   * prompt that goes back to waiting on an exited session resumes it, like
   * any kept input: the next delivery pass does that.
   *
   * The caller must know the runner did not run the input: the runner
   * refused it, the frame never left the controller, or the input is an
   * ordinary one the runner never answered. A step prompt the runner never
   * answered never comes here, because the runner may have run it.
   */
  const returnUndeliveredInput = (
    row: StoredInput,
    reason: string,
  ): Effect.Effect<boolean, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const now = yield* sessions.one(row.sessionId);
        const dropped =
          Option.isSome(now) &&
          now.value.status === "exited" &&
          !keepsInputsOnExit(now.value) &&
          !keepsStepPromptOnExit(now.value);
        let waiting = false;
        if (row.source === "discussion") {
          // Nothing was marked told for a Discussion Input that was not
          // delivered, so the next turn's end writes a new one with whatever
          // is still untold. Put back to waiting, this one could be sent later
          // with a text that is out of date.
          yield* inputs.cancelWithReason(row.id, row.sentAt, reason);
        } else if (
          row.stepIteration !== null &&
          (yield* sessions.belongsToEndedRun(row.sessionId))
        ) {
          yield* inputs.cancelWithReason(row.id, row.sentAt, STEP_RUN_ENDED);
        } else if (dropped) {
          yield* cancelUndeliveredInput(row, now.value, reason);
        } else {
          waiting = yield* inputs.requeue(row.id, row.sentAt, reason);
        }
        yield* announceSessionChangeById(row.sessionId);
        return waiting;
      }),
    );

  /**
   * Cancels an input the runner failed, with `reason`, instead of putting it
   * back to waiting. Part of `recordInputAnswer`, for a failure that sending
   * the input again would not mend.
   * `SessionObserver` is told (`cancelUndeliveredInput`): an agent step's
   * prompt fails its step, and a conversation gets a notice with `reason`.
   * Without it, the owner's message would vanish unexplained.
   *
   * Only this input is cancelled. The session's other waiting inputs stay, and
   * the session's end, if the failure brings one, comes from the runner's
   * exit. As in `returnUndeliveredInput`, `SessionObserver` is not told in two
   * cases. A Discussion Input is cancelled with `reason`, because the
   * controller wrote it and nobody sent it. A prompt whose step's run has
   * ended is cancelled with `STEP_RUN_ENDED`, because the run's end already
   * settled the step.
   */
  const failUndeliveredInput = (row: StoredInput, reason: string): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        if (row.source === "discussion") {
          yield* inputs.cancelWithReason(row.id, row.sentAt, reason);
        } else if (
          row.stepIteration !== null &&
          (yield* sessions.belongsToEndedRun(row.sessionId))
        ) {
          yield* inputs.cancelWithReason(row.id, row.sentAt, STEP_RUN_ENDED);
        } else {
          const session = Option.getOrThrow(yield* sessions.one(row.sessionId));
          yield* cancelUndeliveredInput(row, session, reason);
        }
        yield* announceSessionChangeById(row.sessionId);
      }),
    );

  /**
   * The queued sessions dispatch skipped for having no input, and has logged
   * a warning about. Each is logged once per controller run, not on every
   * dispatch pass. A session is added only when the pass that logged it
   * commits, so a pass that rolls back logs it again on the next pass.
   */
  const warnedInputlessSessions = new Set<string>();

  /**
   * Moves a resumed session that is still `queued` back to the exit it was
   * resumed from, and returns whether it did. Dispatch calls this for a
   * queued session with no waiting input, which a resumed process would have
   * nothing to do with. Returns `false`, changing nothing, for a session that
   * never exited.
   *
   * The row goes back as `sessions.undoResume` describes. The workspace lease
   * is released again from the original exit time, as `endSessions` releases
   * it, so the workspace is kept for the same window as before the resume.
   * Nothing exited, so `SessionObserver` is not told and no exit is written
   * to the stream. Joins the caller's transaction.
   */
  const undoResume = (sessionId: string): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      if (!(yield* sessions.undoResume(sessionId))) return false;
      // Read after the undo: `resumable` holds only for an exited session.
      const after = yield* sessions.one(sessionId);
      if (Option.isSome(after) && after.value.workspaceId !== null) {
        yield* workspaces.release(
          { kind: "session", id: sessionId },
          after.value.resumable ? "idle" : "orphan",
          after.value.exitedAt ?? (yield* nowIso),
        );
      }
      yield* announceSessionChangeById(sessionId);
      return true;
    });

  return {
    query: (input: QueryInput): Effect.Effect<SessionPage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.query");
        const {
          limit,
          cursor,
          sort,
          status,
          runnerId,
          agentId,
          permissionProfileId,
          conversationId,
          runId,
          kind,
          done,
          activeSince,
          doneSince,
        } = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        const kinds = kind === undefined ? undefined : [kind].flat();
        // A Thread is a session with no Agent behind it. `agentId` filters for
        // the sessions of one Agent, so it can match none of the sessions in a
        // query for Threads alone. Such a query would return an empty page,
        // which looks like "there are none" instead of "the query is wrong".
        if (agentId !== undefined && kinds?.every((each) => each === "thread")) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["kind"],
                message:
                  "a Thread is a session with no agent, so a query cannot ask for both: " +
                  "send agentId to list one agent's sessions, or kind=thread to list the " +
                  "sessions that have no agent",
              },
            ]),
          );
        }
        // Only a Thread is ever Done. Every other filter below matches only
        // sessions spawned from an Agent: a run's agent steps and an
        // assistant's conversation both run as Agents. Asking for the Done
        // sessions among them can never match anything.
        if (
          done === true &&
          (agentId !== undefined ||
            kinds?.every((each) => each !== "thread") ||
            runId !== undefined ||
            conversationId !== undefined)
        ) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["done"],
                message:
                  "only a Thread can be Done, and agentId, runId, conversationId and " +
                  "a kind without thread match only sessions spawned from an Agent: drop " +
                  "those filters, or drop done",
              },
            ]),
          );
        }
        const listing = yield* refuseCursor(
          sessions.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
            status,
            runnerId,
            agentId,
            permissionProfileId,
            conversationId,
            runId,
            kind,
            done,
            activeSince,
            doneSince,
          }),
        );
        const composeRecord = yield* recordComposer;
        return toPageOutput({ ...listing, items: listing.items.map(composeRecord) });
      }),

    /**
     * Reads and decodes the spec that was sent to the runner for one session.
     * Fails with `NotFound` when there is no such session. A session that
     * continues this session's transcript runs under this spec. It is read
     * back rather than built again, so the continuation runs under exactly
     * what the parent ran under, including fields nothing else reads.
     *
     * It checks no grant. The caller is the controller daemon, which runs a
     * resume or a fork, and the operation behind it already checked its grant.
     */
    readSpec: (
      sessionId: string,
    ): Effect.Effect<SessionSpec, NotFound | SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const document = yield* sessions.readSpecDocument(sessionId);
        if (Option.isNone(document))
          return yield* Effect.fail(createNotFoundError("no such session"));
        return yield* decodeSpecDocument(document.value);
      }),

    read: (id: Id): Effect.Effect<Session, Exclude<ReadError | NotFound, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("session.read");
        return (yield* recordComposer)(yield* readSession(id));
      }),

    /**
     * Marks Threads Done, stamped with the caller, all at one time, and
     * returns the Threads in the order given. A Thread that is already Done is
     * returned as it is, and nothing is written for it. Marking changes only
     * how a Thread is filed: a running Thread keeps running.
     *
     * The list is applied all or nothing, in one transaction: when one id
     * fails, no Thread is marked.
     *
     * Fails with `NotFound` when an id is not a session, and with
     * `InvalidState` when a session is not a Thread.
     */
    markDone: (
      input: SessionIdsInput,
    ): Effect.Effect<
      ReadonlyArray<Session>,
      Exclude<ReadError | NotFound | InvalidState, Validation>
    > =>
      Effect.gen(function* () {
        yield* requireGrant("session.markDone");
        const actor = yield* currentStamp;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            for (const id of input.sessionIds) {
              const session = yield* readThread(id, describeMarkDoneRefusal);
              if (yield* sessions.markDone(id, actor, at)) {
                yield* audit.append({
                  kind: "session.markedDone",
                  actor,
                  record: { topic: "session", id, conversationId: session.conversationId },
                  payload: { sessionId: id },
                  at,
                });
              }
            }
            const composeRecord = yield* recordComposer;
            return yield* Effect.forEach(input.sessionIds, (id) =>
              Effect.map(readSession(id), composeRecord),
            );
          }),
        );
      }),

    /**
     * Takes the Done mark off Threads, as the caller, all at one time, and
     * returns the Threads in the order given. A Thread that is not Done is
     * returned as it is, and nothing is written for it, so its `reopenedAt`
     * does not move.
     *
     * The list is applied all or nothing, in one transaction: when one id
     * fails, no Thread is reopened.
     *
     * Fails with `NotFound` when an id is not a session, and with
     * `InvalidState` when a session is not a Thread.
     */
    reopen: (
      input: SessionIdsInput,
    ): Effect.Effect<
      ReadonlyArray<Session>,
      Exclude<ReadError | NotFound | InvalidState, Validation>
    > =>
      Effect.gen(function* () {
        yield* requireGrant("session.reopen");
        const actor = yield* currentStamp;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            for (const id of input.sessionIds) {
              yield* readThread(id, describeReopenRefusal);
              yield* reopenThread(id, actor, at, undefined);
            }
            const composeRecord = yield* recordComposer;
            return yield* Effect.forEach(input.sessionIds, (id) =>
              Effect.map(readSession(id), composeRecord),
            );
          }),
        );
      }),

    /**
     * Returns a page of one agent's normalized stream, in position order
     * (spec 11 section 2). Without `subagentId` it is the session's own
     * agent's, and with it that subagent's. Reads the session, and the
     * subagent when one is named, first: so a new session with no rows yet
     * returns an empty page, and a missing session or subagent fails with
     * `NotFound`. With `after`, only the rows past that position are read;
     * a position beyond the newest row returns an empty page. A cursor from
     * one agent's transcript, or from a listing with another `after`, is
     * refused.
     */
    transcript: (input: TranscriptInput): Effect.Effect<TranscriptPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("transcript.read");
        const { id, subagentId, after, limit, cursor, sort } = yield* Effect.mapError(
          decodeTranscript(input),
          createDecodeValidationError,
        );
        yield* readSession(id);
        if (subagentId !== undefined) yield* requireSubagent(id, subagentId);
        const listing = yield* refuseCursor(
          sessions.transcript({
            sessionId: id,
            subagentId,
            after,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, TRANSCRIPT_DIRECTION),
          }),
        );
        return toPageOutput(listing);
      }),

    /**
     * Returns a page of the messages that match a full-text search over every
     * session's transcript, newest first by default (spec 11 section 2). Each
     * filter narrows the search; `agentId: "me"` and `actor: "me"` are
     * resolved from the calling session and fail with `Validation` for any
     * other caller. Text with no word in it matches nothing, so it returns an
     * empty page.
     */
    queryPassages: (input: PassageQueryInput): Effect.Effect<PassagePage, ReadError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("transcript.query");
        // The `actor` filter is renamed because `actor` already names the caller.
        const {
          text,
          sessionId,
          agentId,
          since,
          until,
          limit,
          cursor,
          sort,
          actor: actorFilter,
        } = yield* Effect.mapError(decodePassageQuery(input), createDecodeValidationError);
        const resolvedAgentId =
          agentId === OWN_AGENT_ALIAS ? yield* resolveOwnAgent(actor) : agentId;
        const createdBy = actorFilter === undefined ? undefined : yield* resolveOwnStamp(actor);
        const match = buildMatchExpression(text);
        if (match === undefined) return { items: [] };
        const listing = yield* refuseCursor(
          sessions.queryPassages({
            match,
            sessionId,
            agentId: resolvedAgentId,
            createdBy,
            since,
            until,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, PASSAGE_DIRECTION),
          }),
        );
        return toPageOutput(listing);
      }),

    /**
     * Returns a page of the session's subagents, oldest first by `startedAt`.
     * A subagent is read through its session, so the grant is `session.read`.
     * Fails with `NotFound` when there is no such session.
     */
    querySubagents: (
      input: SubagentQueryInput,
    ): Effect.Effect<SubagentPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("session.read");
        const { id, limit, cursor, sort } = yield* Effect.mapError(
          decodeSubagentQuery(input),
          createDecodeValidationError,
        );
        yield* readSession(id);
        const listing = yield* refuseCursor(
          subagents.list({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, SUBAGENT_DIRECTION),
          }),
        );
        return toPageOutput({ ...listing, items: listing.items.map(toSubagentRecord) });
      }),

    /**
     * Fails with `NotFound` when the session has no subagent with this id.
     * The controller daemon calls it before it interrupts a subagent, so an
     * id the controller never heard of is refused instead of sent on.
     */
    requireSubagent: (
      sessionId: string,
      subagentId: SubagentId,
    ): Effect.Effect<void, NotFound | SqlError> =>
      Effect.asVoid(requireSubagent(sessionId, subagentId)),

    /**
     * Returns the subagents a resumed session's harness is told about, so
     * the adapter puts a subagent it continues back on the record the
     * controller already has. Each entry names the subagent that started
     * it, so the adapter knows the tree a stop cascades down. Each saved
     * harness usage report goes back unchanged, so the adapter can restore
     * native counters without reading the transcript. Checks no grant: the
     * controller daemon calls it while it builds a resume spec.
     */
    listSubagentsToContinue: (
      sessionId: string,
    ): Effect.Effect<ReadonlyArray<ContinuedSubagent>, SqlError> =>
      Effect.map(subagents.listAll(sessionId), (records) =>
        records.map((record) => ({
          subagentId: record.id,
          ...(record.itemId === undefined ? {} : { itemId: record.itemId }),
          ...(record.lastUsageReport === undefined
            ? {}
            : { lastUsageReport: record.lastUsageReport }),
          ...(record.parentSubagentId === undefined
            ? {}
            : { parentSubagentId: record.parentSubagentId }),
        })),
      ),

    /**
     * Stores a new session, its first input and the audit entry for it,
     * joining the caller's transaction. This is the only place a session
     * decided by the controller daemon is written. The session is always
     * stored as `queued`: whether the runner has room for it right now is
     * decided by dispatch, the same way for a new session as for any other.
     *
     * Fails with `Validation` when an image is gone or was uploaded by
     * someone else, or when the session's runner or model cannot take images
     * (`refuseUnacceptedAttachments`).
     */
    create: (open: CreateRequest): Effect.Effect<void, Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* currentStamp;
        const references = yield* provideSql(readClaimableAttachments(open.attachments));
        yield* provideAttachmentCheck(
          refuseUnacceptedAttachments({
            runnerId: open.runnerId,
            providerAccountId: open.spec.providerAccountId,
            harnessId: open.harnessId,
            model: open.spec.modelSelection.model,
            attachments: references,
          }),
        );
        yield* sessions.insert({
          id: open.id,
          title: buildTitle(open.title, open.prompt, references[0]?.name),
          role: open.role,
          permissionProfileId: open.permissionProfileId,
          agentId: open.agentId,
          conversationId: open.conversationId,
          step: open.step,
          providerAccountId: open.spec.providerAccountId,
          harnessId: open.harnessId,
          runnerId: open.runnerId,
          workspaceId: open.spec.workspaceId,
          projectId: open.projectId,
          checkoutBranch: open.checkoutBranch,
          githubConnectionId: open.githubConnectionId,
          requestedAccessMode: open.requestedAccessMode,
          accessMode: open.spec.accessMode,
          // The row stores exactly the spec the runner receives, byte for
          // byte, not a re-encoding of a similar object. The one exception is
          // the coordination paragraph, which `claimStarts` adds to the frame
          // at every start and which no stored spec carries.
          spec: JSON.stringify(encodeSpec(open.spec)),
          modelSelection: open.spec.modelSelection,
          parentSessionId: open.parentSessionId,
          createdBy: actor,
          at: open.at,
        });
        if (open.spec.workspaceId !== null)
          yield* workspaces.retainForThread(open.id, open.spec.workspaceId);
        // The prompt is stored as an ordinary input, waiting with the
        // session. The frame that starts the session carries it, and a
        // controller that restarts in between still has it.
        const prompt = yield* inputs.insert({
          sessionId: open.id,
          source: "user",
          actor,
          text: open.prompt,
          at: open.at,
          ...(open.step === undefined ? {} : { stepIteration: open.step.iteration }),
        });
        yield* provideSql(claimAttachments(prompt.id, references));
        yield* audit.append({
          kind: open.kind,
          actor,
          record: { topic: "session", id: open.id, conversationId: open.conversationId ?? null },
          payload: {
            ...open.payload,
            sessionId: open.id,
            ...(open.spec.workspaceId === null ? {} : { workspaceId: open.spec.workspaceId }),
          },
          at: open.at,
        });
      }),

    /**
     * Moves up to `room` of this runner's oldest queued sessions to
     * `starting`, and returns the complete start frame for each: the token,
     * the spec, the input the session starts with, the GitHub account it
     * pushes as, when a Connection is set, and the `userMaterial` flag that
     * lets a Thread on the local runner see User Material. In the same write
     * it records the library skills each session got (`recordLibrarySkills`).
     *
     * The account is read plainly. A session with a GitHub Connection always
     * gets the Connection's id and the git identity it commits as on its
     * frame, whatever state its token is in: the runner can ask for a fresh
     * token while it prepares the session, and the commits are made as the
     * Connection's account either way. The token and its expiry are on the
     * frame only when the read gave a usable token: it gives none for an
     * expired token or a Connection that is disabled or needs reconnecting. A
     * token inside the refresh margin but not yet expired is passed as it is.
     *
     * The input is the session's oldest waiting input. It is claimed in the
     * same write, exactly as an input sent on its own is, so the runner's
     * answer to it is recorded the same way, and a controller restart before
     * that answer cancels it like any other input on the wire.
     *
     * A queued session with no waiting input is not started. A resumed one is
     * moved back to the exit it was resumed from (`undoResume`); one that
     * never ran stays queued.
     *
     * Joins the caller's transaction and reads what the frames need inside it,
     * which is fine because a database read and a decrypt do not wait on a
     * runner. The daemon sends the frames only after that transaction commits.
     */
    claimStarts: (
      runnerId: string,
      room: number,
      needs: StartNeeds,
    ): Effect.Effect<ReadonlyArray<StartRequest>, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        // A runner without the capability still gets the start, only without
        // the session's skills (spec 03 section 2.2).
        const runnerLoadsSkills = (needs.runner.negotiatedCapabilities ?? []).includes(
          SKILLS_CAPABILITY,
        );
        // A session's skills depend only on its `agentId`, and every Thread
        // gets the same list, so each answer is kept for the rest of this
        // claim: the library is read at most once, by the first Thread.
        const decidedSkills = new Map<string | null, ReadonlyArray<SessionLibrarySkill>>();
        const claimed: Array<StartRequest> = [];
        const skipped: Array<string> = [];
        const inputless: Array<string> = [];
        // One answer per account and harness, because every queued session of
        // a pair gets the same one and the check reads the whole fleet.
        const runnableRefusals = new Map<string, string | null>();
        // Likewise one list per account, harness and model: the catalog is
        // large, and the list depends on the session's model when the runner
        // has no list of its own yet.
        const unlistedModelsByRun = new Map<string, ReadonlyArray<UnlistedModel>>();
        // The loop moves past every row it reads, including rows that fail to
        // decode, so each candidate is fetched and decoded once. A runner's
        // room is for sessions that can start, not for specs that cannot.
        let after: QueuePosition | undefined;
        while (claimed.length < room) {
          const queued = yield* sessions.oldestQueued(runnerId, room - claimed.length, after);
          if (queued.length === 0) break;
          for (const row of queued) {
            after = { createdAt: row.createdAt, id: row.id };
            if (claimed.length >= room) break;
            // Normally the same codec wrote and reads a stored spec, so one
            // that fails to decode was queued by an older build. It stays
            // queued, where a user can see it and stop it, and the loop
            // continues.
            const spec = yield* Effect.option(decodeSpecDocument(row.spec));
            if (Option.isNone(spec)) {
              skipped.push(row.id);
              continue;
            }
            // Read per row, before the row leaves the queue: an account that
            // cannot be prepared is one session's problem, and failing here
            // would roll back every other session claimed in this batch. The
            // key is read now rather than stored, like the GitHub account's
            // token: the frame is the only place it is written down. Start,
            // resume and fork all queue the session and come through here, so
            // each of them sends the same home.
            //
            // A refusal (`NotFound`, `InvalidState`) ends the session with
            // the reason. Retrying could never mend it without a person
            // acting, and meanwhile the session would be logged on every pass
            // and would block deleting its account. The one error that can
            // pass by itself, a database failure, is not caught: it rolls
            // this claim back and the next pass tries again.
            //
            // The account must also still be able to run here: the session
            // was queued under the rule of that moment, and a sign-in or a
            // harness may have gone since.
            const pair = `${row.providerAccountId}/${row.harnessId}`;
            if (!runnableRefusals.has(pair)) {
              runnableRefusals.set(
                pair,
                yield* needs.requireAccountRunnable(row.providerAccountId, row.harnessId).pipe(
                  Effect.as(null),
                  Effect.catchIf(
                    (error): error is InvalidState => error instanceof InvalidState,
                    (refused) => Effect.succeed(refused.error.message),
                  ),
                ),
              );
            }
            const notRunnable = runnableRefusals.get(pair) ?? null;
            if (notRunnable !== null) {
              yield* endUnstartable(row.id, notRunnable, at);
              continue;
            }
            const prepared = yield* needs
              .prepareHarnessAccount(row.providerAccountId, row.harnessId)
              .pipe(
                Effect.map((harnessAccount) => ({ harnessAccount })),
                Effect.catchIf(
                  (error): error is NotFound | InvalidState =>
                    error instanceof NotFound || error instanceof InvalidState,
                  (refused) => Effect.succeed({ refusal: refused.error.message }),
                ),
              );
            if ("refusal" in prepared) {
              yield* endUnstartable(row.id, prepared.refusal, at);
              continue;
            }
            const { harnessAccount } = prepared;
            // A start always carries an input. Every path that queues a
            // session stores its input first, and the input a queued session
            // starts with cannot be cancelled, so only data stored by an
            // older build can lack one. A resumed session goes back to the
            // exit it was resumed from, and resumes again at its next input.
            // A session that never ran has no exit to go back to, so it stays
            // queued, where a user can see it and stop it. This is the last
            // check that skips a row, so no row is claimed for a session that
            // is then skipped.
            const waiting = yield* inputs.oldestWaiting(row.id);
            if (Option.isNone(waiting)) {
              if (!(yield* undoResume(row.id)) && !warnedInputlessSessions.has(row.id)) {
                inputless.push(row.id);
              }
              continue;
            }
            // Checked again here, because the runner or its models may have
            // changed since the input was stored. A refused session stays
            // queued, and its input stays waiting with the reason, where the
            // user sees it and can change the input or the model.
            if (
              yield* holdInputWithRefusedAttachments(waiting.value, {
                runnerId,
                providerAccountId: row.providerAccountId,
                harnessId: row.harnessId,
                model: row.modelSelection.model,
              })
            )
              continue;
            // The session's own token for the public API. It is created for
            // this start and its hash is stored in the same update that marks
            // the session as starting, so the token is valid exactly while the
            // row says the session is running. A resume also passes through
            // here, so its new token replaces the one the previous process
            // held.
            const token = mintToken();
            yield* sessions.started(row.id, hashToken(token), at);
            // The row was read in this transaction, and nothing else writes
            // between that read and this claim.
            const input = Option.getOrThrow(yield* inputs.claim(waiting.value.id, at));
            yield* announceSessionChange(row);
            // The account's token is read now rather than stored: the only
            // place it is written is the frame that carries it to the runner.
            const connectionId = row.githubConnectionId;
            const account =
              connectionId === null ? undefined : yield* needs.readGithubAccount(connectionId);
            const gitIdentity =
              connectionId === null ? undefined : yield* needs.readGitIdentity(connectionId);
            // Built at every start rather than stored, so a resume or a fork
            // sees the session's grants and repositories as they are now.
            const coordination = yield* needs.buildCoordination(row.id);
            // Decided at every start, like the coordination paragraph, so a
            // resume or a fork gets the library as it is now.
            const skills =
              decidedSkills.get(row.agentId) ??
              (yield* provideSql(decideSessionSkills({ agentId: row.agentId })));
            decidedSkills.set(row.agentId, skills);
            if (!runnerLoadsSkills && skills.length > 0) {
              // The Thread starts without the skills it should have, so its
              // conversation says why (spec 06 section 9.4, Failures). A
              // start that goes back to the queue because the runner
              // disconnected before the frame left writes the warning again
              // at its next claim, so the conversation can show it twice. When
              // that next claim is on a runner that loads skills, the warning
              // already written is out of date. Both are accepted: a requeue
              // is rare, and a warning is never taken back once written.
              yield* appendRuntimeWarning(
                row.id,
                buildOldRunnerSkillsWarning(needs.runner.name),
                at,
              );
            }
            // Decided at every start, so a resume or a fork sees the catalog as
            // it is now.
            const runKey = `${pair}/${row.modelSelection.model}`;
            let unlistedModels = unlistedModelsByRun.get(runKey);
            if (unlistedModels === undefined) {
              unlistedModels = yield* needs.listUnlistedModels(
                row.providerAccountId,
                row.harnessId,
                runnerId,
                row.modelSelection.model,
              );
              unlistedModelsByRun.set(runKey, unlistedModels);
            }
            // Saved so a client can read exactly the library skills this
            // session got. A runner that cannot load skills gets none, so
            // none is recorded.
            yield* sessions.recordLibrarySkills(row.id, runnerLoadsSkills ? skills : []);
            claimed.push({
              sessionId: row.id,
              input,
              frame: {
                _tag: "sessionStart",
                requestId: input.id,
                sessionId: row.id,
                // Built as for an input sent on its own (`inputFrame`), so a
                // step prompt carries its step's key here too. The model
                // selection is the session's current one: a `session.update`
                // while the session was queued changes it, and the spec does
                // not.
                input: buildTurnInput(row, input),
                harnessId: row.harnessId,
                harnessAccount,
                spec: coordination === undefined ? spec.value : { ...spec.value, coordination },
                token,
                ...(connectionId === null ? {} : { githubConnectionId: connectionId }),
                ...(gitIdentity === undefined ? {} : { gitIdentity }),
                ...(account === undefined
                  ? {}
                  : {
                      ghToken: account.token,
                      ...(account.expiresAt === undefined
                        ? {}
                        : { ghTokenExpiresAt: account.expiresAt }),
                    }),
                ...(row.checkoutBranch === null ? {} : { checkoutBranch: row.checkoutBranch }),
                // Only a Thread on the local runner sees User Material (spec
                // 06 section 9.1). The flag is decided here at every start
                // rather than stored on the spec, so a resume or a fork of a
                // Thread is decided again.
                ...(row.agentId === null && needs.localRunnerId === runnerId
                  ? { userMaterial: true }
                  : {}),
                // An absent list and an empty one both mean no library
                // skills, so an empty list is left out.
                ...(runnerLoadsSkills && skills.length > 0
                  ? { skills: skills.map(({ name, revisionHash }) => ({ name, revisionHash })) }
                  : {}),
                // An absent list and an empty one both mean none, so an empty
                // list is left out.
                ...(unlistedModels.length > 0 ? { unlistedModels } : {}),
              },
            });
          }
        }
        // Logged, because to every observer a skipped row looks like one
        // waiting for room. Only this log shows otherwise.
        if (skipped.length > 0) {
          yield* Effect.logError(
            "skipped queued sessions whose stored spec no longer decodes; they stay queued",
            skipped,
          );
        }
        // Logged once per session, not on every pass, because such a row
        // is skipped on every pass until a user stops it. The sessions are
        // marked as logged only once the transaction commits: one that rolls
        // back may end before this log, and the next pass must log them then.
        if (inputless.length > 0) {
          yield* Effect.logWarning(
            "skipped queued sessions that never ran and have no waiting input to start with; " +
              "they stay queued",
            inputless,
          );
          yield* afterCommit(() => {
            for (const id of inputless) warnedInputlessSessions.add(id);
          });
        }
        return claimed;
      }),

    /**
     * Builds the frame that stops a session's harness. The daemon decides when
     * to send it, and writes the changes around it.
     */
    stopping: (sessionId: string): SessionStop => ({ _tag: "sessionStop", sessionId }),

    /**
     * Builds the frame that sends one stored input to the session's runner,
     * with the session's current model selection. The selection goes with
     * every input because only the adapter knows whether the input starts a
     * turn, and a harness accepts a model change only at the start of a turn.
     *
     * The prompt of an agent step carries the step's key, so the runner knows
     * the turn it starts is the step's and reports its result. Throws, as a
     * defect, on a step prompt whose session was started by no step
     * (`buildStepKey`).
     */
    inputFrame: (
      session: Pick<StoredSession, "id" | "runId" | "stepId" | "modelSelection">,
      row: StoredInput,
    ): SessionInput => ({
      _tag: "sessionInput",
      requestId: row.id,
      sessionId: row.sessionId,
      input: buildTurnInput(session, row),
    }),

    /**
     * Builds the frame that stops the turn a session is running, or, with
     * `subagentId`, the work of that subagent and every subagent below it.
     * The result arrives in the session's stream as `turn.completed`, so the
     * daemon sends this frame without waiting for a reply.
     */
    interrupting: (sessionId: string, subagentId: SubagentId | undefined): SessionInterrupt => ({
      _tag: "sessionInterrupt",
      sessionId,
      ...(subagentId === undefined ? {} : { subagentId }),
    }),

    /**
     * Builds the frame that decides the approval a session's harness is
     * waiting on. The result arrives in the session's stream as
     * `request.resolved`, so the daemon sends this frame without waiting for
     * a reply.
     */
    respondingToApprovalRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): SessionRespondToApprovalRequest => ({
      _tag: "sessionRespondToApprovalRequest",
      sessionId,
      requestId,
      decision,
    }),

    /**
     * Builds the frame that answers an open question of a session's harness.
     * Every frame carries a new `answerId`, which the runner's result echoes.
     * `modelSelection` is the session's current model, which the harness
     * applies if the answer starts a turn.
     */
    respondingToQuestion: (
      sessionId: string,
      requestId: string,
      answers: QuestionAnswers,
      modelSelection: ModelSelection,
    ): SessionRespondToQuestion => ({
      _tag: "sessionRespondToQuestion",
      sessionId,
      requestId,
      answerId: uuidToString(mintUuid()),
      answers,
      modelSelection,
    }),

    /**
     * Resolves the approval notification about a session's request as
     * decided, with the answer that sends `decision`, stamped with the
     * current actor. The controller daemon calls it in the transaction that
     * answers the request, so the notification shows the request as answered,
     * wherever the answer came from. Does nothing when no open notification
     * offers that answer, as for a `question` request, which raises none.
     *
     * Fails with `InvalidState` when the notification about the request is
     * already resolved, with a different message for each case:
     *
     * - the request was answered before;
     * - its wait ended without an answer: the user interrupted the turn or
     *   stopped the session, or the harness moved on, and the notification
     *   was withdrawn.
     *
     * The failure rolls back the caller's transaction, so no second answer is
     * recorded or sent.
     */
    resolveApprovalNotification: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void, InvalidState | SqlError> =>
      Effect.flatMap(
        notifier.answerDecisionsAbout(
          buildRequestSubject(sessionId, requestId),
          APPROVAL_ANSWER_IDS[decision],
        ),
        (outcome) => {
          switch (outcome) {
            case "decided":
            case "none":
              return Effect.void;
            case "already-decided":
            case "already-handled":
              return Effect.fail(createInvalidStateError(ALREADY_ANSWERED));
            case "already-withdrawn":
              return Effect.fail(createInvalidStateError(WAIT_ENDED));
          }
        },
      ),

    /**
     * Withdraws the approval notifications about the Requests whose wait the
     * user ended without answering: by interrupting or by stopping the
     * session. The withdraw reason stored on each notification names which of
     * the two.
     *
     * - Without `subagentId`, every open Request of the session is withdrawn:
     *   interrupting the session's own agent stops all its work, its
     *   subagents' too.
     * - With `subagentId`, only the Requests of that subagent and of every
     *   subagent below it are withdrawn (spec 10 section 7.6).
     *
     * Reads the session in the caller's transaction, so it sees the Requests
     * open when the transaction runs. Does nothing for a Request whose
     * notification is already resolved.
     */
    withdrawApprovalNotifications: (
      sessionId: string,
      endedBy: WaitEndedBy,
      subagentId: SubagentId | undefined,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* sessions.one(sessionId);
          if (Option.isNone(found)) return;
          let requests = found.value.openRequests;
          if (subagentId !== undefined) {
            const tree = collectSubagentTree(yield* subagents.listAll(sessionId), subagentId);
            requests = requests.filter(
              (request) => request.subagentId !== undefined && tree.has(request.subagentId),
            );
          }
          yield* withdrawRequestNotifications(
            sessionId,
            requests,
            buildWaitEndedWithdrawReason(endedBy),
          );
        }),
      ),

    /**
     * Puts a claimed input back to waiting with `reason`, without sending
     * it, the same way as an input the runner refused
     * (`returnUndeliveredInput`). For a caller that finds, after the claim,
     * that the input cannot go to the runner.
     */
    refuseClaimedInput: (row: StoredInput, reason: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(returnUndeliveredInput(row, reason)),

    /**
     * Puts a session back on the queue when its start frame could not be
     * sent, because the runner was not connected, and puts the input the
     * frame carried back to waiting. The input never left the controller, so
     * no reason is stored on it. Runs in its own transaction, because the one
     * that claimed the rows committed before the frame was sent.
     */
    requeue: (start: StartRequest): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const { sessionId, input } = start;
          yield* inputs.requeue(input.id, input.sentAt, null);
          // The update also clears the token hash. The token was sent on a
          // frame nobody accepted, so nothing holds it, and no one may call the
          // API as a queued session. The cache is cleared after the commit,
          // like any other invalidation, so a call in flight cannot cache the
          // old row again before the write is visible.
          yield* sessions.moved(sessionId, "queued", yield* nowIso);
          yield* afterCommit(() => {
            tokens.forgetSessions([sessionId]);
          });
          yield* announceSessionChangeById(sessionId);
        }),
      ),

    /**
     * Stops a session that was never sent to a runner, so no runner needs to
     * be told, and returns whether it did. Returns `false`, changing nothing,
     * when the session is no longer `queued`: dispatch may have sent it to its
     * runner since the caller read it, and then only the runner can end it.
     * Joins the caller's transaction, which also writes the audit entry.
     */
    endQueued: (sessionId: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const ended = yield* sessions.endQueued(sessionId, at);
        if (Option.isNone(ended)) return false;
        yield* endSessions([ended.value], "stopped");
        return true;
      }),

    /**
     * Ends every session still open on a runner, with the same cleanup as any
     * other move to `exited` (`endSessions`), and each session is announced
     * once. Joins the caller's transaction as a savepoint.
     * Returns the ended sessions as they were before. A caller retiring the
     * runner tells it to stop each one that was `starting`, `idle` or `busy`
     * before closing the connection.
     */
    endOnRunner: (runnerId: string): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const ended = yield* sessions.endOnRunner(runnerId, at);
          yield* endSessions(ended, "runner_retired");
          yield* Effect.forEach(
            ended,
            ({ id }) =>
              audit.append({
                kind: "session.stopped",
                actor: SYSTEM_ACTOR,
                payload: { sessionId: id, runnerId, reason: "runner_retired" },
                at,
              }),
            { discard: true },
          );
          return ended;
        }),
      ),

    endForWorkspace,

    /**
     * Cancels the step prompts still waiting on the sessions of a run that
     * has ended, exited sessions included. A session that kept its prompt
     * through an exit (`keepsStepPromptOnExit`) would otherwise be resumed
     * for a turn that the run no longer wants. Joins the caller's
     * transaction, which ends the run.
     */
    cancelStepPromptsOfEndedRun: (runId: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const touched = yield* inputs.cancelStepPromptsOfRun(runId, STEP_RUN_ENDED);
        for (const id of touched) {
          yield* announceSessionChangeById(id);
        }
      }),

    /**
     * Ends every running session on a lost runner: the runner is not in
     * `connected`, and nothing was heard about the session for longer than the
     * session's absolute timeout (the repository method explains that limit).
     * Without this, a session on a runner that never comes back would keep a
     * valid token forever. Joins the caller's transaction, which is where
     * `connected` was read. Nothing is sent to a runner, because none of these
     * runners is connected. Returns the ended sessions as they were before.
     */
    endOnLostRunners: (
      connected: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<StoredSession>, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const ended = yield* sessions.endOnLostRunners(connected, at);
        yield* endSessions(ended, "runner_lost", RUNNER_LOST);
        yield* Effect.forEach(
          ended,
          ({ id, runnerId, conversationId }) =>
            audit.append({
              kind: "session.reconciled",
              actor: SYSTEM_ACTOR,
              record: { topic: "session" as const, id, conversationId },
              payload: { sessionId: id, runnerId, reason: "runner_lost" },
              at,
            }),
          { discard: true },
        );
        return ended;
      }),

    /**
     * Sets the model selection the session runs under from now on, joining the
     * caller's transaction. The stored `spec` is not changed: it is the spec
     * the runner was started with, and a resume or a fork reads the session's
     * `modelSelection` instead.
     */
    setSelection: (
      sessionId: string,
      modelSelection: ModelSelection,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sessions.setModelSelection(sessionId, modelSelection);
        yield* announceSessionChangeById(sessionId);
      }),

    /**
     * Stores what the title generation answered for a Thread's first message:
     * a title, `needsRefinement` (the model's own judgement that the message
     * was too vague for a good title), and a role. Announces the session, so
     * clients show the change. Runs in its own transaction.
     *
     * Title and role are accepted on their own, so one can be stored while the
     * other is dropped. Both are cleaned by `cleanGeneratedText` first:
     * line breaks and repeated spaces become single spaces, and control and
     * format characters are removed.
     *
     * - The title is cut to `MAX_TITLE_LENGTH`. A title that is empty after
     *   cleaning is dropped, and the cut-short title stays.
     * - The role is never cut, because a cut role reads as a broken phrase.
     *   It is dropped unless it is a valid `SessionRole`: the one rule for a
     *   role given at spawn and a generated one. A session that already has a
     *   role keeps it.
     *
     * When both are dropped, nothing is written or announced.
     *
     * No user can rename a session today, so there is no user-chosen title to
     * protect. A system write like this one carries no actor, as with
     * `setSelection`.
     */
    setGeneratedTitleAndRole: (
      sessionId: string,
      answer: { readonly title: string; readonly needsRefinement: boolean; readonly role: string },
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const title = cutTitle(cleanGeneratedText(answer.title));
        const cleanedRole = cleanGeneratedText(answer.role).trim();
        const validRole = isAcceptableRole(cleanedRole) ? cleanedRole : undefined;
        if (title === "" && validRole === undefined) return;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (title !== "")
              yield* sessions.setGeneratedTitle(sessionId, title, answer.needsRefinement);
            if (validRole !== undefined) yield* sessions.setGeneratedRole(sessionId, validRole);
            yield* announceSessionChangeById(sessionId);
          }),
        );
      }),

    /**
     * Sets the access mode and permission profile an exited session resumes
     * under, joining the caller's transaction. The caller also puts the same
     * access mode in the resume spec, so the row shows what the resumed
     * harness runs under. It is kept on the service, not read straight from
     * the repository, because it is a write, and every write to a session
     * goes through this service.
     *
     * It checks no grant. The caller is the controller daemon, resuming an
     * assistant's session under the assistant's current settings.
     */
    setAccess: (sessionId: string, access: SessionAccess): Effect.Effect<void, SqlError> =>
      sessions.setAccess(sessionId, access),

    /**
     * Stores one user input and the model selection the session runs under
     * from then on, and returns the stored row, claimed or not
     * (`claimWhenIdle`). For an exited session, it also puts the session back on
     * the queue with its resume spec, when `resume` allows it; otherwise the
     * input waits, and a later resume sends it. Joins the caller's
     * transaction, so when the caller fails, for example on an invalid model
     * option, neither the new selection nor the input is stored.
     *
     * Fails with `Validation` when an image is gone or was uploaded by
     * someone else, or when the session's runner or the input's model cannot
     * take images (`refuseUnacceptedAttachments`).
     */
    takeInput: <E = never>(
      taking: TakeInputRequest<E>,
    ): Effect.Effect<StoredInput, E | Validation | SqlError | InvalidState> =>
      Effect.gen(function* () {
        const references = yield* provideSql(readClaimableAttachments(taking.attachments));
        if (references.length > 0) {
          const session = Option.getOrThrow(yield* sessions.one(taking.sessionId));
          yield* provideAttachmentCheck(
            refuseUnacceptedAttachments({
              runnerId: session.runnerId,
              providerAccountId: session.providerAccountId,
              harnessId: session.harnessId,
              model: taking.modelSelection.model,
              attachments: references,
            }),
          );
        }
        yield* sessions.setModelSelection(taking.sessionId, taking.modelSelection);
        const claimed =
          taking.claimWhenIdle &&
          Option.exists(yield* sessions.one(taking.sessionId), (now) => now.status === "idle") &&
          !(yield* inputs.holdsInputOnTheWire(taking.sessionId));
        const created = yield* inputs.insert({
          sessionId: taking.sessionId,
          source: "user",
          actor: yield* currentStamp,
          text: taking.text,
          at: taking.at,
          ...(claimed ? { sentAt: taking.at } : {}),
          ...(taking.stepIteration === undefined ? {} : { stepIteration: taking.stepIteration }),
        });
        yield* provideSql(claimAttachments(created.id, references));
        // New work for a Thread the user marked Done means it is not done
        // any more, so the input takes it off the Done shelf.
        yield* reopenThread(taking.sessionId, created.actor, taking.at, created.id);
        // Someone is asking again, so the session may be resumed for every
        // input that waits.
        yield* sessions.setCrashGuardArmed(taking.sessionId, false);
        // After the insert: a session is resumed only while it has input
        // waiting, and this input is what it resumes for.
        if (taking.buildResumeSpec !== undefined) {
          yield* resume(taking.sessionId, taking.buildResumeSpec, taking.at, false);
        }
        yield* announceSessionChangeById(taking.sessionId);
        return { ...created, attachments: references };
      }),

    resume,

    /**
     * Stores the input created by one subscription match, joining the caller's
     * transaction. Returns `none` when that subscription and event already
     * have an input, so an event that reaches the event router twice wakes the
     * session only once.
     *
     * The input is stored as waiting, never claimed. How it reaches the
     * session is decided after the write is committed: it is sent now, held
     * until the running turn ends, or the session is started again.
     */
    storeMatchedInput: (
      matched: NewMatchedInput,
    ): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.gen(function* () {
        const created = yield* inputs.insertMatched(matched);
        if (Option.isNone(created)) return created;
        // An event that wakes a Done Thread is new work for it, as typed
        // input is, so the Thread leaves the Done shelf.
        yield* reopenThread(matched.sessionId, matched.actor, matched.at, created.value.id);
        yield* sessions.setCrashGuardArmed(matched.sessionId, false);
        yield* announceSessionChangeById(matched.sessionId);
        return created;
      }),

    /**
     * Cancels every input still waiting from one subscription, and stores the
     * reason the subscription ended, so a reader of the input sees why it was
     * never delivered.
     */
    cancelMatchedInputs: (subscriptionId: string, reason: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const sessionId of yield* inputs.cancelQueuedForSubscription(subscriptionId, reason)) {
          yield* announceSessionChangeById(sessionId);
        }
      }),

    /**
     * Gives up on the input waiting for an exited session that cannot be
     * resumed. `refusal` is the reason the resume was refused.
     *
     * - A session that answers no conversation, such as a Thread, keeps its
     *   input queued, where its reader can see it was not delivered and
     *   cancel it.
     * - A session that answers a conversation has its waiting input
     *   cancelled, and `SessionObserver` is told. Nobody reads that session's
     *   inputs: the owner reads the conversation, so input left queued there
     *   would never be answered and never be explained.
     * - A session started by an agent step is treated the same way. Its run
     *   waits for the step's prompt to be answered, and is told through
     *   `SessionObserver` so the step fails instead of waiting forever.
     *
     * Runs in its own transaction, and reads the session again inside it, so
     * input that a resume by another caller has just made deliverable is
     * never cancelled. An input still on the wire is left to the send that
     * claimed it.
     */
    dropUnresumableInputs: (sessionId: string, refusal: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* sessions.one(sessionId);
          if (Option.isNone(found)) return;
          const session = found.value;
          if (session.status !== "exited") return;
          if (session.conversationId === null && session.runId === null) return;
          const reason = `the session could not be resumed (${refusal})`;
          const cancelled = yield* inputs.cancelQueued(sessionId, reason);
          if (cancelled.count === 0) return;
          yield* announceSessionChange(session);
          yield* observer.inputsDropped({
            session,
            // The hint is for the owner reading the conversation. A step's
            // error shows the same text, and "send the message again" would
            // mislead there.
            refusal:
              session.conversationId === null
                ? reason
                : `${reason}. Send the message again to start a new session.`,
            droppedStepIterations: cancelled.stepIterations,
          });
        }),
      ),

    /**
     * Prepares the sessions of a conversation that is about to be deleted.
     * Joins the caller's transaction. It:
     *
     * - cancels every queued input of every session that answers the
     *   conversation, sent or not, with `reason`, so none of those sessions
     *   is resumed to run it;
     * - releases the workspace lease of every exited session in it again, as
     *   `orphan`. Such a session released its lease as `idle` when it could
     *   still be resumed, but once its conversation is gone nothing can
     *   resume it, so its workspace is kept only for the short window.
     *
     * A session that has not exited yet is left to its own exit, which
     * releases its lease as `orphan` because its conversation is gone by then.
     */
    abandonConversation: (conversationId: string, reason: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const sessionId of yield* inputs.cancelForConversation(conversationId, reason)) {
          yield* announceSessionChange({ id: sessionId, conversationId });
        }
        const at = yield* nowIso;
        for (const sessionId of yield* sessions.listExitedWithWorkspaceInConversation(
          conversationId,
        )) {
          yield* workspaces.release({ kind: "session", id: sessionId }, "orphan", at);
        }
      }),

    queuedInput,

    /**
     * Stores a Discussion Input with `text`, from the actor `system`, already
     * claimed for one send, and returns it. Returns `none`, storing nothing,
     * when:
     *
     * - the session's status is not `status`;
     * - another input of the session is sent and not yet answered: the
     *   runner takes one input per turn boundary (`holdsInputOnTheWire`);
     * - for `idle`, another input of the session waits to be sent. Every
     *   other waiting input goes before a Discussion Input (spec 19 section
     *   5.3), and the session is told when that input's turn ends. A busy
     *   session's waiting inputs wait for its turn's end, so they do not stop
     *   a Discussion Input steered into the running turn.
     *
     * Runs in its own transaction.
     *
     * The row is claimed when it is stored, so no delivery pass sends it
     * first, and it is never a waiting input. Nothing is sent here: the
     * caller sends the row once this commits. Unlike every other input
     * write, it never reopens a Thread, never resumes a session and never
     * disarms the crash-loop guard: telling a session about Discussions is no
     * reason to run it (spec 19 section 5.2).
     */
    storeClaimedDiscussionInput: (
      sessionId: string,
      text: string,
      status: "idle" | "busy",
    ): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          // The caller passes the id of a stored session, and sessions are never deleted.
          const session = Option.getOrThrow(yield* sessions.one(sessionId));
          if (session.status !== status || (yield* inputs.holdsInputOnTheWire(sessionId))) {
            return Option.none();
          }
          if (status === "idle" && Option.isSome(yield* inputs.oldestWaiting(sessionId))) {
            return Option.none();
          }
          const at = yield* nowIso;
          const created = yield* inputs.insert({
            sessionId,
            source: "discussion",
            actor: SYSTEM_ACTOR,
            text,
            at,
            sentAt: at,
          });
          yield* announceSessionChange(session);
          return Option.some(created);
        }),
      ),

    /**
     * Marks an input as sent and returns the row as the update found it.
     * Returns `none` when another caller, such as a second steer or a flush,
     * claimed it first.
     */
    claimInput: (inputId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      withTransaction(
        sql,
        Effect.flatMap(nowIso, (at) => inputs.claim(inputId, at)),
      ),

    /**
     * Claims the oldest input still waiting on an idle session, for a
     * delivery pass that finds the session idle. Returns `none` when:
     *
     * - no input is waiting, or the session is not `idle`;
     * - another input of the session is sent and not yet answered: that
     *   input's turn may not have started yet, and the runner takes one input
     *   per turn;
     * - the oldest input's attachments cannot go to the session's runner and
     *   model (`holdInputWithRefusedAttachments`). The inputs queued behind
     *   it wait for it, as in any queue.
     */
    claimOldestUnlessOneIsOnTheWire: (
      sessionId: string,
    ): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const waiting = yield* inputs.oldestWaiting(sessionId);
          if (Option.isNone(waiting)) return Option.none();
          if (waiting.value.attachments.length > 0) {
            const session = Option.getOrThrow(yield* sessions.one(sessionId));
            const held = yield* holdInputWithRefusedAttachments(waiting.value, {
              runnerId: session.runnerId,
              providerAccountId: session.providerAccountId,
              harnessId: session.harnessId,
              model: session.modelSelection.model,
            });
            if (held) return Option.none();
          }
          return yield* inputs.claimOldestUnlessOneIsOnTheWire(sessionId, yield* nowIso);
        }),
      ),

    /**
     * Records the outcome of a send that carried an input to a runner: a
     * `sessionInput`, or a `sessionStart` that carried the input. This is the
     * one place an answer to a sent input is recorded. `sent` is the outcome
     * as `RunnerConnections.sendFrameCarryingInput` returns it.
     *
     * - The runner took the input: the delivery is recorded
     *   (`recordDelivery`), and `delivered` is returned.
     * - The runner refused the input, or the frame never left the controller
     *   because the runner had no connection: the runner cannot have run the
     *   input. The reason is the runner's own message, or `NOT_SENT`. What
     *   happens next depends on the kind of failure the runner reported:
     *   - Most failures put the input back to waiting
     *     (`returnUndeliveredInput`), and `notDelivered` is returned.
     *   - A refused steer also puts it back to waiting, but it is no
     *     failure: `steerDeferred` is returned, and the input runs as the
     *     next turn.
     *   - A failure that sending the input again would not mend cancels the
     *     input (`failUndeliveredInput`), and `notDelivered` is returned.
     * - The frame left but no answer came, because the connection ended or
     *   the wait ran out: whether the runner took the input is unknown. An
     *   ordinary input is handled as a refused one, with `NOT_DELIVERED`.
     *   An agent step's prompt is marked `sent` instead, with no reason
     *   stored, and `unconfirmed` is returned with the request for the
     *   step's result.
     *
     * A step prompt is never sent twice, because the runner may have run it
     * and that turn may push or comment. Nor is the step failed: only the
     * runner's answer settles it. The caller tells the result request to the
     * runner right away. The runner handles it only after the prompt, so it
     * answers how the turn the prompt started ended, or that the step was
     * interrupted when it refused the prompt or lost it in a restart. When
     * the runner is not connected, nothing is sent, and the runner is asked
     * again when it connects.
     *
     * A caller that has to fail on `notDelivered` or `unconfirmed` builds its
     * own error; dispatch does not fail at all.
     */
    recordInputAnswer: (
      row: StoredInput,
      sent: SendOutcome<SessionInputResult>,
      runnerId: string,
    ): Effect.Effect<RecordedInputAnswer, SqlError> =>
      Effect.gen(function* () {
        if (sent._tag === "notSent") {
          yield* returnUndeliveredInput(row, NOT_SENT);
          return { _tag: "notDelivered", reason: NOT_SENT } as const;
        }
        if (Option.isNone(sent.answer)) {
          const iteration = row.stepIteration;
          if (iteration === null) {
            yield* returnUndeliveredInput(row, NOT_DELIVERED);
            return { _tag: "notDelivered", reason: NOT_DELIVERED } as const;
          }
          return yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const session = Option.getOrThrow(yield* sessions.one(row.sessionId));
              if (yield* inputs.markSent(row.id, row.sentAt)) {
                yield* announceSessionChange(session);
              }
              return {
                _tag: "unconfirmed",
                resultRequest: buildAgentStepResultRequest(
                  buildStepKey(session, iteration),
                  session.id,
                  session.workspaceId,
                ),
              } as const;
            }),
          );
        }
        const answer = sent.answer.value;
        if (answer.ok) {
          yield* recordDelivery(row, answer.delivery, runnerId);
          return { _tag: "delivered", delivery: answer.delivery } as const;
        }
        const reason = answer.error.message;
        // There is no default branch, so a new kind of failure does not
        // compile until it is given a reaction here: a missing case leaves
        // the function without a return value on that path.
        //
        // An input fails, instead of going back to waiting, in two cases:
        //
        // - The failure is about the session's setup (the harness is not
        //   installed or not signed in, the transcript to resume is
        //   missing). Sending the input again would fail the same way, and
        //   the runner ends the session.
        // - The failure leaves it unknown whether the harness took the input
        //   (`HarnessProtocolError`), or the input asked for a model change
        //   the harness refused (`ModelChangeRefused`). Sending the first
        //   again could run it twice when the conversation resumes, and the
        //   second would be refused again.
        switch (answer.error._tag) {
          case "SessionNotRunning":
          case "InputNotDelivered":
          case "SessionAlreadyRunning":
          case "AdapterFailed":
            yield* returnUndeliveredInput(row, reason);
            return { _tag: "notDelivered", reason } as const;
          case "SteerRefused":
            // The refusal is no failure: the input runs as the next turn. But
            // the input may have been cancelled instead of put back to
            // waiting (a Discussion Input, or a session that has just exited
            // for good), or settled by a concurrent path. Then it is not
            // queued, and saying so would be wrong.
            return (yield* returnUndeliveredInput(row, reason))
              ? ({ _tag: "steerDeferred" } as const)
              : ({ _tag: "notDelivered", reason } as const);
          case "ModelChangeRefused":
          case "HarnessNotInstalled":
          case "HarnessLoginMissing":
          case "ResumeTranscriptMissing":
          case "HarnessProtocolError":
            yield* failUndeliveredInput(row, reason);
            return { _tag: "notDelivered", reason } as const;
        }
      }),

    /**
     * Applies a runner's result for one input, in order with the session's
     * events. The input came in a `sessionInput` or in a `sessionStart`.
     *
     * A delivered input is recorded on the row while a send still holds it,
     * or while it is an agent step's prompt marked `sent` because its send
     * got no answer in time. The waiting send (`recordDelivery`) and this
     * method both get the answer, and whichever runs first records it. Only
     * the one that records it moves the session: an input that opened a turn
     * moves an `idle` or `starting` session to `busy` (`openTurn`). Once it
     * is recorded here, a waiting send that runs after the turn ended cannot
     * move the session back to `busy`.
     *
     * A refused input changes nothing here: the send that waits for the
     * result puts it back to waiting. A step prompt marked `sent` stays
     * `sent`: its send already asked the runner for the step's result, and
     * the runner answers that the step was interrupted.
     *
     * Nothing changes when:
     *
     * - the input is no longer on the wire: the waiting send recorded the
     *   answer first, or gave up waiting and put the input back. A turn the
     *   runner opened anyway still moves the session, through `turn.started`;
     * - the session is held by another runner than the one that answered. A
     *   runner may answer only for its own sessions, so the answer is logged
     *   and dropped.
     */
    applyInputResult: (
      runnerId: string,
      result: SessionInputResult,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if (!result.ok) return;
          const found = yield* inputs.read(result.requestId);
          if (Option.isNone(found) || found.value.sentAt === null) return;
          const row = found.value;
          const session = yield* sessions.one(row.sessionId);
          if (Option.isNone(session) || session.value.runnerId !== runnerId) {
            return yield* Effect.logWarning(
              "dropped a runner's answer for an input of a session it does not hold",
              { runnerId, inputId: row.id, sessionId: row.sessionId },
            );
          }
          const recorded = yield* inputs.markDelivered(
            row.id,
            row.sentAt,
            result.delivery,
            yield* nowIso,
          );
          if (!recorded) return;
          if (result.delivery === "opened") yield* openTurn(runnerId, row.sessionId);
          yield* announceSessionChange(session.value);
        }),
      ),

    /**
     * Records files a session changed through shell commands, which the runner
     * found with git and reported outside the session's numbered events. The
     * edit observer gets them as it does an edit tool's files. Does nothing
     * when the session is unknown or is held by another runner: a runner may
     * report only on sessions placed on it.
     */
    applyFilesEdited: (runnerId: string, report: FilesEdited): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const session = yield* sessions.one(report.sessionId);
          if (Option.isNone(session) || session.value.runnerId !== runnerId) return;
          yield* editObserver.filesEdited(report.sessionId, report.editedFiles);
        }),
      ),

    /**
     * Records the usage a running session's harness reported for the
     * session's Provider Account (spec 06 section 18). Drops the report, and
     * logs why, when the session is unknown, is held by another runner (a
     * runner may report only on sessions placed on it), has exited, or its
     * account's kind declares no `usage`, because then there is no gauge to
     * fill. `AccountUsage.record` also drops it when the session's process
     * started before the account's key or token was replaced, because that
     * process still holds the old credential.
     */
    applyAccountUsageReported: (
      runnerId: string,
      report: AccountUsageReported,
    ): Effect.Effect<void, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const session = yield* sessions.one(report.sessionId);
        if (Option.isNone(session) || session.value.runnerId !== runnerId) {
          return yield* Effect.logInfo(
            "Dropped a runner's usage report, because the session is unknown or not on that runner",
          ).pipe(Effect.annotateLogs({ runnerId, sessionId: report.sessionId }));
        }
        if (session.value.status === "exited") {
          return yield* Effect.logDebug(
            "Dropped a runner's usage report, because the session has exited",
          ).pipe(Effect.annotateLogs({ runnerId, sessionId: report.sessionId }));
        }
        const { providerAccountId } = session.value;
        const account = yield* providerAccounts.one(providerAccountId);
        const kind = Option.isSome(account)
          ? findAccountKind(yield* host.providers(), account.value)
          : undefined;
        if (kind?.usage === undefined) {
          return yield* Effect.logDebug(
            "Dropped a runner's usage report, because the account's kind declares no usage",
          ).pipe(Effect.annotateLogs({ runnerId, sessionId: report.sessionId, providerAccountId }));
        }
        yield* accountUsage.record(providerAccountId, report.readings, {
          source: "session",
          credentialSince: session.value.processStartedAt,
        });
      }),

    /**
     * Applies a runner's report of the sessions it holds. Stores the native id
     * from each binding, then ends every session the controller thinks runs on
     * this runner but the report leaves out. A runner restart shows up only in
     * this report, because a disconnect without notice tells the controller
     * nothing. Runs in one transaction, so a dispatch by the caller afterwards
     * always sees the final result.
     *
     * The mismatch can also go the other way: the report lists a session the
     * controller already ended while the runner was unreachable. Returns the
     * ids of those sessions, so the caller can tell the runner to stop each.
     */
    bound: (
      runnerId: string,
      bindings: ReadonlyArray<SessionBinding>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          yield* Effect.forEach(
            bindings,
            (binding) =>
              sessions.bind(
                binding.sessionId,
                runnerId,
                binding.providerAccountId,
                binding.nativeSessionId,
              ),
            { discard: true },
          );
          const at = yield* nowIso;
          const gone = yield* sessions.reportedGone(
            runnerId,
            bindings.map((binding) => binding.sessionId),
            at,
          );
          // `endSessions` completes the token revocation. The rows are now
          // `exited`, which makes their tokens invalid, and anything cached
          // from those tokens while the sessions ran is dropped after the
          // commit.
          yield* endSessions(gone, "runner_restart");
          yield* Effect.forEach(
            gone,
            ({ id, conversationId }) =>
              audit.append({
                kind: "session.reconciled",
                actor: SYSTEM_ACTOR,
                record: { topic: "session" as const, id, conversationId },
                payload: { sessionId: id, runnerId, reason: "runner_restart" },
                at,
              }),
            { discard: true },
          );
          return yield* sessions.listExitedAmong(
            runnerId,
            bindings.map((binding) => binding.sessionId),
          );
        }),
      ),

    /**
     * Checks one event a runner reported against the session it names, and
     * folds it into the stored stream. Writes nothing: it works out the
     * stream rows before any transaction opens. Returns `undefined` when there
     * is nothing to write: the session does not exist, is not on this runner,
     * or has already seen the event.
     *
     * A delta's tap is announced here, before the transaction and never inside
     * it. A delta is not stored until it is flushed, but a client watching the
     * session must see it as soon as it is reported. So the tap is sent
     * whether or not the write that follows succeeds.
     */
    foldReport: (
      runnerId: string,
      seq: number,
      event: HarnessEvent,
    ): Effect.Effect<Folded | undefined, SqlError> =>
      Effect.gen(function* () {
        const id = event.sessionId;
        const found = yield* sessions.one(id);
        // A runner may report only on sessions placed on it. An event for any
        // other session is ignored.
        if (Option.isNone(found) || found.value.runnerId !== runnerId) return undefined;
        const held = tracking.get(id) ?? startTracking(yield* sessions.ingestState(id));
        const folded = fold(held, seq, event);
        if (folded === undefined) return undefined;
        if (event._tag === "content.delta") {
          yield* announce({
            _tag: "tap",
            sessionId: id,
            item: {
              turnId: event.turnId,
              itemId: event.itemId,
              streamKind: event.streamKind,
              delta: event.delta,
              ...(event.subagentId === undefined ? {} : { subagentId: event.subagentId }),
            },
          });
        }
        return folded;
      }),

    /**
     * Writes one folded report: its stream rows and the status change they
     * cause commit together (spec 04, Truth model). Joins the caller's
     * transaction, so the caller's other writes for the report commit with it.
     * Returns what is left to do after the commit, because that affects more
     * than this session's rows: an input claimed because a turn ended, which
     * the caller sends, whether a turn ended with no input to send, and
     * whether the session exited holding input.
     *
     * The session is read again here, inside the transaction, and every
     * decision about its status and its open Requests is made from that read.
     * Something else, such as a retired runner, can end the session between
     * `foldReport` and this write. A report that arrives that late is still
     * recorded, but it never moves the session or opens a request on it, so
     * it cannot raise an approval notification that nothing would withdraw.
     */
    applyReport: (
      runnerId: string,
      event: HarnessEvent,
      folded: Folded,
    ): Effect.Effect<AppliedReport, SqlError> =>
      Effect.gen(function* () {
        const id = event.sessionId;
        // `foldReport` found the row, and sessions are never deleted.
        const session = Option.getOrThrow(yield* sessions.one(id));
        const before = session.status;
        // An event for a session that has already exited is still recorded,
        // but changes nothing else: no Request, no subagent, no usage.
        const sessionAcceptsChanges = before !== "exited";
        const at = yield* nowIso;
        let toolCallsChanged = false;
        for (const row of folded.rows) {
          if (yield* sessions.append(id, row)) toolCallsChanged = true;
        }
        // Each agent has its own transcript topic, so each agent whose
        // transcript grew is announced once.
        const grown = new Set(folded.rows.map((row) => attributeEvent(row.event)));
        for (const agent of grown) {
          yield* announce({
            _tag: "transcript",
            sessionId: id,
            ...(agent === undefined ? {} : { subagentId: agent }),
          });
        }
        // After the rows, so the observer can read what this report wrote.
        // Only the session's own agent's events: a subagent's work never
        // changes what the observer keeps, such as an assistant's reply.
        if (attributeEvent(event) === undefined) yield* observer.sessionReported(session, event);
        // Records every finished edit, a subagent's and an exited session's
        // too. An edit that no longer counts is kept, and counts again if the
        // session becomes unfinished.
        if (event._tag === "item.completed" && event.editedFiles !== undefined) {
          yield* editObserver.filesEdited(id, event.editedFiles);
        }
        // Written together with the status change from the same event, so a
        // session that reads `idle` already has its harness-native id.
        const native = findNativeId(event);
        if (native !== undefined) {
          yield* sessions.bind(id, runnerId, session.providerAccountId, native);
        }
        // Before the Requests, so a Request a subagent opens can name it by
        // the description this same event may have filled in.
        const askers = sessionAcceptsChanges
          ? yield* applySubagentEvent(session, event)
          : new Map<SubagentId, StoredSubagent>();
        let requestsChanged = false;
        if (sessionAcceptsChanges && isRequestEvent(event)) {
          const openRequests = computeOpenRequestsAfter(event, session.openRequests);
          requestsChanged = openRequests !== session.openRequests;
          if (requestsChanged) yield* replaceOpenRequests(session, openRequests, event, askers);
        }
        const usageChanged = sessionAcceptsChanges && (yield* applySessionUsage(session, event));
        // A session starting or exiting is what counts as use of its
        // workspace. The time is shown to the user; how long the workspace is
        // kept is decided by its leases, not by this time.
        if (
          session.workspaceId !== null &&
          (event._tag === "session.started" || event._tag === "session.exited")
        ) {
          yield* workspaces.touched(session.workspaceId, at);
        }
        // `exited` is final, so a stray event after it is still recorded but
        // never brings the session back to life. Spec 06 §4.1 owns the rule.
        //
        // `session.started` moves only a `starting` session to `idle`. The
        // answer to the input the start carried is read as soon as it
        // arrives, while this event waits in the ingest queue, so that answer
        // may already have opened a turn and moved the session to `busy`. A
        // late `session.started` must not end that turn.
        const moved =
          folded.status === undefined ||
          folded.status === before ||
          before === "exited" ||
          (event._tag === "session.started" && before !== "starting")
            ? undefined
            : folded.status;
        let exitedHoldingInput = false;
        let claimedInput: StoredInput | undefined;
        if (moved !== undefined) {
          yield* sessions.moved(id, moved, at);
          // A turn started, so the resumed process did work: the crash-loop
          // guard no longer applies to it.
          if (moved === "busy") yield* sessions.setCrashGuardArmed(id, false);
          if (event._tag === "session.exited") {
            // A runner that cannot start the session refuses the start's
            // input before it reports the exit, so the input already holds
            // the runner's message by now. That message says why the session
            // failed, and the exit's own reason would hide it.
            yield* endSessions([session], event.reason, describeExited(event.reason), "keep");
            // A session that keeps its input through an exit is resumed for
            // it once this is committed. The caller does that, because it
            // sends frames.
            exitedHoldingInput = Option.isSome(yield* inputs.oldestWaiting(id));
          } else {
            yield* announceSessionChange(session);
          }
          // Only a session whose turn ended is sent one. A session that
          // becomes idle because its harness started had its oldest input
          // carried by the start, and that input's turn may not have opened
          // yet. Sending the next input now would put it into that turn, so
          // two queued inputs would run as one turn.
          //
          // An input sent and still unanswered does not block this claim. It
          // was sent before the turn that just ended, so that turn already
          // took it, and the runner can take one new input now.
          if (moved === "idle" && event._tag === "turn.completed") {
            const next = yield* inputs.oldestWaiting(id);
            if (
              Option.isSome(next) &&
              !(yield* holdInputWithRefusedAttachments(next.value, {
                runnerId: session.runnerId,
                providerAccountId: session.providerAccountId,
                harnessId: session.harnessId,
                model: session.modelSelection.model,
              }))
            ) {
              claimedInput = Option.getOrUndefined(yield* inputs.claim(next.value.id, at));
            }
          }
        } else {
          // No announce: most events do not change the status, and a refetch
          // for each of them would flood clients. Two exceptions:
          //
          // - a Request opening or closing changes no status, but the user
          //   has to see the request card;
          // - the session's own Token Usage or its tool call count changing
          //   is announced at the slow pace, because one of them changes
          //   with almost every turn.
          yield* sessions.touched(id, at);
          if (requestsChanged) {
            yield* announceSessionChange(session);
          } else if (usageChanged || toolCallsChanged) {
            yield* announce({
              _tag: "record",
              topic: "session",
              id,
              conversationId: session.conversationId,
              kind: "updated",
              countsOnly: true,
            });
          }
        }
        // Updated only after the commit: a failed transaction leaves the held
        // text and the sequence as they were. Nothing resends the frame,
        // because there is no outbox yet (spec 03 section 2.3).
        //
        // The entry is removed when the session exits and on any event after
        // that. Otherwise an event for an exited session would put the entry
        // back, and nothing would ever remove it.
        yield* afterCommit(() => {
          if (folded.status === "exited" || before === "exited") {
            tracking.delete(id);
          } else {
            tracking.set(id, folded.next);
          }
        });
        return {
          moved,
          ...(exitedHoldingInput ? { exitedHoldingInput: true as const } : {}),
          ...(claimedInput === undefined ? {} : { claimedInput }),
          ...(moved === "idle" && event._tag === "turn.completed" && claimedInput === undefined
            ? { turnEndedIdle: true as const }
            : {}),
        };
      }),

    /** Returns a page of every input this session was given, oldest first, whatever their status. */
    queryInputs: (input: InputQueryInput): Effect.Effect<InputPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("input.query");
        const { id, limit, cursor, sort } = yield* Effect.mapError(
          decodeInputQuery(input),
          createDecodeValidationError,
        );
        yield* readSession(id);
        const listing = yield* refuseCursor(
          inputs.list({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, INPUT_DIRECTION),
          }),
        );
        return toPageOutput({ ...listing, items: listing.items.map(buildInputRecord) });
      }),

    /**
     * Replaces the text of an input still waiting on its session, and its
     * images when `attachments` is given, and returns the changed input.
     * Fails with `InvalidState` when the input was already sent, delivered or
     * cancelled, or when the session answers an assistant's conversation.
     * Fails with `Validation` when an image is gone or was uploaded by
     * someone else, or when the session's runner or model cannot take images
     * (`refuseUnacceptedAttachments`).
     *
     * The input a `queued` session will start with can be changed: it is
     * still waiting, and dispatch sends whatever text it holds when it claims
     * it. Once the start claims it, it is on the wire and refused like any
     * other sent input.
     *
     * The changed input becomes the caller's: its actor is the caller's and
     * its source is `user`, even on an input a subscription created. It is
     * sent as the caller's input, images included, and the agent that
     * receives it is told the caller sent it. The images it already carries
     * stay, and a new image must have been uploaded by the caller
     * (`readClaimableAttachments`).
     */
    updateInput: (input: InputUpdate): Effect.Effect<Input, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.update");
        const { id, inputId, text, attachments } = yield* Effect.mapError(
          decodeInputUpdate(input),
          createDecodeValidationError,
        );
        yield* requireChangeableInputs(id);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const row = yield* queuedInput(id, inputId);
            const actor = yield* currentStamp;
            yield* inputs.rewrite(inputId, text, actor);
            if (attachments === undefined) {
              // The payload cannot see the stored images, so an empty text
              // that leaves the input with nothing is refused here.
              if (text.length === 0 && row.attachments.length === 0)
                return yield* Effect.fail(
                  createValidationError([{ path: ["text"], message: EMPTY_PROMPT_MESSAGE }]),
                );
              yield* announceSessionChangeById(id);
              return buildInputRecord({ ...row, source: "user", actor, text });
            }
            const references = yield* provideSql(
              readClaimableAttachments(attachments, row.attachments),
            );
            const session = yield* readSession(id);
            yield* provideAttachmentCheck(
              refuseUnacceptedAttachments({
                runnerId: session.runnerId,
                providerAccountId: session.providerAccountId,
                harnessId: session.harnessId,
                model: session.modelSelection.model,
                attachments: references,
              }),
            );
            yield* provideSql(claimAttachments(inputId, references));
            yield* announceSessionChange(session);
            return buildInputRecord({
              ...row,
              source: "user",
              actor,
              text,
              attachments: references,
            });
          }),
        );
      }),

    /**
     * Cancels an input still waiting on its session, and returns the
     * cancelled input. Fails with `InvalidState` when:
     *
     * - the input was already sent, delivered or cancelled;
     * - the session answers an assistant's conversation;
     * - the input is the one the session's start carries
     *   (`FIRST_INPUT_NOT_CANCELLABLE`). While the session is `queued`, that
     *   is its oldest waiting input, the one dispatch will claim. While it is
     *   `starting`, it is the input on the wire. A start always carries an
     *   input, so a session with that input cancelled would start with
     *   nothing to do. The user stops the session instead.
     *
     * An input the runner refused and put back to waiting while the session
     * is `starting` is an ordinary waiting input, and can be cancelled: the
     * start already went out, so the session no longer needs it.
     */
    cancelInput: (
      sessionId: Id,
      inputId: Id,
    ): Effect.Effect<Input, Exclude<InputError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("input.cancel");
        yield* requireChangeableInputs(sessionId);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Read inside the transaction, so a dispatch that starts the
            // session meanwhile cannot slip between this check and the cancel.
            const session = yield* readSession(sessionId);
            const carriedByStart =
              session.status === "queued"
                ? Option.exists(yield* inputs.oldestWaiting(sessionId), (row) => row.id === inputId)
                : session.status === "starting" &&
                  Option.exists(
                    yield* inputs.one(sessionId, inputId),
                    (row) => row.status === "queued" && row.sentAt !== null,
                  );
            if (carriedByStart) {
              return yield* Effect.fail(createInvalidStateError(FIRST_INPUT_NOT_CANCELLABLE));
            }
            const row = yield* queuedInput(sessionId, inputId);
            yield* inputs.cancel(inputId);
            yield* announceSessionChange(session);
            return buildInputRecord({ ...row, status: "cancelled" });
          }),
        );
      }),
  };
});

/**
 * The session service. It has two kinds of method, and nothing else catches a
 * method wired where the other kind belongs:
 *
 * - `query`, `read`, `transcript`, `queryPassages`, `querySubagents`,
 *   `queryInputs`, `updateInput` and `cancelInput` are operations. Each checks its own
 *   grant and decodes any input object it takes, and a route handler calls
 *   it directly.
 * - Every other method changes rows or builds a frame, and checks no grant.
 *   Only the controller daemon calls them, after checking the grant for the
 *   operation it is running. Putting one of them on a route would expose it
 *   to anyone who can reach the API.
 */
export class SessionService extends Context.Service<SessionService, Effect.Success<typeof make>>()(
  "hercule/controller/sessions/SessionService",
) {}

export const SessionServiceLayer: Layer.Layer<
  SessionService,
  never,
  | SqlClient.SqlClient
  | AuditLog
  | SessionTokens
  | PluginHost
  | SessionObserver
  | SessionEditObserver
  | WorkspaceService
  | Notifier
  | AccountUsage
> = Layer.effect(SessionService)(make);

/**
 * Ends every input that was sent but unanswered when the controller stopped.
 * An agent step's prompt is marked `sent`
 * (`inputRepository.markStrandedStepPromptsSent`), and any other input is
 * cancelled (`inputRepository.cancelStranded`). It runs once at boot, after
 * migrations and before anything is placed on a runner. It is not part of
 * building `SessionServiceLayer`, because the boot builds every layer before
 * it runs migrations, and a query against a column a fresh database does not
 * have yet would fail there.
 *
 * Returns the wake-ups lost with the cancelled inputs. Handling a lost
 * wake-up is not this domain's job: the sessions domain knows nothing about
 * subscriptions.
 */
export const endStrandedInputs: Effect.Effect<
  ReadonlyArray<LostWakeUp>,
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const inputs = yield* inputRepository;
  yield* inputs.markStrandedStepPromptsSent();
  return yield* inputs.cancelStranded(
    "the controller restarted while this input was being sent to the runner; " +
      "it is unknown whether the harness received it, so it was not sent again",
  );
});
