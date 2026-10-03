/**
 * Runs one command: resolves id tails, handles paging, and makes the call.
 *
 * Two features live here that the API deliberately does not have:
 *
 * - **Id tails** are resolved on the client, through the list operation the
 *   field's CLI row names, for positionals and flags alike. The API only ever
 *   receives full ids.
 * - **`--all`** follows `nextCursor` to the last page, so a caller who wants
 *   everything writes one flag instead of a loop.
 */
import { ApiError, type HerculeClient } from "@hercule/client-core";
import { UsageError } from "../exit";
import { coerceFieldValue, formatFieldName, type Arguments } from "./args";
import { findCommandById, type Command, type Field } from "./tree";

/** The client's operations, as the command tree calls them: `client[entity][verb](request)`. */
type Callable = Record<string, Record<string, (request?: unknown) => Promise<unknown>>>;

/** Returns the client function for a command's operation, found by the two parts of its id. */
const findOperationFunction = (client: HerculeClient, command: Command) => {
  const [entity, verb] = command.id.split(".") as [string, string];
  return (client as unknown as Callable)[entity]![verb]!;
};

/** A canonical lowercase UUIDv7, the only id format the API accepts. */
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The shortest tail that may be used in place of an id. */
const MIN_TAIL = 8;

interface Page {
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursor?: string;
}

/**
 * Converts a list response into a page. Small fixed lists (plugins, provider
 * instances) return the whole array, which becomes a single, last page.
 */
const toPage = (answer: unknown): Page =>
  Array.isArray(answer)
    ? { items: answer as ReadonlyArray<Record<string, unknown>> }
    : (answer as Page);

/**
 * Returns every item of a paged operation from the cursor `from` onwards,
 * following `nextCursor` to the last page. Without `from`, starts at the
 * first page.
 *
 * `params` is needed by an operation that pages inside one record (a
 * transcript is the rows of one session); it is absent for a plain list.
 *
 * A cursor that does not change is treated as the end rather than looping
 * forever: a broken server should stop the caller once, not hang it.
 */
const readAll = async (
  client: HerculeClient,
  command: Command,
  query: Record<string, unknown>,
  params: Record<string, string | number> | undefined,
  from?: string,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const call = findOperationFunction(client, command);
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | undefined = from;
  const addressed = params === undefined ? {} : { params };

  for (;;) {
    const page = toPage(
      await call({ ...addressed, query: cursor === undefined ? query : { ...query, cursor } }),
    );
    items.push(...page.items);
    if (page.nextCursor === undefined || page.nextCursor === cursor) return items;
    cursor = page.nextCursor;
  }
};

/**
 * Returns the full id that the text given for a field refers to.
 *
 * A full id is returned as it is. Anything else is a tail: the list the
 * field's row names is read in full, and the ids that end with the tail are
 * the candidates. Fails with:
 *
 * - a `UsageError` when the text is too short to be a tail;
 * - a `not_found` `ApiError` when no id matches;
 * - a `conflict` `ApiError` when several ids match.
 *
 * This costs extra requests and needs the list's read grant. That is the
 * price of the API never accepting a tail.
 */
