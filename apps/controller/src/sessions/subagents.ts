/**
 * Works out what one reported event does to a session's subagent records
 * (spec 02 Subagent, spec 06 section 13.2). The code is pure: the service
 * reads the records an event names, passes each through
 * `computeSubagentAfter`, and writes back the ones that changed, in the
 * transaction that appends the event.
 *
 * A record is filled from several events, and a resumed process may know
 * less than an earlier one. So the introduction, `subagent.started`, fills a
 * field only while it is empty and never overwrites one.
 */
import type { ItemKind, ProviderEvent, SubagentId, Usage } from "@hercule/protocol";
import type { Subagent, SubagentStatus } from "@hercule/contract";
import { attributeEvent } from "./stream";
import { addUsageSnapshot } from "./usage";

/**
 * A subagent record as stored. Absent fields are `undefined` rather than
 * missing, and `usageProcess` is the current process's last usage snapshot,
 * which `addUsageSnapshot` needs and the API never shows.
 */
export interface StoredSubagent {
  readonly sessionId: string;
  readonly id: SubagentId;
  readonly parentSubagentId: SubagentId | undefined;
  readonly itemId: string | undefined;
  readonly description: string | undefined;
  readonly agentType: string | undefined;
  readonly model: string | undefined;
  readonly status: SubagentStatus;
  readonly toolCalls: number;
  readonly activity: string | undefined;
  readonly result: string | undefined;
  readonly usage: Usage | undefined;
  readonly usageProcess: Usage | undefined;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
}

/**
 * The longest `description`, `activity` or `result` line kept. Each is shown
 * as one line in a list row, and the full text is in the transcript.
 */
const MAX_LINE_LENGTH = 200;

/** The item kinds that count as tool calls in `toolCalls`. */
const TOOL_CALL_KINDS: ReadonlySet<ItemKind> = new Set([
  "command_execution",
  "file_change",
  "tool_call",
  "web_search",
  "subagent",
]);

/** The words `activity` starts with for each item kind. */
const ACTIVITY_VERBS: Readonly<Record<ItemKind, string>> = {
  user_message: "Reading its brief",
  assistant_message: "Writing",
  reasoning: "Thinking",
  command_execution: "Running",
  file_change: "Editing",
  tool_call: "Using",
  web_search: "Searching",
  subagent: "Delegating",
  plan: "Planning",
  context_compaction: "Compacting its context",
  error: "Reporting an error",
  unknown: "Working",
};

/**
 * Returns the first line of `text`, at most `MAX_LINE_LENGTH` characters and
 * ending in an ellipsis when it was cut. Returns `undefined` when the first
 * line is blank, so a record never stores an empty line.
 */
const readFirstLine = (text: string): string | undefined => {
  const line = (text.trimStart().split("\n")[0] ?? "").trimEnd();
  if (line === "") return undefined;
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line;
};

/** Returns an item's `detail` as an object, or an empty one when it is not an object. */
const readDetail = (detail: unknown): Readonly<Record<string, unknown>> =>
  typeof detail === "object" && detail !== null && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};

/**
 * Returns the part of an item's `detail` worth naming in `activity`: the
 * command, the path, the search, the tool's name or its description. Each
 * adapter shapes `detail` its own way, so each field is optional.
 */
const findDetailTarget = (detail: unknown): string | undefined => {
  const fields = readDetail(detail);
  const candidate = [fields.command, fields.path, fields.description, fields.name].find(
    (value) => typeof value === "string",
  );
  return candidate;
};

/** Builds the one line that says what a subagent is doing now, from the item it just started. */
export const buildSubagentActivity = (kind: ItemKind, detail: unknown): string => {
  const verb = ACTIVITY_VERBS[kind];
  const target = findDetailTarget(detail);
  const line = target === undefined ? undefined : readFirstLine(`${verb} ${target}`);
  return line ?? verb;
};

/** Converts a turn's ending into the status a subagent shows after it. */
const toEndedStatus = (state: "completed" | "failed" | "interrupted"): SubagentStatus =>
  state === "interrupted" ? "stopped" : state;

/**
 * Builds the record of a subagent the controller has not heard of yet: only
 * its id, `running`, and `startedAt` set to the event that named it. A later
 * `subagent.started` fills the rest.
 */
export const createBareSubagent = (
  sessionId: string,
  id: SubagentId,
  at: string,
): StoredSubagent => ({
  sessionId,
  id,
  parentSubagentId: undefined,
  itemId: undefined,
  description: undefined,
  agentType: undefined,
  model: undefined,
  status: "running",
  toolCalls: 0,
  activity: undefined,
  result: undefined,
  usage: undefined,
  usageProcess: undefined,
  startedAt: at,
  endedAt: undefined,
});

/**
 * Returns the subagents an event names, apart from the session-wide
 * `session.started` and `session.exited`, which change every record:
 *
 * - `owner` is the subagent the event is about: the one a `subagent.started`
 *   introduces, or the one an event is attributed to. A record is created for
 *   it when none exists.
 * - `listed` holds the subagents a `subagent` item names in
 *   `detail.subagentIds`, whichever agent reported the item. Their records
 *   only have `itemId` filled, so none is created for them.
 */
export const findSubagentsNamedBy = (
  event: ProviderEvent,
): { readonly owner: SubagentId | undefined; readonly listed: ReadonlyArray<SubagentId> } => {
  const owner = event._tag === "subagent.started" ? event.subagentId : attributeEvent(event);
  const listed =
    (event._tag === "item.started" || event._tag === "item.completed") && event.kind === "subagent"
      ? readListedSubagentIds(event.detail)
      : [];
  return { owner, listed: listed.filter((id) => id !== owner) };
};

