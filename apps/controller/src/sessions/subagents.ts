/**
 * Works out what one reported event does to a session's subagent records
 * (spec 02 Subagent, spec 06 section 13.2). The code is pure: the service
 * reads the records `findSubagentsToRead` asks for, passes them through
 * `computeSubagentsAfter`, and writes back the ones that changed, in the
 * transaction that appends the event.
 *
 * A session's exit is not handled here. Every way a session ends, a reported
 * exit included, goes through the service's one cleanup step, which stops the
 * session's running subagents with `stopSubagent`. It reads each one's last
 * message from the transcript first, because that message becomes its
 * `result` just as a completed turn's last message does.
 *
 * A record is filled from several events, and a resumed process may know
 * less than an earlier one. So the introduction, `subagent.started`, fills a
 * field only while it is empty and never overwrites one.
 */
import type { ItemKind, ProviderEvent, SubagentId, Usage } from "@hercule/protocol";
import type { Subagent, SubagentStatus } from "@hercule/contract";
import { attributeEvent } from "./stream";
import { addUsageSnapshot, clearProcessShare } from "./usage";

/**
 * A subagent record as stored. Absent fields are `undefined` rather than
 * missing, and `usageProcess` is the current process's last usage snapshot,
 * which `addUsageSnapshot` needs and the API never shows. `lastUsageReport`
 * keeps the provider's original report behind that snapshot for a resume;
 * it is private and survives a process ending or starting.
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
  readonly lastUsageReport: ProviderEvent["raw"];
  readonly startedAt: string;
  readonly endedAt: string | undefined;
}

/**
 * The longest line kept in a text field of a record: `description`,
 * `agentType`, `model`, `activity` or `result`. Each is shown as one line in a
 * list row, and the full text, when there is one, is in the transcript.
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
const truncateToFirstLine = (text: string): string | undefined => {
  const line = (text.trimStart().split("\n")[0] ?? "").trimEnd();
  if (line === "") return undefined;
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line;
};

/** Returns `truncateToFirstLine` of `text`, or `undefined` when there is no text. */
const truncateOptional = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : truncateToFirstLine(text);

/** Returns an item's `detail` as an object, or an empty one when it is not an object. */
const readDetail = (detail: unknown): Readonly<Record<string, unknown>> =>
  typeof detail === "object" && detail !== null && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};

/**
 * Returns the part of an item's `detail` worth naming in `activity`: the
 * command, the path, the search, the tool's name or its description. Each
 * adapter shapes `detail` its own way, so each field is optional.
 *
 * A `subagent` item is named only by the task it hands over, its
 * `description`. Its `name` is the delegating tool, such as Claude's `Agent`
 * or Codex's `spawn_agent`, which says nothing about the work.
 */
const findDetailTarget = (kind: ItemKind, detail: unknown): string | undefined => {
  const fields = readDetail(detail);
  const candidates =
    kind === "subagent"
      ? [fields.description]
      : [fields.command, fields.path, fields.description, fields.name];
  return candidates.find((value): value is string => typeof value === "string");
};

/**
 * Builds the one line that says what a subagent is doing now, from the item it
 * just started, such as "Running npm test" or "Delegating: Chase the flaky
 * test". Returns the bare verb when the item names nothing.
 */
export const buildSubagentActivity = (kind: ItemKind, detail: unknown): string => {
  const verb = ACTIVITY_VERBS[kind];
  const target = findDetailTarget(kind, detail);
  // The colon keeps a delegated task, which is a phrase of its own, apart
  // from the verb.
  const separator = kind === "subagent" ? ": " : " ";
  const line =
    target === undefined ? undefined : truncateToFirstLine(`${verb}${separator}${target}`);
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
  lastUsageReport: undefined,
  startedAt: at,
  endedAt: undefined,
});

/**
 * Returns the subagents an event names. `session.started` names none, though
 * it changes every record (`findSubagentsToRead`).
 *
 * - `owner` is the subagent the event is about: the one a `subagent.started`
 *   introduces, or the one an event is attributed to. A record is created for
 *   it when none exists.
 * - `listed` holds the subagents a `subagent` item names in
 *   `detail.subagentIds`, whichever agent reported the item. The item fills
 *   only their `itemId`. A record is created for one that has none too,
 *   because a parent's item can come before the `subagent.started` that
 *   introduces the subagent, and an adapter lists only subagents it
 *   introduces (spec 06 section 13.2).
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

/**
 * Returns the subagent records an event can change, so the service reads only
 * those: `"all"` for `session.started`, which clears every record's process
 * share of Token Usage, and otherwise the ids the event names. Most events
 * come from the session's own agent and name no subagent, so for them the
 * list is empty and nothing is read.
 */
