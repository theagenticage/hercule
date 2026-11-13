/**
 * Test helpers for the Inbox reads: each one gets the Inbox service when it
 * runs, and the page readers return the reply of the mode they asked for.
 */
import * as Effect from "effect/Effect";
import type { InboxQuery, InboxReply } from "@hercule/contract";
import { externalEntityInbox } from "./inbox-query";

type Inbox = Effect.Success<typeof externalEntityInbox>;

/** What every mode of `queryInbox` selects: its list, and the search inside it. */
export type InboxSelection = Pick<InboxQuery, "list" | "clauses" | "text">;

/** Returns `reply` as the reply of `mode`, or throws when the controller answered another mode. */
export const narrowInboxReply = <Mode extends InboxReply["mode"]>(
  mode: Mode,
  reply: InboxReply,
): Extract<InboxReply, { readonly mode: Mode }> => {
  if (reply.mode !== mode) throw new Error(`expected a ${mode} reply, got ${reply.mode}`);
  return reply as Extract<InboxReply, { readonly mode: Mode }>;
};

/** The Inbox's reads. Each one gets the Inbox service when it runs. */
export const inbox = {
  queryInbox: (...args: Parameters<Inbox["queryInbox"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.queryInbox(...args)),
  readFirstPage: (environment: Parameters<Inbox["queryInbox"]>[0], selection: InboxSelection) =>
    Effect.map(
      Effect.flatMap(externalEntityInbox, (reads) =>
        reads.queryInbox(environment, { mode: "first", ...selection }),
      ),
      (reply) => narrowInboxReply("first", reply),
    ),
  readNextPage: (
    environment: Parameters<Inbox["queryInbox"]>[0],
    selection: InboxSelection,
    after: string,
  ) =>
    Effect.map(
      Effect.flatMap(externalEntityInbox, (reads) =>
        reads.queryInbox(environment, { mode: "next", ...selection, after }),
      ),
      (reply) => narrowInboxReply("next", reply),
    ),
  readRows: (
    environment: Parameters<Inbox["queryInbox"]>[0],
    selection: InboxSelection,
    held: ReadonlyArray<string>,
  ) =>
    Effect.map(
      Effect.flatMap(externalEntityInbox, (reads) =>
        reads.queryInbox(environment, { mode: "rows", ...selection, held: [...held] }),
      ),
      (reply) => narrowInboxReply("rows", reply),
    ),
  readRefresh: (
    environment: Parameters<Inbox["queryInbox"]>[0],
    selection: InboxSelection,
    held: ReadonlyArray<string>,
  ) =>
    Effect.map(
      Effect.flatMap(externalEntityInbox, (reads) =>
        reads.queryInbox(environment, { mode: "refresh", ...selection, held: [...held] }),
      ),
      (reply) => narrowInboxReply("refresh", reply),
    ),
  countInbox: (...args: Parameters<Inbox["countInbox"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.countInbox(...args)),
  readInboxOutline: (...args: Parameters<Inbox["readInboxOutline"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.readInboxOutline(...args)),
  readInboxGroup: (...args: Parameters<Inbox["readInboxGroup"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.readInboxGroup(...args)),
  suggestInboxValues: (...args: Parameters<Inbox["suggestInboxValues"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.suggestInboxValues(...args)),
};
