/**
 * The thread copy: what the desktop app keeps on disk about a thread it
 * opened lately, so the next open shows the thread without waiting for the
 * controller. This file defines what a copy holds and checks whether a stored
 * value still is one. Storing and deleting copies is the desktop app's job.
 */
import { Schema } from "effect";
import { Input, Session, Subagent, SubagentId, TranscriptRow } from "@hercule/contract";

/**
 * What a thread copy holds: the thread's four reads, and the transcript of
 * each subagent whose page was opened, by subagent id.
 *
 * The copy holds the values the query cache holds (what the derived client
 * returns), so the schema is used on the Type side of each contract schema,
 * which is what `Schema.is` checks.
 */
export const ThreadCopy = Schema.Struct({
  session: Session,
  subagents: Schema.Array(Subagent),
  queuedInputs: Schema.Array(Input),
  transcript: Schema.Array(TranscriptRow),
  subagentTranscripts: Schema.Record(SubagentId, Schema.Array(TranscriptRow)),
});
export type ThreadCopy = Schema.Schema.Type<typeof ThreadCopy>;

/**
 * Returns true when `value` fits the contract's schemas, so it is a
 * ThreadCopy. Never throws.
 *
 * The caller deletes a stored value that fails the check: it was written by an
 * older or newer app, or its storage was damaged, and it cannot be shown. The
 * check does not clone: a value that passes is the copy itself and keeps any
 * extra keys it had. Built once: building the check walks the whole schema,
 * and a copy is checked on every open of a thread.
 */
export const isThreadCopy: (value: unknown) => value is ThreadCopy = Schema.is(ThreadCopy);