export const findSubagentsToRead = (event: ProviderEvent): "all" | ReadonlyArray<SubagentId> => {
  if (event._tag === "session.started") return "all";
  const { owner, listed } = findSubagentsNamedBy(event);
  return owner === undefined ? listed : [owner, ...listed];
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
 *
 * `lastAssistantText` is the text of the last assistant message in the turn
 * the end cut off. Its first line becomes the `result`, as it does when a
 * turn completes (`decideResult`).
 */
export const stopSubagent = (
  record: StoredSubagent,
  at: string,
  lastAssistantText: string | undefined,
): StoredSubagent =>
  record.status === "running"
    ? {
        ...record,
        status: "stopped",
        endedAt: at,
        activity: undefined,
        result: decideResult(record.result, lastAssistantText),
      }
    : record;

/**
 * Returns a subagent's `result` after one of its turns ended: the first line
 * of the turn's last assistant message. Returns `previous` when the turn
 * wrote no message or only a blank first line, so a turn that only ran tools
 * keeps the result of the turn before it.
 */
const decideResult = (
  previous: string | undefined,
  lastAssistantText: string | undefined,
): string | undefined =>
  lastAssistantText === undefined ? previous : (truncateToFirstLine(lastAssistantText) ?? previous);

/**
 * What the service reads from the transcript for an event, because the event
 * alone does not carry it. Both are about the event's owner (`findSubagentsNamedBy`).
 */
export interface SubagentEventFacts {
  /**
   * The text of the last assistant message in the turn a `turn.completed`
   * ends. It becomes the record's `result`; without it the result stays as
   * it was.
   */
  readonly lastAssistantText?: string | undefined;
  /**
   * Whether a `user_message` item belongs to the subagent's first turn. Only
   * the first turn's input is the brief its parent gave it, which fills an
   * empty `description` (spec 06 section 13.2).
   */
  readonly inFirstTurn?: boolean | undefined;
}

/**
 * Returns the records one event changes, among `records`, the ones
 * `findSubagentsToRead` asked for. Records the event leaves as they were are
 * not returned.
 *
 * Every subagent the event names (`findSubagentsNamedBy`) that has no record
 * yet gets a bare one, which starts at the event's time and is returned even
 * when the event changes nothing else on it. A later event fills the rest:
 * when a parent's `subagent` item comes before the `subagent.started` that
 * introduces the subagent, the item fills `itemId` and the introduction
 * fills the fields still empty.
 */
export const computeSubagentsAfter = (
  sessionId: string,
  event: ProviderEvent,
  records: ReadonlyMap<SubagentId, StoredSubagent>,
  facts: SubagentEventFacts = {},
): ReadonlyArray<StoredSubagent> => {
  if (event._tag === "session.started") {
    return [...records.values()].flatMap((record) => {
      const next = computeSubagentAfter(record, event);
      return next === record ? [] : [next];
    });
  }
  const { owner, listed } = findSubagentsNamedBy(event);
  const changed: Array<StoredSubagent> = [];
  if (owner !== undefined) {
    const stored = records.get(owner);
    const record = stored ?? createBareSubagent(sessionId, owner, event.at);
    const next = computeSubagentAfter(record, event, facts);
    if (next !== record || stored === undefined) changed.push(next);
  }
  for (const id of listed) {
    const stored = records.get(id);
    const record = stored ?? createBareSubagent(sessionId, id, event.at);
    const next = computeSubagentAfter(record, event);
    if (next !== record || stored === undefined) changed.push(next);
  }
  return changed;
};

/**
 * Returns a subagent's record after one event. Returns `record` itself when
 * the event changes nothing, so a caller writes and announces only a real
 * change. `facts` holds what the transcript adds about the event.
 */
export const computeSubagentAfter = (
  record: StoredSubagent,
  event: ProviderEvent,
  facts: SubagentEventFacts = {},
): StoredSubagent => {
  const next = applyEventToSubagent(record, event, facts);
  const changed = (Object.keys(next) as Array<keyof StoredSubagent>).some(
    (key) => next[key] !== record[key],
  );
  return changed ? next : record;
};

/** Applies one event to a record, without checking whether anything changed. */
const applyEventToSubagent = (
  record: StoredSubagent,
  event: ProviderEvent,
  facts: SubagentEventFacts,
): StoredSubagent => {
  switch (event._tag) {
    case "session.started":
      return { ...record, ...clearProcessShare(record) };
    case "subagent.started":
      if (event.subagentId !== record.id) return record;
      // The harness and the parent agent wrote these, so each is cut to one
      // short line like every other text field of the record.
      return {
        ...record,
        parentSubagentId: record.parentSubagentId ?? event.parentSubagentId,
        itemId: record.itemId ?? event.itemId,
        description: record.description ?? truncateOptional(event.description),
        agentType: record.agentType ?? truncateOptional(event.agentType),
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
        model: truncateOptional(event.model) ?? record.model,
      };
    case "item.started": {
      const brief =
        event.kind === "user_message" && record.description === undefined && facts.inFirstTurn
          ? readDetail(event.detail).text
          : undefined;
      return {
        ...record,
        toolCalls: record.toolCalls + (TOOL_CALL_KINDS.has(event.kind) ? 1 : 0),
        activity: buildSubagentActivity(event.kind, event.detail),
        description: typeof brief === "string" ? truncateToFirstLine(brief) : record.description,
      };
    }
    case "turn.completed":
      return {
        ...record,
        status: toEndedStatus(event.state),
        endedAt: event.at,
        activity: undefined,
        result: decideResult(record.result, facts.lastAssistantText),
      };
    case "session.usage.updated":
      return { ...record, ...addUsageSnapshot(record, event.usage), lastUsageReport: event.raw };
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
