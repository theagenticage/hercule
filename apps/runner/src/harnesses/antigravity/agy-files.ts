/**
 * The one place that knows where Google's `agy` keeps the files of a
 * conversation and what is in them. It only reads. It turns what is new in
 * the files into observations; it does not decide when to read (the session
 * calls `read` while a turn is open) and it makes no events (the normalizers
 * do).
 *
 * What it reads, for each conversation, below
 * `<home>/antigravity-acp/brain/<conversation id>/.system_generated/`:
 *
 * - `logs/transcript.jsonl`: one JSON object per finished step, appended and
 *   never rewritten.
 * - `subagents/<child id>.json`: one file per subagent the conversation
 *   started. Its `state` never changes, so it is not read.
 * - The child's own `messages/<uuid>.json`: the launch message that the
 *   parent sent, which names the parent's tool call that started the child.
 *
 * A child has the same folder layout as the conversation that started it, and
 * can start children of its own.
 *
 * Every path is checked without following links, like `harness-home.ts`. This
 * guards against stale or misplaced links only, not against another process
 * that swaps paths while this code runs.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describeFileFailure, isMissingPath, UUID_PATTERN } from "../session-files";
import { APP_DATA_DIR, readRegularFile } from "./harness-home";
import { LAUNCH_TOOL_NAME } from "./tool-items";

/**
 * The longest line of a transcript that is read. Past it the transcript is
 * unreadable. Steps hold tool output, which `agy` already truncates, so a real
 * line is far below this.
 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * The most new bytes read from one transcript in one call. The rest waits for
 * the next call, so a huge transcript cannot stall the session in one read.
 * It is twice `MAX_LINE_BYTES` so that a window with no line end in it is
 * either the end of the file or a line that is too long.
 */
const MAX_BYTES_PER_READ = 2 * MAX_LINE_BYTES;

/** The most subagents read in one session. Only a subagent that has produced a step counts. `agy` swarms start a handful; the bound stops a runaway folder. */
const MAX_SUBAGENTS = 64;

/** The largest small file (a subagent file or a message) that is read. Real ones are a few KiB. */
const MAX_SMALL_FILE_BYTES = 256 * 1024;

/**
 * How long a subagent may have steps without a launch message before it is
 * reported unreadable. `agy` writes the launch message with the subagent's
 * first work, so a message that is still missing after this is not coming.
 */
const LAUNCH_MESSAGE_WAIT_MS = 2000;

/** One step of an `agy` conversation, as its transcript records it. */
export interface AgyStep {
  /** The step's number in the conversation. Numbers can skip. */
  readonly index: number;
  /** `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `SYSTEM_MESSAGE`, `ERROR_MESSAGE`, or any other value `agy` writes. */
  readonly type: string;
  /** `DONE`, `RUNNING`, `ERROR`, or any other value `agy` writes. */
  readonly status?: string;
  readonly content?: string;
  readonly thinking?: string;
  /** The `error` field, as text. */
  readonly error?: string;
  /** Each argument is decoded from the JSON text `agy` writes, or kept as that text when it is not JSON. */
  readonly toolCalls: ReadonlyArray<{
    readonly name: string;
    readonly args: Record<string, unknown>;
  }>;
  readonly model?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly outputTokens: number;
  };
  /**
   * True on a `PLANNER_RESPONSE` whose three token counts are not all present
   * as non-negative integers. Such a step has no `usage`, and the total of
   * its conversation is then known to be incomplete.
   */
  readonly hasInvalidUsage?: true;
}

/** A subagent of the session, as its files link it to the conversation that started it. */
export interface AgySubagentLink {
  readonly conversationId: string;
  readonly parentConversationId: string;
  /** The id of the parent's tool call that started the child, from the launch message. */
  readonly launchToolCallId: string;
  /** The parent's step that holds the result of that tool call. */
  readonly launchStepIndex?: number;
  readonly role?: string;
  readonly typeName?: string;
  /** What the parent told the child to do. */
  readonly brief?: string;
}