/** Returns the subagent ids a `subagent` item's `detail.subagentIds` holds. */
const readListedSubagentIds = (detail: unknown): ReadonlyArray<SubagentId> => {
  const ids = readDetail(detail).subagentIds;
  return Array.isArray(ids) ? ids.filter((id): id is SubagentId => typeof id === "string") : [];
};

/**
 * Returns a running subagent's record as stopped at `at`, or `record` itself
 * when it is no longer running. A subagent never outlives its session's
 * process, so every way a session ends stops its running subagents. No event
 * is made up for a turn the end cut off.
 */
export const stopSubagent = (record: StoredSubagent, at: string): StoredSubagent =>
  record.status === "running"
    ? { ...record, status: "stopped", endedAt: at, activity: undefined }
    : record;

/**
 * Returns a subagent's record after one event. Returns `record` itself when
 * the event changes nothing, so a caller writes and announces only a real
 * change.
 *
 * `lastAssistantText` is the text of the last assistant message in the turn a
 * `turn.completed` ends, read from the transcript of the agent that ran it.
 * It becomes the record's `result`; without it the result stays as it was.
 */
export const computeSubagentAfter = (
  record: StoredSubagent,
  event: ProviderEvent,
  lastAssistantText?: string,
): StoredSubagent => {
  const next = applyEvent(record, event, lastAssistantText);
  const changed = (Object.keys(next) as Array<keyof StoredSubagent>).some(
    (key) => next[key] !== record[key],
  );
  return changed ? next : record;
};

/** Applies one event to a record, without checking whether anything changed. */
const applyEvent = (
  record: StoredSubagent,
  event: ProviderEvent,
  lastAssistantText: string | undefined,
): StoredSubagent => {
  switch (event._tag) {
    case "session.started":
      // A new process counts its usage from zero again.
      return { ...record, usageProcess: undefined };
    case "session.exited":
      return stopSubagent(record, event.at);
    case "subagent.started":
      if (event.subagentId !== record.id) return record;
      return {
        ...record,
        parentSubagentId: record.parentSubagentId ?? event.parentSubagentId,
        itemId: record.itemId ?? event.itemId,
        description: record.description ?? event.description,
      };
    default:
      break;
  }
  if (
    (event._tag === "item.started" || event._tag === "item.completed") &&
    event.kind === "subagent" &&
    record.itemId === undefined &&
    readListedSubagentIds(event.detail).includes(record.id)
  ) {
    return { ...record, itemId: event.itemId };
  }
  if (attributeEvent(event) !== record.id) return record;
  switch (event._tag) {
    case "turn.started":
      return {
        ...record,
        status: "running",
        endedAt: undefined,
        model: event.model ?? record.model,
      };
    case "item.started": {
      const brief =
        event.kind === "user_message" && record.description === undefined
          ? readDetail(event.detail).text
          : undefined;
      return {
        ...record,
        toolCalls: record.toolCalls + (TOOL_CALL_KINDS.has(event.kind) ? 1 : 0),
        activity: buildSubagentActivity(event.kind, event.detail),
        description: typeof brief === "string" ? readFirstLine(brief) : record.description,
      };
    }
    case "turn.completed":
      return {
        ...record,
        status: toEndedStatus(event.state),
        endedAt: event.at,
        activity: undefined,
        result:
          lastAssistantText === undefined
            ? record.result
            : (readFirstLine(lastAssistantText) ?? record.result),
      };
    case "session.usage.updated":
      return { ...record, ...addUsageSnapshot(record, event.usage) };
    default:
      return record;
  }
};

/**
 * Converts a stored record into the API's `Subagent`, leaving out the fields
 * that are absent and the process's usage snapshot.
 */
export const toSubagentRecord = (stored: StoredSubagent): Subagent => ({
  id: stored.id,
  sessionId: stored.sessionId,
  ...(stored.parentSubagentId === undefined ? {} : { parentSubagentId: stored.parentSubagentId }),
  ...(stored.itemId === undefined ? {} : { itemId: stored.itemId }),
  ...(stored.description === undefined ? {} : { description: stored.description }),
  ...(stored.agentType === undefined ? {} : { agentType: stored.agentType }),
  ...(stored.model === undefined ? {} : { model: stored.model }),
  status: stored.status,
  toolCalls: stored.toolCalls,
  ...(stored.activity === undefined ? {} : { activity: stored.activity }),
  ...(stored.result === undefined ? {} : { result: stored.result }),
  ...(stored.usage === undefined ? {} : { usage: stored.usage }),
  startedAt: stored.startedAt,
  ...(stored.endedAt === undefined ? {} : { endedAt: stored.endedAt }),
});

/**
 * Returns the ids of a subagent and of every subagent below it, found
 * through each record's `parentSubagentId`. Stopping a subagent stops all of
 * them (spec 06 section 13.4).
 */
export const collectSubagentTree = (
  records: ReadonlyArray<Pick<StoredSubagent, "id" | "parentSubagentId">>,
  root: SubagentId,
): ReadonlySet<SubagentId> => {
  const tree = new Set<SubagentId>([root]);
  // Repeats until no record joins, so the order of `records` does not matter.
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of records) {
      if (
        !tree.has(record.id) &&
        record.parentSubagentId !== undefined &&
        tree.has(record.parentSubagentId)
      ) {
        tree.add(record.id);
        grew = true;
      }
    }
  }
  return tree;
};
