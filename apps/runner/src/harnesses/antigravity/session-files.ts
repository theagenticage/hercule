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
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describeFileFailure, isMissingPath, UUID_PATTERN } from "../session-files";
import { APP_DATA_DIR, readRegularFile } from "./harness-home";

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

/** The most subagents read in one session. `agy` swarms start a handful; the bound stops a runaway folder. */
const MAX_SUBAGENTS = 64;

/** The largest small file (a subagent file or a message) that is read. Real ones are a few KiB. */
const MAX_SMALL_FILE_BYTES = 256 * 1024;

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
}

/** A subagent of the session, as its files link it to the conversation that started it. */
export interface AgySubagentLink {
  readonly conversationId: string;
  readonly parentConversationId: string;
  /** The id of the parent's tool call that started the child. Missing when the launch message never showed up. */
  readonly launchToolCallId?: string;
  /** The parent's step that holds the result of that tool call. */
  readonly launchStepIndex?: number;
  readonly role?: string;
  readonly typeName?: string;
  /** What the parent told the child to do. */
  readonly brief?: string;
}

export type SessionFileObservation =
  | { readonly kind: "step"; readonly conversationId: string; readonly step: AgyStep }
  | { readonly kind: "subagent"; readonly link: AgySubagentLink }
  | { readonly kind: "unreadable"; readonly conversationId: string; readonly reason: string };

export interface SessionFiles {
  /**
   * Returns what is new in the files since the last call, in order: for each
   * conversation its steps in file order, and a child's `subagent`
   * observation before any of its steps. Never fails: a file that is not as
   * `agy` writes it becomes one `unreadable` observation for its conversation,
   * and that conversation is not read again. Calls must not overlap.
   *
   * A child's steps wait until its launch message is read. A child that has
   * steps, and whose launch message is still missing at the next call, is
   * linked from its subagent file alone.
   */
  readonly read: Effect.Effect<ReadonlyArray<SessionFileObservation>>;
}

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