export type AgyFileObservation =
  | { readonly kind: "step"; readonly conversationId: string; readonly step: AgyStep }
  | { readonly kind: "subagent"; readonly link: AgySubagentLink }
  | { readonly kind: "unreadable"; readonly conversationId: string; readonly reason: string };

/** What one call of `AgyFiles.read` returns. */
export interface AgyFilesRead {
  readonly observations: ReadonlyArray<AgyFileObservation>;
  /**
   * True while the reader holds the steps of a subagent that it has not
   * announced yet, and will announce or report by itself within
   * `LAUNCH_MESSAGE_WAIT_MS`. The caller keeps calling `read` while it is true,
   * even when no work is open.
   */
  readonly isAwaitingLink: boolean;
}

export interface AgyFiles {
  /**
   * Returns what is new in the files since the last call, in order: for each
   * conversation its steps in file order, and a child's `subagent`
   * observation before any of its steps, and whether it still awaits a link
   * (see `AgyFilesRead`). Never fails: a file that is not as
   * `agy` writes it becomes one `unreadable` observation for its conversation,
   * and that conversation is not read again. Calls must not overlap.
   *
   * A child is linked only by its launch message, and only after its parent
   * is announced (the session's own conversation counts as announced). Its
   * steps wait until then. A child that has had steps for 2 seconds without a
   * launch message becomes one `unreadable` observation.
   *
   * A child whose parent is a subagent is also announced only after its
   * parent's transcript was read up to the step that holds the result of the
   * launch call, so that the parent's launch item is known. After
   * `LAUNCH_MESSAGE_WAIT_MS` of waiting for that step it is announced without
   * the step's number.
   */
  readonly read: Effect.Effect<AgyFilesRead>;
}

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/** An optional field whose value may also be `null`, which is read as absent. */
const optionalOrNull = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

const ToolCall = Schema.Struct({
  name: Schema.String,
  args: optionalOrNull(Schema.Record(Schema.String, Schema.Unknown)),
});

/** The fields of a transcript line that are read. Other fields, and values of other kinds in them, are ignored. */
const TranscriptLine = Schema.Struct({
  step_index: Schema.Finite,
  type: Schema.String,
  status: optionalOrNull(Schema.String),
  content: optionalOrNull(Schema.String),
  thinking: optionalOrNull(Schema.String),
  error: Schema.optionalKey(Schema.Unknown),
  tool_calls: optionalOrNull(Schema.Array(ToolCall)),
  model: optionalOrNull(Schema.String),
  // Read as any value: a count that is not a non-negative integer must not make the whole line unreadable.
  input_tokens: Schema.optionalKey(Schema.Unknown),
  cache_read_tokens: Schema.optionalKey(Schema.Unknown),
  output_tokens: Schema.optionalKey(Schema.Unknown),
});
const decodeTranscriptLine = Schema.decodeUnknownResult(TranscriptLine);

const SubagentFile = Schema.Struct({
  subagentDescriptor: optionalOrNull(
    Schema.Struct({
      typeName: optionalOrNull(Schema.String),
      role: optionalOrNull(Schema.String),
    }),
  ),
});
const decodeSubagentFile = Schema.decodeUnknownResult(SubagentFile);

