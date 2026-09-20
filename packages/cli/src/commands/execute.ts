/**
 * Running one command: id tails, paging, and the call itself.
 *
 * Two behaviours live here that the wire deliberately does not have. **Id
 * tails** are resolved client-side through the listing the field's row names -
 * a positional and a flag alike - so the API only ever sees canonical ids.
 * **`--all`** follows `nextCursor` to the end, so a caller who wants everything
 * writes one flag instead of a loop.
 */
import { ApiError, type HydraClient } from "@hydra/client-core";
import { UsageError } from "../exit";
import { coerce, said, type Arguments } from "./args";
import { commandOf, type Command, type Field } from "./tree";

/** The operations, as the dynamic tree reaches them: `client[entity][verb](request)`. */
type Callable = Record<string, Record<string, (request?: unknown) => Promise<unknown>>>;

/** The operation's own function on the client, found by the two halves of its id. */
const callableOf = (client: HydraClient, command: Command) => {
  const [entity, verb] = command.id.split(".") as [string, string];
  return (client as unknown as Callable)[entity]![verb]!;
};

/** A canonical lowercase UUIDv7, the only id shape the wire carries. */
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The shortest tail that may stand in for an id. */
const MIN_TAIL = 8;

interface Page {
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursor?: string;
}

/**
 * Small fixed listings - plugins, provider instances - answer with the whole
 * array. Nothing to follow, so it is read as a single page that ends.
 */
const pageOf = (answer: unknown): Page =>
  Array.isArray(answer)
    ? { items: answer as ReadonlyArray<Record<string, unknown>> }
    : (answer as Page);

/**
 * Every item of a paged operation from `from` onwards, following `nextCursor`
 * to the end. `from` absent starts at the beginning.
 *
 * `params` is what an operation that pages inside one record needs - a
 * transcript is the rows of one session - and is absent for a plain listing.
 *
 * A cursor that does not move is treated as the end rather than as an infinite
 * loop: a broken server should stall the caller once, not forever.
 */
const readAll = async (
  client: HydraClient,
  command: Command,
  query: Record<string, unknown>,
  params: Record<string, string | number> | undefined,
  from?: string,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const call = callableOf(client, command);
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | undefined = from;
  const addressed = params === undefined ? {} : { params };

  for (;;) {
    const page = pageOf(
      await call({ ...addressed, query: cursor === undefined ? query : { ...query, cursor } }),
    );
    items.push(...page.items);
    if (page.nextCursor === undefined || page.nextCursor === cursor) return items;
    cursor = page.nextCursor;
  }
};

/**
 * The canonical id the text written for a field stands for.
 *
 * A full id is used as written. Anything else is a tail: the listing the row
 * names is paged through and the ids that end with it are the candidates. This
 * costs a round trip and needs that listing's read grant, which is the price of
 * the wire never carrying a tail.
 */
const resolveTail = async (
  client: HydraClient,
  command: Command,
  field: Field,
  text: string,
): Promise<string> => {
  if (CANONICAL_ID.test(text)) return text;

  // Too short to be a tail and not an id: the command line is wrong, so
  // nothing is sent, exactly as for a tail nothing can resolve.
  if (text.length < MIN_TAIL) {
    throw new UsageError(
      `${said(field)}: ${text} is neither an id nor a tail: a tail is at least ${MIN_TAIL} characters`,
      command.spelling,
    );
  }

  const listing = commandOf(field.resolves!)!;
  const noun = listing.words[0]!;

  // Ordered by creation, not by the listing's own default. A keyset walk never
  // skips a row only as long as nothing moves the key it walks, and the default
  // order of a task listing is `updatedAt`, which is the one column every write
  // touches: a task updated while the sweep is between pages jumps above the
  // cursor and is never visited, so a tail that exists answers `not_found`.
  // `createdAt` is written once and never again.
  const stable = listing.sortFields.includes("createdAt")
    ? { sort: { field: "createdAt", direction: "asc" } }
    : {};
  const items = await readAll(client, listing, stable, undefined);
  const matches = items
    .map((item) => item["id"])
    .filter((id): id is string => typeof id === "string" && id.endsWith(text));

  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new ApiError("not_found", `no ${noun} whose id ends with ${text}`);
  }
  const tails = matches.map((id) => id.slice(-MIN_TAIL)).join(", ");
  throw new ApiError("conflict", `${text} matches ${matches.length} ${noun} ids: ${tails}`, {
    candidates: matches,
  });
};