const ToolCall = Schema.Struct({
  name: Schema.String,
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

/** The fields of a transcript line that are read. Other fields, and values of other kinds in them, are ignored. */
const TranscriptLine = Schema.Struct({
  step_index: Schema.Finite,
  type: Schema.String,
  status: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Unknown),
  tool_calls: Schema.optionalKey(Schema.Array(ToolCall)),
  model: Schema.optionalKey(Schema.String),
  input_tokens: Schema.optionalKey(Schema.Finite),
  cache_read_tokens: Schema.optionalKey(Schema.Finite),
  output_tokens: Schema.optionalKey(Schema.Finite),
});
const decodeTranscriptLine = Schema.decodeUnknownResult(TranscriptLine);

const SubagentFile = Schema.Struct({
  subagentDescriptor: Schema.optionalKey(
    Schema.Struct({
      typeName: Schema.optionalKey(Schema.String),
      role: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeSubagentFile = Schema.decodeUnknownResult(SubagentFile);

const MessageFile = Schema.Struct({
  sender: Schema.optionalKey(Schema.String),
  sourceMetadata: Schema.optionalKey(
    Schema.Struct({
      tool: Schema.optionalKey(
        Schema.Struct({
          stepIndex: Schema.optionalKey(Schema.Finite),
          toolCall: Schema.optionalKey(
            Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              argumentsJson: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
});
const decodeMessageFile = Schema.decodeUnknownResult(MessageFile);

const decodeLaunchArguments = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ Prompt: Schema.optionalKey(Schema.String) })),
);

/** The tools of a parent conversation whose call starts a subagent. */
export const LAUNCH_TOOL_NAMES: ReadonlyArray<string> = ["invoke_subagent", "swarm"];

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
  isAnnounced: boolean;
  /** Steps read but not yet returned, because the child is not announced. */
  held: Array<AgyStep>;
  /** True once a call found the child with steps and without a launch message. The next call gives up waiting. */
  hasWaitedForLaunch: boolean;
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
  isAnnounced: false,
  held: [],
  hasWaitedForLaunch: false,
  role: undefined,
  typeName: undefined,
  hasReadSubagentFile: false,
  launch: undefined,
  readMessages: new Set(),
});

/** Returns the step a transcript line records. */
const buildStep = (line: Schema.Schema.Type<typeof TranscriptLine>): AgyStep => {
  const error = line.error;
  return {
    index: line.step_index,
    type: line.type,
    ...(line.status === undefined ? {} : { status: line.status }),
    ...(line.content === undefined ? {} : { content: line.content }),
    ...(line.thinking === undefined ? {} : { thinking: line.thinking }),
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
    ...(line.model === undefined ? {} : { model: line.model }),
    // A step with some of the three counts missing has no usage: a missing count is not taken to be zero.
    ...(line.input_tokens !== undefined &&
    line.cache_read_tokens !== undefined &&
    line.output_tokens !== undefined
      ? {
          usage: {
            inputTokens: line.input_tokens,
            cacheReadTokens: line.cache_read_tokens,
            outputTokens: line.output_tokens,
          },
        }
      : {}),
  };
};

const buildLink = (conversation: Conversation, parentId: string): AgySubagentLink => ({
  conversationId: conversation.id,
  parentConversationId: parentId,
  ...(conversation.launch === undefined
    ? {}
    : { launchToolCallId: conversation.launch.toolCallId }),
  ...(conversation.launch?.stepIndex === undefined
    ? {}
    : { launchStepIndex: conversation.launch.stepIndex }),
  ...(conversation.role === undefined ? {} : { role: conversation.role }),
  ...(conversation.typeName === undefined ? {} : { typeName: conversation.typeName }),
  ...(conversation.launch?.brief === undefined ? {} : { brief: conversation.launch.brief }),
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
export const openSessionFiles = (input: {
  readonly home: string;
  readonly conversationId: string;
  readonly skipExisting: boolean;
}): Effect.Effect<SessionFiles> => {
  const { home, skipExisting } = input;
  const root = buildConversation(input.conversationId, undefined, false);
  const conversations = new Map<string, Conversation>([[root.id, root]]);
  // Conversations in the order they were found, so that a parent is read before its children.
  const order: Array<Conversation> = [root];
  let childCount = 0;

  const buildConversationFolder = (base: string, conversation: Conversation): string =>
    join(base, conversation.id, ".system_generated");

  const addChild = (id: string, parentId: string, isDormant: boolean): Conversation => {
    const child = buildConversation(id, parentId, isDormant);
    conversations.set(id, child);
    order.push(child);
    childCount += 1;
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
    if (length - (end + 1) > MAX_LINE_BYTES)
      throw new Error("the transcript has a line that is too long");
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
      child.role = file.success.subagentDescriptor?.role;
      child.typeName = file.success.subagentDescriptor?.typeName;
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
        call === undefined ||
        !LAUNCH_TOOL_NAMES.includes(call.name)
      ) {
        continue;
      }
      const launchArguments =
        call.argumentsJson === undefined ? undefined : decodeLaunchArguments(call.argumentsJson);
      child.launch = {
        toolCallId: call.id,
        stepIndex: tool?.stepIndex,
        brief: launchArguments?._tag === "Success" ? launchArguments.success.Prompt : undefined,
      };
      return;
    }
  };

  /** Returns the steps of `conversation` that may be returned now, announcing a child first when it is time. */
  const releaseSteps = async (
    base: string,
    conversation: Conversation,
    out: Array<SessionFileObservation>,
  ): Promise<void> => {
    const parentId = conversation.parentId;
    if (parentId !== undefined && !conversation.isAnnounced) {
      const hasSteps = conversation.held.length > 0;
      if (conversation.isDormant && !hasSteps) return;
      await readSubagentFile(base, conversation);
      await findLaunchMessage(base, conversation);
      if (conversation.launch === undefined) {
        if (!hasSteps) return;
        if (!conversation.hasWaitedForLaunch) {
          conversation.hasWaitedForLaunch = true;
          return;
        }
      }
      out.push({ kind: "subagent", link: buildLink(conversation, parentId) });
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

  /** Adds each subagent registered in `<conversation>/subagents/` that is not known yet. */
  const discoverSubagents = async (
    base: string,
    conversation: Conversation,
    out: Array<SessionFileObservation>,
  ): Promise<void> => {
    for (const id of await listSubagentIds(base, conversation)) {
      if (conversations.has(id)) continue;
      if (childCount >= MAX_SUBAGENTS) {
        const extra = buildConversation(id, conversation.id, false);
        extra.isUnreadable = true;
        conversations.set(id, extra);
        out.push({
          kind: "unreadable",
          conversationId: id,
          reason: `the session already has ${MAX_SUBAGENTS} subagents, which is the most that are read`,
        });
        continue;
      }
      addChild(id, conversation.id, false);
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
        if (conversations.has(id) || childCount >= MAX_SUBAGENTS) continue;
        await skipExistingFiles(base, addChild(id, conversation.id, true));
      }
    } catch {
      // `read` reports a subagents folder it cannot read.
    }
  };

  const readAll = async (): Promise<ReadonlyArray<SessionFileObservation>> => {
    const out: Array<SessionFileObservation> = [];
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
      return out;
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
      try {
        await releaseSteps(base, conversation, out);
        if (failure === undefined) await discoverSubagents(base, conversation, out);
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
    return out;
  };

  return Effect.promise(async () => {
    if (skipExisting) {
      try {
        await skipExistingFiles(join(await realpath(home), APP_DATA_DIR, "brain"), root);
      } catch {
        // The Harness Home does not exist yet, so nothing exists to skip.
      }
    }
    return { read: Effect.promise(readAll) };
  });
};