const MessageFile = Schema.Struct({
  sender: optionalOrNull(Schema.String),
  sourceMetadata: optionalOrNull(
    Schema.Struct({
      tool: optionalOrNull(
        Schema.Struct({
          stepIndex: optionalOrNull(Schema.Finite),
          toolCall: optionalOrNull(
            Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              argumentsJson: optionalOrNull(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
});
const decodeMessageFile = Schema.decodeUnknownResult(MessageFile);

const decodeLaunchArguments = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ Prompt: optionalOrNull(Schema.String) })),
);

const NEWLINE = 0x0a;

/** What is known of one conversation between two calls of `read`. */
interface Conversation {
  readonly id: string;
  /** Undefined for the session's own conversation. */
  readonly parentId: string | undefined;
  /** Where the next unread line starts in the transcript. */
  offset: number;
  /** The inode of the transcript, set when it is first seen. A different one later means it was replaced. */
  inode: number | undefined;
  isUnreadable: boolean;
  /** True for a child that existed when a resumed session opened: it is announced only once it has a new step. */
  isDormant: boolean;
  /** True once the child is announced. The session's own conversation is announced from the start. */
  isAnnounced: boolean;
  /** True once the child has produced a step and so counts toward `MAX_SUBAGENTS`. */
  isCounted: boolean;
  /** Steps read but not yet returned, because the child is not announced. */
  held: Array<AgyStep>;
  /** When the child first had a step that waited for its launch message, on Effect's clock, in milliseconds. */
  waitingSince: number | undefined;
  /** When the child first waited for its parent's transcript to reach the launch step, on the same clock. */
  parentStepWaitingSince: number | undefined;
  /** The highest step number read from this conversation's transcript. */
  lastStepIndex: number | undefined;
  /** How many calls to the launch tool the steps of this conversation hold. */
  launchCallCount: number;
  /** How many new subagents were found in this conversation's `subagents/` folder. Subagents known at a resume are not new. */
  newSubagentCount: number;
  role: string | undefined;
  typeName: string | undefined;
  hasReadSubagentFile: boolean;
  launch:
    | { toolCallId: string; stepIndex: number | undefined; brief: string | undefined }
    | undefined;
  /** The message files that were read and are not the launch, so that each is read once. */
  readMessages: Set<string>;
}

const buildConversation = (
  id: string,
  parentId: string | undefined,
  isDormant: boolean,
): Conversation => ({
  id,
  parentId,
  offset: 0,
  inode: undefined,
  isUnreadable: false,
  isDormant,
  isAnnounced: parentId === undefined,
  isCounted: false,
  held: [],
  waitingSince: undefined,
  parentStepWaitingSince: undefined,
  lastStepIndex: undefined,
  launchCallCount: 0,
  newSubagentCount: 0,
  role: undefined,
  typeName: undefined,
  hasReadSubagentFile: false,
  launch: undefined,
  readMessages: new Set(),
});

/** Returns `value` when it is a non-negative integer, else undefined. */
const readTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Returns the text of the error a step records: the first non-empty of its
 * `error` and its `content`, or undefined when both are empty or missing.
 */
export const readStepErrorText = (step: AgyStep): string | undefined =>
  [step.error, step.content].find((text) => text !== undefined && text !== "");

/** What the transcript of the session's own conversation tells the running Turn. */
export type RootConversationFact =
  /** `agy` wrote a prompt of the user. */
  | { readonly kind: "input" }
  /** `agy` wrote the error of the model service, in `words`. */
  | { readonly kind: "provider-error"; readonly words: string };

/**
 * Returns the fact that a step of the session's own conversation tells the
 * Turn: `input` for a `USER_INPUT` step, `provider-error` for an
 * `ERROR_MESSAGE` step with error text. Returns undefined for any other step.
 */
export const readRootConversationFact = (step: AgyStep): RootConversationFact | undefined => {
  if (step.type === "USER_INPUT") return { kind: "input" };
  if (step.type !== "ERROR_MESSAGE") return undefined;
  const words = readStepErrorText(step);
  return words === undefined ? undefined : { kind: "provider-error", words };
};

/** Returns the step a transcript line records. */
const buildStep = (line: Schema.Schema.Type<typeof TranscriptLine>): AgyStep => {
  const error = line.error;
  const inputTokens = readTokenCount(line.input_tokens);
  const cacheReadTokens = readTokenCount(line.cache_read_tokens);
  const outputTokens = readTokenCount(line.output_tokens);
  const hasUsage =
    inputTokens !== undefined && cacheReadTokens !== undefined && outputTokens !== undefined;
  return {
    index: line.step_index,
    type: line.type,
    ...(line.status == null ? {} : { status: line.status }),
    ...(line.content == null ? {} : { content: line.content }),
    ...(line.thinking == null ? {} : { thinking: line.thinking }),
    ...(error === undefined || error === null
      ? {}
      : { error: typeof error === "string" ? error : JSON.stringify(error) }),
    toolCalls: (line.tool_calls ?? []).map((call) => ({
      name: call.name,
      args: Object.fromEntries(
        Object.entries(call.args ?? {}).map(([key, value]) => {
          if (typeof value !== "string") return [key, value];
          const decoded = decodeJson(value);
          return [key, decoded._tag === "Success" ? decoded.success : value];
        }),
      ),
    })),
    ...(line.model == null ? {} : { model: line.model }),
    // A step with a count that is missing or not valid has no usage: such a count is not taken to be zero.
    ...(hasUsage ? { usage: { inputTokens, cacheReadTokens, outputTokens } } : {}),
    ...(!hasUsage && line.type === "PLANNER_RESPONSE" ? { hasInvalidUsage: true as const } : {}),
  };
};

const buildLink = (
  conversation: Conversation,
  parentId: string,
  launch: NonNullable<Conversation["launch"]>,
): AgySubagentLink => ({
  conversationId: conversation.id,
  parentConversationId: parentId,
  launchToolCallId: launch.toolCallId,
  ...(launch.stepIndex === undefined ? {} : { launchStepIndex: launch.stepIndex }),
  ...(conversation.role === undefined ? {} : { role: conversation.role }),
  ...(conversation.typeName === undefined ? {} : { typeName: conversation.typeName }),
  ...(launch.brief === undefined ? {} : { brief: launch.brief }),
});

/**
 * Returns the reader for the conversation `conversationId` in the Harness Home
 * `home`. Never fails. Nothing is read until `read` is called, except when
 * `skipExisting` is true (a resumed session): then every transcript that
 * exists now is marked as read up to its current end, and the subagents that
 * exist now are known but announced only when they produce a new step. That
 * scan runs when this effect runs, so the caller must run it before it sends
 * its first prompt: a scan at the first `read` would mistake the first steps
 * of the new turn for old ones. It assumes the existing transcripts end at a
 * line end, which holds between turns.
 */
export const openAgyFiles = (input: {
  readonly home: string;
  readonly conversationId: string;
  readonly skipExisting: boolean;
}): Effect.Effect<AgyFiles> => {
  const { home, skipExisting } = input;
  const root = buildConversation(input.conversationId, undefined, false);
  const conversations = new Map<string, Conversation>([[root.id, root]]);
  // Conversations in the order they were found, so that a parent is read before its children.
  const order: Array<Conversation> = [root];
  // Subagents that have produced a step. A subagent with none costs one file check per call and does not count.
  let countedChildren = 0;

  const buildConversationFolder = (base: string, conversation: Conversation): string =>
    join(base, conversation.id, ".system_generated");

  const addChild = (id: string, parentId: string, isDormant: boolean): Conversation => {
    const child = buildConversation(id, parentId, isDormant);
    conversations.set(id, child);
    order.push(child);
    return child;
  };

  /** Fails with an error naming the cause when `path`, or a folder above it below the home, is a link. */
  const requireNoLinks = async (path: string): Promise<void> => {
    if ((await realpath(path)) !== path) throw new Error("it is a link, or is inside one");
  };

  /**
   * Reads the lines appended to the transcript since the last call, into
   * `fresh`. Fails with the reason the transcript is unreadable. Lines read
   * before the failing one are already in `fresh`.
   */
  const collectNewSteps = async (
    conversation: Conversation,
    folder: string,
    fresh: Array<AgyStep>,
  ): Promise<void> => {
    const logs = join(folder, "logs");
    const path = join(logs, "transcript.jsonl");
    let info;
    try {
      await requireNoLinks(logs);
      info = await lstat(path);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("the transcript is a link");
    if (!info.isFile()) throw new Error("the transcript is not a regular file");
    if (conversation.inode !== undefined && conversation.inode !== info.ino) {
      throw new Error("the transcript was replaced by another file");
    }
    conversation.inode = info.ino;
    if (info.size < conversation.offset) throw new Error("the transcript got shorter");
    if (info.size === conversation.offset) return;

    const window = Buffer.alloc(Math.min(info.size - conversation.offset, MAX_BYTES_PER_READ));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let length = 0;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== info.ino) {
        throw new Error("the transcript was replaced by another file");
      }
      while (length < window.length) {
        const { bytesRead } = await file.read(
          window,
          length,
          window.length - length,
          conversation.offset + length,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
    } finally {
      await file.close();
    }

    // The bytes after the last line end are a line `agy` has not finished writing. They are read again next call.
    const end = window.subarray(0, length).lastIndexOf(NEWLINE);
    let lineStart = 0;
    while (lineStart <= end) {
      const lineEnd = window.indexOf(NEWLINE, lineStart);
      if (lineEnd - lineStart > MAX_LINE_BYTES) {
        throw new Error("the transcript has a line that is too long");
      }
      const json = decodeJson(window.toString("utf8", lineStart, lineEnd));
      if (json._tag === "Failure") throw new Error("the transcript has a line that is not JSON");
      const line = decodeTranscriptLine(json.success);
      if (line._tag === "Failure") {
        throw new Error(
          "the transcript has a line that is not a step: it needs a numeric step_index and a type",
        );
      }
      fresh.push(buildStep(line.success));
      // Each line counts as read as soon as it is a step, so a later bad line does not lose it.
      conversation.offset += lineEnd + 1 - lineStart;
      lineStart = lineEnd + 1;
    }
    // Checked after the complete lines, so that a tail that is too long does not lose the lines before it.
    if (length - (end + 1) > MAX_LINE_BYTES) {
      throw new Error("the transcript has a line that is too long");
    }
  };

  /** Reads the subagent file that links `child` to its parent, once. A file that is missing or not decodable yet is tried again next call. */
  const readSubagentFile = async (base: string, child: Conversation): Promise<void> => {
    if (child.hasReadSubagentFile || child.parentId === undefined) return;
    const parent = conversations.get(child.parentId);
    if (parent === undefined) return;
    try {
      const { text, isTruncated } = await readRegularFile(
        join(buildConversationFolder(base, parent), "subagents", `${child.id}.json`),
        MAX_SMALL_FILE_BYTES,
      );
      const json = decodeJson(text);
      if (isTruncated || json._tag === "Failure") return;
      const file = decodeSubagentFile(json.success);
      if (file._tag === "Failure") return;
      child.role = file.success.subagentDescriptor?.role ?? undefined;
      child.typeName = file.success.subagentDescriptor?.typeName ?? undefined;
      child.hasReadSubagentFile = true;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  };

  /**
   * Looks in the child's `messages/` folder for the message in which its
   * parent started it, reading each message file once. A missing folder is the
   * child that is not written yet; a message that is not JSON yet is read again
   * next call.
   */
  const findLaunchMessage = async (base: string, child: Conversation): Promise<void> => {
    if (child.launch !== undefined || child.parentId === undefined) return;
    const folder = join(buildConversationFolder(base, child), "messages");
    let names: ReadonlyArray<string>;
    try {
      await requireNoLinks(folder);
      names = await readdir(folder);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
    for (const name of names.filter((n) => n.endsWith(".json") && n !== "read.json").sort()) {
      if (child.readMessages.has(name)) continue;
      let text: string;
      let isTruncated: boolean;
      try {
        ({ text, isTruncated } = await readRegularFile(join(folder, name), MAX_SMALL_FILE_BYTES));
      } catch (error) {
        if (isMissingPath(error)) continue;
        throw error;
      }
      const json = decodeJson(text);
      if (!isTruncated && json._tag === "Failure") continue;
      child.readMessages.add(name);
      if (isTruncated || json._tag === "Failure") continue;
      const message = decodeMessageFile(json.success);
      if (message._tag === "Failure") continue;
      const tool = message.success.sourceMetadata?.tool;
      const call = tool?.toolCall;
      if (
        message.success.sender !== child.parentId ||
        call == null ||
        call.name !== LAUNCH_TOOL_NAME
      ) {
        continue;
      }
      const launchArguments =
        call.argumentsJson == null ? undefined : decodeLaunchArguments(call.argumentsJson);
      child.launch = {
        toolCallId: call.id,
        stepIndex: tool?.stepIndex ?? undefined,
        brief:
          launchArguments?._tag === "Success"
            ? (launchArguments.success.Prompt ?? undefined)
            : undefined,
      };
      return;
    }
  };

  /**
   * Returns the steps of `conversation` that may be returned now, announcing a
   * child first when it is time. A child waits while it is dormant, while its
   * parent is not announced, while its launch message is missing, and, when its
   * parent is a subagent, while the parent's transcript has not reached the
   * launch step (for at most `LAUNCH_MESSAGE_WAIT_MS`, then it is announced
   * without the launch step). Fails
   * when the parent can never be announced, or when the launch message is
   * still missing `LAUNCH_MESSAGE_WAIT_MS` after the child's first step.
   * `now` is the time of this read on Effect's clock, in milliseconds.
   */
  const releaseSteps = async (
    base: string,
    conversation: Conversation,
    out: Array<AgyFileObservation>,
    now: number,
  ): Promise<void> => {
    const parentId = conversation.parentId;
    if (parentId !== undefined && !conversation.isAnnounced) {
      const hasSteps = conversation.held.length > 0;
      if (conversation.isDormant && !hasSteps) return;
      const parent = conversations.get(parentId);
      if (parent?.isUnreadable === true) {
        throw new Error("its parent subagent is unreadable, so this one was never announced");
      }
      if (parent?.isAnnounced !== true) return;
      await readSubagentFile(base, conversation);
      await findLaunchMessage(base, conversation);
      const launch = conversation.launch;
      if (launch === undefined) {
        if (!hasSteps) return;
        conversation.waitingSince ??= now;
        if (now - conversation.waitingSince >= LAUNCH_MESSAGE_WAIT_MS) {
          throw new Error("agy wrote no launch message for this subagent");
        }
        return;
      }
      // The session's own conversation has its launch items from ACP, so only a parent that is a subagent needs its transcript read up to the launch step.
      let stepIndex = launch.stepIndex;
      if (
        stepIndex !== undefined &&
        parent.parentId !== undefined &&
        (parent.lastStepIndex ?? -1) < stepIndex
      ) {
        conversation.parentStepWaitingSince ??= now;
        if (now - conversation.parentStepWaitingSince < LAUNCH_MESSAGE_WAIT_MS) return;
        stepIndex = undefined;
      }
      out.push({
        kind: "subagent",
        link: buildLink(conversation, parentId, { ...launch, stepIndex }),
      });
      conversation.isAnnounced = true;
    }
    for (const step of conversation.held) {
      out.push({ kind: "step", conversationId: conversation.id, step });
    }
    conversation.held = [];
  };

  /** Returns the ids of the subagents registered in `<conversation>/subagents/`, sorted. None when the folder is missing. */
  const listSubagentIds = async (
    base: string,
    conversation: Conversation,
  ): Promise<ReadonlyArray<string>> => {
    const folder = join(buildConversationFolder(base, conversation), "subagents");
    try {
      await requireNoLinks(folder);
      const names = await readdir(folder);
      return names
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .filter((id) => UUID_PATTERN.test(id))
        .sort();
    } catch (error) {
      if (isMissingPath(error)) return [];
      throw error;
    }
  };

  /**
   * Adds each subagent registered in `<conversation>/subagents/` that is not
   * known yet. The session's own conversation is listed on every call, because
   * `agy` can register a subagent without a launch call (for example `/swarm`).
   * The folder of a child is listed only while it has started more subagents
   * (calls to the launch tool) than were found so far, so a child that
   * started none costs no listing.
   */
  const discoverSubagents = async (base: string, conversation: Conversation): Promise<void> => {
    if (
      conversation.parentId !== undefined &&
      conversation.newSubagentCount >= conversation.launchCallCount
    ) {
      return;
    }
    for (const id of await listSubagentIds(base, conversation)) {
      if (conversations.has(id)) continue;
      addChild(id, conversation.id, false);
      conversation.newSubagentCount += 1;
    }
  };

  /**
   * Marks the transcript of `conversation` as read up to its current end, and
   * does the same for every subagent below it, each of them dormant. A file
   * that is a link or cannot be read is left alone: `read` reports it.
   */
  const skipExistingFiles = async (base: string, conversation: Conversation): Promise<void> => {
    const logs = join(buildConversationFolder(base, conversation), "logs");
    try {
      await requireNoLinks(logs);
      const info = await lstat(join(logs, "transcript.jsonl"));
      if (info.isFile()) {
        conversation.offset = info.size;
        conversation.inode = info.ino;
      }
    } catch {
      // Nothing to skip.
    }
    try {
      for (const id of await listSubagentIds(base, conversation)) {
        if (conversations.has(id)) continue;
        await skipExistingFiles(base, addChild(id, conversation.id, true));
      }
    } catch {
      // `read` reports a subagents folder it cannot read.
    }
  };

  const readAll = async (now: number): Promise<AgyFilesRead> => {
    const out: Array<AgyFileObservation> = [];
    let base: string;
    try {
      base = join(await realpath(home), APP_DATA_DIR, "brain");
    } catch (error) {
      if (!isMissingPath(error)) {
        root.isUnreadable = true;
        out.push({
          kind: "unreadable",
          conversationId: root.id,
          reason: describeFileFailure(error),
        });
      }
      return { observations: out, isAwaitingLink: false };
    }
    // `order` grows while it is walked: a child found in this call is read in this call.
    for (let at = 0; at < order.length; at += 1) {
      const conversation = order[at];
      if (conversation === undefined || conversation.isUnreadable) continue;
      let failure: unknown;
      const fresh: Array<AgyStep> = [];
      try {
        await collectNewSteps(conversation, buildConversationFolder(base, conversation), fresh);
      } catch (error) {
        failure = error;
      }
      // The lines read before a failure are still returned, so they are not lost.
      if (fresh.length > 0) conversation.isDormant = false;
      conversation.held.push(...fresh);
      for (const step of fresh) {
        conversation.lastStepIndex = Math.max(conversation.lastStepIndex ?? step.index, step.index);
      }
      conversation.launchCallCount += fresh.reduce(
        (total, step) => total + step.toolCalls.filter((c) => c.name === LAUNCH_TOOL_NAME).length,
        0,
      );
      try {
        if (fresh.length > 0 && conversation.parentId !== undefined && !conversation.isCounted) {
          if (countedChildren >= MAX_SUBAGENTS) {
            throw new Error(
              `the session already has ${MAX_SUBAGENTS} subagents, which is the most that are read`,
            );
          }
          conversation.isCounted = true;
          countedChildren += 1;
        }
        await releaseSteps(base, conversation, out, now);
        if (failure === undefined) await discoverSubagents(base, conversation);
      } catch (error) {
        failure = failure ?? error;
      }
      if (failure !== undefined) {
        conversation.isUnreadable = true;
        conversation.held = [];
        out.push({
          kind: "unreadable",
          conversationId: conversation.id,
          reason: describeFileFailure(failure),
        });
      }
    }
    // A child with held steps is announced, or reported unreadable, within the wait.
    const isAwaitingLink = order.some(
      (conversation) =>
        !conversation.isUnreadable && !conversation.isAnnounced && conversation.held.length > 0,
    );
    return { observations: out, isAwaitingLink };
  };

  return Effect.promise(async () => {
    if (skipExisting) {
      try {
        await skipExistingFiles(join(await realpath(home), APP_DATA_DIR, "brain"), root);
      } catch {
        // The Harness Home does not exist yet, so nothing exists to skip.
      }
    }
    return {
      read: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.promise(() => readAll(now));
      }),
    };
  });
};