const resolveTail = async (
  client: HerculeClient,
  command: Command,
  field: Field,
  text: string,
): Promise<string> => {
  if (CANONICAL_ID.test(text)) return text;

  // Too short to be a tail, and not an id: the command line is wrong, so
  // nothing is sent.
  if (text.length < MIN_TAIL) {
    throw new UsageError(
      `${formatFieldName(field)}: ${text} is neither an id nor a tail: a tail is at least ${MIN_TAIL} characters`,
      command.spelling,
    );
  }

  const listing = findCommandById(field.resolves!)!;
  const noun = listing.words[0]!;

  // Sort by creation time, not by the list's default order. Keyset paging
  // skips no row only as long as the value each row is sorted by does not
  // change between two pages. A task list's default order is `updatedAt`,
  // which every write changes: a task updated between two pages moves above
  // the cursor and is never seen, so a tail that exists would get
  // `not_found`. `createdAt` never changes.
  const stable = listing.sortFields.includes("createdAt")
    ? { sort: [{ field: "createdAt", direction: "asc" }] }
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

/** Matches text that looks like an id tail, so a field that cannot resolve tails can reject it. */
const LOOKS_LIKE_A_TAIL = /^[0-9a-f]{8,}$/;

/**
 * Returns the value of a field whose row names no list operation, unchanged:
 * a plugin is named `github`, and a secret may be named `deadbeef`. But when
 * the schema says the field holds a Hercule id, text that looks like a tail
 * throws a `UsageError` rather than being sent. Sending it would return
 * `not_found`, and the caller would wrongly conclude that the id does not
 * exist.
 */
const validateWrittenId = (command: Command, field: Field, text: string): string => {
  if (field.holdsAnId && LOOKS_LIKE_A_TAIL.test(text) && !CANONICAL_ID.test(text)) {
    throw new UsageError(
      `${formatFieldName(field)}: ${text} looks like an id tail, but there is no list of these ids to look it up in; give the full id`,
      command.spelling,
    );
  }
  return text;
};

/**
 * Resolves every tail in a command's fields to the full id, for positionals
 * and flags alike. A field whose row names a list operation may be given a
 * tail, and a tail that matches no id fails. A field whose row names none is
 * sent unchanged, unless it holds a Hercule id and the text looks like a tail
 * (see `validateWrittenId`).
 */
const resolveTails = async (
  client: HerculeClient,
  command: Command,
  fields: ReadonlyArray<Field>,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const resolved = { ...values };
  for (const field of fields) {
    const given = resolved[field.name];
    // Three kinds of field are skipped: a field the caller never wrote, a numeric
    // field and a repeated field. No tail stands for any of them.
    if (typeof given !== "string") continue;
    resolved[field.name] =
      field.resolves === undefined
        ? validateWrittenId(command, field, given)
        : await resolveTail(client, command, field, given);
  }
  return resolved;
};

/** The result of a command: an operation's output, or every item of an `--all` read. */
export type Outcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "items"; readonly items: ReadonlyArray<Record<string, unknown>> };

/**
 * Runs a command with parsed arguments and returns its result. Fails with a
 * `UsageError` for a bad value, and with the client's errors for a failed call.
 */
export const execute = async (
  client: HerculeClient,
  command: Command,
  args: Arguments,
): Promise<Outcome> => {
  const inPath = command.positionals.filter((field) => field.carriedIn === "path");
  const writtenParams: Record<string, unknown> = {};
  const writtenPayload: Record<string, unknown> = { ...args.payload };
  for (const [index, field] of command.positionals.entries()) {
    // Check every positional against its field here, while a failure is still
    // a usage error and nothing has been sent. A numeric path parameter is the
    // value itself, never a tail of a longer id: the event log numbers its
    // rows, and `42` is row 42.
    const value = coerceFieldValue(field, args.positionals[index]!, command.spelling);
    // A positional is a route parameter or a payload field, and is sent in
    // the part of the request its field declares.
    if (field.carriedIn === "payload") writtenPayload[field.name] = value;
    else writtenParams[field.name] = value;
  }
  const params = (await resolveTails(client, command, inPath, writtenParams)) as Record<
    string,
    string | number
  >;
  const payloadFields = [
    ...command.payload,
    ...command.positionals.filter((field) => field.carriedIn === "payload"),
  ];
  const payload = await resolveTails(client, command, payloadFields, writtenPayload);
  const query: Record<string, unknown> = await resolveTails(client, command, command.query, {
    ...args.query,
  });

  // With `--all`, `--limit` is the page size, not a limit on the total: a
  // caller asking for everything gets everything.
  if (args.limit !== undefined) query["limit"] = args.limit;
  if (args.sort !== undefined) query["sort"] = args.sort;

  // With `--all`, `--cursor` is where the read starts, not something to drop:
  // a caller who paged to a cursor and then asks for the rest gets the rest.
  if (args.all) {
    return {
      kind: "items",
      items: await readAll(
        client,
        command,
        query,
        inPath.length > 0 ? params : undefined,
        args.cursor,
      ),
    };
  }

  if (args.cursor !== undefined) query["cursor"] = args.cursor;

  const request: Record<string, unknown> = {};
  if (inPath.length > 0) request["params"] = params;
  if (command.paged || command.query.length > 0) request["query"] = query;
  if (payloadFields.length > 0) request["payload"] = payload;

  const call = findOperationFunction(client, command);
  return {
    kind: "value",
    value: await call(Object.keys(request).length === 0 ? undefined : request),
  };
};
