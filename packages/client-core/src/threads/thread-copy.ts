/**
 * The thread copy: what the desktop app keeps on disk about a thread it
 * opened lately, so the next open shows the thread without waiting for the
 * controller. This file knows what a copy holds and whether a stored value
 * still is one. Storing and deleting copies is the desktop app's job.
 */
import { Schema } from "effect";
import { Input, Session, Subagent, SubagentId, TranscriptRow } from "@hercule/contract";

/** What a thread copy holds: the thread's four reads, and the transcript of each subagent opened. */
export interface ThreadCopy {
  readonly session: Session;
  readonly subagents: readonly Subagent[];
  readonly queuedInputs: readonly Input[];
  readonly transcript: readonly TranscriptRow[];
  /** The transcript of each subagent whose page was opened, by subagent id. */
  readonly subagentTranscripts: Readonly<Record<string, readonly TranscriptRow[]>>;
}

/**
 * The shape of a thread copy. The copy holds the values the query cache holds
 * (what the derived client returns), so it is checked against the Type side of
 * each contract schema, which `Schema.is` does. Built once: building the
 * check walks the whole schema, and a copy is checked on every open of a thread.
 */
const isThreadCopy = Schema.is(
  Schema.Struct({
    session: Session,
    subagents: Schema.Array(Subagent),
    queuedInputs: Schema.Array(Input),
    transcript: Schema.Array(TranscriptRow),
    subagentTranscripts: Schema.Record(SubagentId, Schema.Array(TranscriptRow)),
  }),
);

/**
 * Returns `value` as a ThreadCopy when it fits the contract's schemas, or
 * undefined when it does not. Never throws.
 *
 * The caller deletes a copy that comes back undefined: it was written by an
 * older or newer app, or its storage was damaged, and it cannot be shown.
 * The returned copy is `value` itself, not a copy of it, and keeps any extra
 * keys it had.
 */
export const decodeThreadCopy = (value: unknown): ThreadCopy | undefined =>
  isThreadCopy(value) ? value : undefined;
