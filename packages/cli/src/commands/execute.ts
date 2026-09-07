/**
 * Running one command: id tails, paging, and the call itself.
 *
 * Two behaviours live here that the wire deliberately does not have. **Id
 * tails** are resolved client-side through a `query` operation - the entity's
 * own, or its owner's where the command is an owned sub-resource - so the API
 * only ever sees canonical ids. **`--all`** follows `nextCursor` to the end, so a caller who
 * wants everything writes one flag instead of a loop.
 */
import { ApiError, type HydraClient } from "@hydra/client-core";
import type { Arguments } from "./args";
import { queryCommandOf, type Command } from "./tree";

/** The operations, as the dynamic tree reaches them: `client[entity][verb](request)`. */
type Callable = Record<string, Record<string, (request?: unknown) => Promise<unknown>>>;

/** A canonical lowercase UUIDv7, the only id shape the wire carries. */
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The shortest tail that may stand in for an id. */
export const MIN_TAIL = 8;

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
  const call = (client as unknown as Callable)[command.entity]![command.verb]!;
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
 * The entity whose ids an owned sub-resource's `:id` holds.
 *
 * `transcript.read` is `GET /sessions/:id/transcript`, so the id in it is a
 * session's and it is `session.query` that resolves a tail of it. The owner is
 * the path noun in front of the parameter, singularized; a noun whose singular
 * is not an entity resolves nothing, and the caller is told to give the full id
 * exactly as it would have been before.
 */
const ownerOf = (path: string): string => {
  const noun = path.slice(0, path.indexOf("/:id")).split("/").pop() ?? "";
  return noun.endsWith("s") ? noun.slice(0, -1) : noun;
};

/** The `query` operation that resolves a tail written where this command's `id` goes. */
export const idQueryOf = (command: Command): Command | undefined =>
  queryCommandOf(command.entity) ?? queryCommandOf(ownerOf(command.path));

/**
 * The canonical id a positional stands for.
 *
 * A full id is used as written. Anything else is a tail: the entity's `query`
 * operation is paged through and the ids that end with it are the candidates.
 * This costs a round trip and needs the entity's read grant, which is the price
 * of the wire never carrying a tail.
 */
const resolveTail = async (
  client: HydraClient,
  command: Command,
  text: string,
): Promise<string> => {
  if (CANONICAL_ID.test(text)) return text;

  if (text.length < MIN_TAIL) {
    throw new ApiError(
      "validation",
      `${text} is neither an id nor a tail: a tail is at least ${MIN_TAIL} characters`,
    );
  }

  const query = idQueryOf(command);
  if (query === undefined) {
    throw new ApiError(
      "validation",
      `${command.entity} has no query operation, so an id tail cannot be resolved; give the full id`,
    );
  }

  // Ordered by creation, not by the listing's own default. A keyset walk never
  // skips a row only as long as nothing moves the key it walks, and the default
  // order of a task listing is `updatedAt`, which is the one column every write
  // touches: a task updated while the sweep is between pages jumps above the
  // cursor and is never visited, so a tail that exists answers `not_found`.
  // `createdAt` is written once and never again.
  const stable = query.sortFields.includes("createdAt")
    ? { sort: { field: "createdAt", direction: "asc" } }
    : {};
  const items = await readAll(client, query, stable, undefined);
  const matches = items
    .map((item) => item["id"])
    .filter((id): id is string => typeof id === "string" && id.endsWith(text));

  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new ApiError("not_found", `no ${query.entity} whose id ends with ${text}`);
  }
  const tails = matches.map((id) => id.slice(-MIN_TAIL)).join(", ");
  throw new ApiError(
    "conflict",
    `${text} matches ${matches.length} ${query.entity} ids: ${tails}`,
    {
      candidates: matches,
    },
  );
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
  const params: Record<string, string | number> = {};
  for (const [index, field] of command.positionals.entries()) {
    const text = args.positionals[index]!;
    // A numeric path parameter is the value itself, not a tail of a longer id:
    // the event log numbers its rows, and `42` is row 42. Text that is not a
    // number is passed on as written, so the contract refuses it by name.
    if (field.kind === "number") {
      const value = Number(text);
      params[field.name] = text.trim() === "" || Number.isNaN(value) ? text : value;
      continue;
    }
    params[field.name] = field.name === "id" ? await resolveTail(client, command, text) : text;
  }

  // `--limit` is the page size on a `--all` sweep, not a cap on the total: a
  // caller asking for everything is asking for everything.
  const query: Record<string, unknown> = { ...args.query };
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
  if (command.payload.length > 0) request["payload"] = args.payload;

  const call = (client as unknown as Callable)[command.entity]![command.verb]!;
  return {
    kind: "value",
    value: await call(Object.keys(request).length === 0 ? undefined : request),
  };
};