/** What a tail looks like, so a field that cannot resolve one can refuse it. */
const LOOKS_LIKE_A_TAIL = /^[0-9a-f]{8,}$/;

/**
 * A field whose row names no listing takes its value as written: a plugin is
 * named `github`, a secret is named `deadbeef` if its owner says so. Where the
 * schema says the field holds a Hydra id, text shaped like a tail is refused
 * rather than sent, because sending it would answer `not_found` and teach the
 * caller that the id was wrong.
 */
const asWritten = (command: Command, field: Field, text: string): string => {
  if (field.holdsAnId && LOOKS_LIKE_A_TAIL.test(text) && !CANONICAL_ID.test(text)) {
    throw new UsageError(
      `${said(field)}: ${text} reads as an id tail, and nothing lists these ids to resolve it against; give the full id`,
      command.spelling,
    );
  }
  return text;
};

/**
 * Resolves every tail among one command's fields, and answers what those
 * fields hold after that. One pass covers a field written as a bare word and a
 * field written as a flag. Where a field holds an id, how the field is spelled
 * on the command line decides nothing: not whether a tail may stand for the
 * id, and not whether a tail that cannot be resolved is refused.
 */
const resolveTails = async (
  client: HydraClient,
  command: Command,
  fields: ReadonlyArray<Field>,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const resolved = { ...values };
  for (const field of fields) {
    const given = resolved[field.name];
    // Three fields are skipped: a field the caller never wrote, a numeric
    // field and a repeated field. No tail stands for any of them.
    if (typeof given !== "string") continue;
    resolved[field.name] =
      field.resolves === undefined
        ? asWritten(command, field, given)
        : await resolveTail(client, command, field, given);
  }
  return resolved;
};

/** What a command produced: an operation's output, or every item of a `--all` sweep. */
export type Outcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "items"; readonly items: ReadonlyArray<Record<string, unknown>> };

export const execute = async (
  client: HydraClient,
  command: Command,
  args: Arguments,
): Promise<Outcome> => {
  const written: Record<string, unknown> = {};
  for (const [index, field] of command.positionals.entries()) {
    // Every positional is checked against its own field here, where a failure
    // is still a usage error and nothing has been sent. A numeric path
    // parameter is the value itself, never a tail of a longer id: the event log
    // numbers its rows, and `42` is row 42.
    written[field.name] = coerce(field, args.positionals[index]!, command.spelling);
  }
  const params = (await resolveTails(client, command, command.positionals, written)) as Record<
    string,
    string | number
  >;
  const payload = await resolveTails(client, command, command.payload, args.payload);
  const query: Record<string, unknown> = await resolveTails(client, command, command.query, {
    ...args.query,
  });

  // `--limit` is the page size on a `--all` sweep, not a cap on the total: a
  // caller asking for everything is asking for everything.
  if (args.limit !== undefined) query["limit"] = args.limit;
  if (args.sort !== undefined) query["sort"] = args.sort;

  // `--cursor` with `--all` is where the sweep starts, not something to drop: a
  // caller who paged to a cursor and then asked for the rest gets the rest.
  if (args.all) {
    return {
      kind: "items",
      items: await readAll(
        client,
        command,
        query,
        command.positionals.length > 0 ? params : undefined,
        args.cursor,
      ),
    };
  }

  if (args.cursor !== undefined) query["cursor"] = args.cursor;

  const request: Record<string, unknown> = {};
  if (command.positionals.length > 0) request["params"] = params;
  if (command.paged || command.query.length > 0) request["query"] = query;
  if (command.payload.length > 0) request["payload"] = payload;

  const call = callableOf(client, command);
  return {
    kind: "value",
    value: await call(Object.keys(request).length === 0 ? undefined : request),
  };
};
