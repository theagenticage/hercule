/**
 * Runs one command: resolves id tails, handles paging, and makes the call.
 *
 * These features live here, and the API deliberately does not have them:
 *
 * - **Id tails** are resolved on the client, through the list operation the
 *   field's CLI row names, for positionals and flags alike. The API only ever
 *   receives full ids. A list read within one record, such as a session's
 *   subagents, is read with the command's own path parameters.
 * - **`--all`** follows `nextCursor` to the last page, so a caller who wants
 *   everything writes one flag instead of a loop.
 * - **`--image <path>`** names an image file. The API takes an image's id,
 *   which nobody has before the upload, so the CLI uploads each file with
 *   `attachment.create` and sends the returned ids.
 * - **`<folder>`** names a skill folder, or a folder of skills. A skill's
 *   files travel as one tar archive per request, so the CLI reads the folder
 *   and sends one request per skill.
 * - **`skill apply-updates`** takes no arguments. The CLI reads the Skill
 *   Library and sends every Skill's available revision, so the updates sent
 *   are exactly the ones it prints.
 *
 * The skill folder reader returns Effects, which this module runs to
 * promises; it is the one place the CLI runs an Effect.
 */
import { basename } from "node:path";
import {
  ApiError,
  buildSkillImportQuery,
  checkImageFile,
  describeSkillTooLarge,
  isSkillImportRefusal,
  listSkillUpdates,
  type HerculeClient,
} from "@hercule/client-core";
import { findSkillFolders, buildSkillFolderArchive } from "@hercule/client-core/skill-folder";
import {
  MAX_ATTACHMENTS_PER_INPUT,
  OWN_AGENT_ALIAS,
  type SkillImportResult,
} from "@hercule/contract";
import { Effect, Result } from "effect";
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
 * Converts a list response into a page. Small fixed lists (plugins, Provider
 * Accounts) return the whole array, which becomes a single, last page.
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
 * Returns what a list command lists, in the words of its spelling: "task" for
 * `task list`, "subagent" for `session subagent list`, "join-token" for
 * `runner join-token list`. Every command a tail resolves through is spelled
 * `<words> <noun> list`, which the tree test checks, so the noun is the word
 * before `list`.
 */
const nameListedThing = (listing: Command): string => listing.words.at(-2)!;

/**
 * Returns every id in the list that resolves the tails of `field`, read in
 * full with the field's `resolvesQuery`.
 *
 * A list addressed by path parameters (a session's subagents) is read with
 * the command's own path parameters of the same names, `scope`, so a tail is
 * matched within the record the command names.
 */
const readListedIds = async (
  client: HerculeClient,
  field: Field,
  scope: Record<string, string | number>,
): Promise<ReadonlyArray<string>> => {
  const listing = findCommandById(field.resolves!)!;
  const inPath = listing.positionals.filter((positional) => positional.carriedIn === "path");
  const params =
    inPath.length === 0
      ? undefined
      : Object.fromEntries(inPath.map((positional) => [positional.name, scope[positional.name]!]));

  // Sort by creation time, not by the list's default order. Keyset paging
  // skips no row only as long as the value each row is sorted by does not
  // change between two pages. A task list's default order is `updatedAt`,
  // which every write changes: a task updated between two pages moves above
  // the cursor and is never seen, so a tail that exists would get
  // `not_found`. `createdAt` never changes.
  const stable = listing.sortFields.includes("createdAt")
    ? { sort: [{ field: "createdAt", direction: "asc" }] }
    : {};
  return (await readAll(client, listing, { ...field.resolvesQuery, ...stable }, params))
    .map((item) => item["id"])
    .filter((id): id is string => typeof id === "string");
};

/**
 * Returns the full id that the text given for a field refers to.
 *
 * A canonical id is returned as it is, and so is `me` for a field that holds
 * an id. Anything else is matched against the ids `readIds` returns, which
 * are the whole list the field's row names:
 *
 * - an id equal to the text is returned. Ids a harness chooses, such as a
 *   subagent's, are not UUIDs and may be shorter than a tail;
 * - otherwise the text is a tail, and the ids that end with it are the
 *   candidates.
 *
 * Fails with:
 *
 * - a `UsageError` when the text is too short to be a tail;
 * - a `not_found` `ApiError` when no id matches;
 * - a `conflict` `ApiError` when several ids match.
 *
 * Reading the list costs extra requests and needs the list's read grant.
 * That is the price of the API never accepting a tail.
 */
const resolveTail = async (
  command: Command,
  field: Field,
  text: string,
  readIds: () => Promise<ReadonlyArray<string>>,
): Promise<string> => {
  // `me` is resolved by the controller, which knows which session is asking.
  if (CANONICAL_ID.test(text) || (field.holdsAnId && text === OWN_AGENT_ALIAS)) return text;

  const failTooShort = (): never => {
    throw new UsageError(
      `${formatFieldName(field)}: ${text} is neither an id nor a tail: a tail is at least ${MIN_TAIL} characters`,
      command.spelling,
    );
  };
  // A Hercule id is always canonical, so short text is wrong on the command
  // line, and nothing is sent.
  if (field.holdsAnId && text.length < MIN_TAIL) failTooShort();

  const noun = nameListedThing(findCommandById(field.resolves!)!);
  const ids = await readIds();
  if (ids.includes(text)) return text;
  if (text.length < MIN_TAIL) failTooShort();

  const matches = ids.filter((id) => id.endsWith(text));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    // A Hercule id is canonical and was returned above, so the text of such a
    // field is a tail. Any other id, such as a subagent's, may be given whole,
    // so its message covers both readings.
    throw new ApiError(
      "not_found",
      field.holdsAnId
        ? `no ${noun} whose id ends with ${text}`
        : `no ${noun} has the id ${text} or an id ending with it`,
    );
  }
  // Every match ends with the text, which is at least a tail long, so the
  // matches' tails are all the same and only their whole ids tell them apart.
  throw new ApiError(
    "conflict",
    `${text} matches ${matches.length} ${noun} ids: ${matches.join(", ")}`,
    { candidates: matches },
  );
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
 * and flags alike, and for each id of a repeated field. A field whose row
 * names a list operation may be given a tail, and a tail that matches no id
 * fails. A field whose row names none is
 * sent unchanged, unless it holds a Hercule id and the text looks like a tail
 * (see `validateWrittenId`). `scope` holds the command's resolved path
 * parameters, for a list that is read within one record.
 */
const resolveTails = async (
  client: HerculeClient,
  command: Command,
  fields: ReadonlyArray<Field>,
  values: Record<string, unknown>,
  scope: Record<string, string | number>,
): Promise<Record<string, unknown>> => {
  const resolved = { ...values };
  for (const field of fields) {
    const given = resolved[field.name];
    if (given === undefined) continue;
    // The list is read at most once per field, however many tails it was given.
    let listed: Promise<ReadonlyArray<string>> | undefined;
    const readIds = () => (listed ??= readListedIds(client, field, scope));
    const resolveText = (text: unknown) =>
      // A number holds no tail.
      typeof text !== "string"
        ? text
        : field.resolves === undefined
          ? validateWrittenId(command, field, text)
          : resolveTail(command, field, text, readIds);
    // Each id of a repeated field resolves the way a single one does.
    resolved[field.name] = Array.isArray(given)
      ? await Promise.all(given.map(resolveText))
      : await resolveText(given);
  }
  return resolved;
};

/** One `--image` argument: the path as written, and the file it names, not yet read. */
interface ImageArgument {
  readonly path: string;
  readonly file: Bun.BunFile;
}

/**
 * Checks every image file the command line names, for each upload field, in
 * the order the flags were given, and returns them unread. Throws a
 * `UsageError` when there are more files than one input carries, or when a
 * file does not exist, is not a PNG, JPEG, GIF or WebP image by its name, is
 * empty, or is larger than an upload accepts.
 *
 * It runs before any request, so a command line that cannot work exits with a
 * usage error and sends nothing. Only the file's size and name are looked at
 * here; the bytes are read one file at a time when each is uploaded, so ten
 * images never sit in memory together. The controller still checks each
 * file's bytes, which are the only proof of its type.
 */
const checkImageArguments = async (
  command: Command,
  payload: Record<string, unknown>,
): Promise<
  ReadonlyArray<{ readonly field: Field; readonly images: ReadonlyArray<ImageArgument> }>
> => {
  const checked = [];
  for (const field of command.payload) {
    const paths = payload[field.name];
    if (!field.uploads || !Array.isArray(paths)) continue;
    const flag = formatFieldName(field);
    if (paths.length > MAX_ATTACHMENTS_PER_INPUT) {
      throw new UsageError(
        `${flag}: ${paths.length} images given, but one input carries at most ${MAX_ATTACHMENTS_PER_INPUT}`,
        command.spelling,
      );
    }
    const images: Array<ImageArgument> = [];
    for (const path of paths as ReadonlyArray<string>) {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        throw new UsageError(`${flag}: ${path} does not exist`, command.spelling);
      }
      const refusal = checkImageFile({ name: path, type: file.type, size: file.size });
      if (refusal !== undefined) throw new UsageError(`${flag}: ${refusal}`, command.spelling);
      images.push({ path, file });
    }
    checked.push({ field, images });
  }
  return checked;
};

/**
 * Uploads every image, one at a time and in order, and puts the returned ids
 * in each upload field of `payload`. Each upload is named after the file
 * alone, never its whole path. A refused upload fails with the controller's
 * `ApiError`, its message prefixed with the file's path so the caller knows
 * which file it was. Images uploaded before the failure are never used, and
 * the controller deletes them after 24 hours.
 */
const uploadImages = async (
  client: HerculeClient,
  checked: Awaited<ReturnType<typeof checkImageArguments>>,
  payload: Record<string, unknown>,
): Promise<void> => {
  for (const { field, images } of checked) {
    const ids: Array<string> = [];
    for (const { path, file } of images) {
      const named = new File([file], basename(path), { type: file.type });
      const attachment = await client.uploadAttachment(named).catch((error: unknown) => {
        throw error instanceof ApiError
          ? new ApiError(
              error.code,
              `${formatFieldName(field)} ${path}: ${error.message}`,
              error.details,
            )
          : error;
      });
      ids.push(attachment.id);
    }
    payload[field.name] = ids;
  }
};

/**
 * What happened to one skill of a skill folder: the controller's answer, or
 * why the skill was refused. A refusal is the controller's error, or a
 * sentence when the CLI refused the skill before sending it.
 */
export type SentSkill =
  | { readonly name: string; readonly answer: SkillImportResult }
  | { readonly name: string; readonly refusal: ApiError | string };

/**
 * The result of a command: an operation's output, every item of an `--all`
 * read, or one entry per skill of a skill folder.
 */
export type Outcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "items"; readonly items: ReadonlyArray<Record<string, unknown>> }
  | {
      readonly kind: "skills";
      readonly skills: ReadonlyArray<SentSkill>;
      /** One line about a `.skill-lock.json` that could not be read, or null. */
      readonly lockFileProblem: string | null;
      /**
       * The skill whose request stopped the command, and the error that
       * stopped it, or null when every skill ran. The skills after it were
       * not sent.
       */
      readonly stopped: { readonly name: string; readonly error: unknown } | null;
    };

/**
 * Reads the skill folder the command line names and sends one request per
 * skill in it, one at a time, in name order. Each request carries the
 * query `buildSkillImportQuery` builds (the skill's folder name, and its
 * GitHub source from the lock file when there is one), the command's other
 * query fields, and the skill's tar archive as the body.
 *
 * Each archive is built just before its request and dropped after it, so a
 * folder of many skills never sits in memory at once. A skill whose folder
 * cannot be read, or whose archive is over `MAX_SKILL_BYTES`, is refused by
 * name and not sent: the controller would answer that one with a bare `413`.
 * A skill the controller refuses does not stop the others, with two
 * exceptions, which stop the command at that skill (`stopped`) and keep what
 * the skills before it got:
 *
 * - `forbidden` or `unauthenticated`: the answer is about the credential, not
 *   the skill, so every skill would get it alike.
 * - Any failure that is not the controller refusing one skill, such as a
 *   controller that cannot be reached any more.
 *
 * `isSkillImportRefusal` decides which, as it does for the desktop app's
 * import. Throws a `UsageError` when the folder cannot be read or holds no skill,
 * before anything is sent.
 */
const sendSkillFolder = async (
  client: HerculeClient,
  command: Command,
  field: Field,
  args: Arguments,
): Promise<Outcome> => {
  const given = args.positionals[command.positionals.indexOf(field)]!;
  const found = await Effect.runPromise(Effect.result(findSkillFolders(given)));
  if (Result.isFailure(found)) {
    throw new UsageError(`${formatFieldName(field)}: ${found.failure.reason}`, command.spelling);
  }
  const { displayPath, lockFileProblem, skills } = found.success;
  if (skills.length === 0) {
    throw new UsageError(
      `${formatFieldName(field)}: \`${displayPath}\` holds no skill: neither it nor any folder in it holds a SKILL.md`,
      command.spelling,
    );
  }
  const query = await resolveTails(client, command, command.query, { ...args.query }, {});
  const call = findOperationFunction(client, command);

  const sent: Array<SentSkill> = [];
  for (const skill of skills) {
    const archive = await Effect.runPromise(Effect.result(buildSkillFolderArchive(skill.folder)));
    if (Result.isFailure(archive)) {
      const failure = archive.failure;
      sent.push({
        name: skill.name,
        refusal:
          failure._tag === "SkillTooLarge" ? describeSkillTooLarge(skill.name) : failure.reason,
      });
      continue;
    }
    try {
      const answer = (await call({
        query: { ...query, ...buildSkillImportQuery(skill, query["replace"] === true) },
        payload: archive.success,
      })) as SkillImportResult;
      sent.push({ name: skill.name, answer });
    } catch (error) {
      if (!isSkillImportRefusal(error)) {
        return {
          kind: "skills",
          skills: sent,
          lockFileProblem,
          stopped: { name: skill.name, error },
        };
      }
      sent.push({ name: skill.name, refusal: error });
    }
  }
  return { kind: "skills", skills: sent, lockFileProblem, stopped: null };
};

/**
 * Sends every update waiting in the Skill Library: each Skill whose
 * `availableRevisionHash` is set, named with that hash. Returns the
 * operation's answer, the Skills it changed, as the command's value. With no
 * update waiting, sends nothing and returns an empty list, as the operation
 * would.
 *
 * The hashes sent are the ones just read, so a check that finds something
 * newer in between makes the controller answer `conflict` and apply nothing,
 * rather than apply an update the caller never saw.
 */
const applyAllSkillUpdates = async (client: HerculeClient): Promise<Outcome> => {
  const { items } = await client.skill.query();
  const updates = listSkillUpdates(items);
  if (updates.length === 0) return { kind: "value", value: { items: [] } };
  return { kind: "value", value: await client.skill.applyUpdates({ payload: { updates } }) };
};

/**
 * Runs a command with parsed arguments and returns its result. Fails with a
 * `UsageError` for a bad value, and with the client's errors for a failed call.
 */
export const execute = async (
  client: HerculeClient,
  command: Command,
  args: Arguments,
): Promise<Outcome> => {
  // The operation's one field is hidden from the command line, and its value
  // is read from the Skill Library instead.
  if (command.id === "skill.applyUpdates") return applyAllSkillUpdates(client);
  const folder = command.positionals.find((field) => field.readsSkillFolder);
  if (folder !== undefined) return sendSkillFolder(client, command, folder, args);
  const images = await checkImageArguments(command, args.payload);
  const inPath = command.positionals.filter((field) => field.carriedIn === "path");
  const writtenParams: Record<string, unknown> = {};
  const writtenPayload: Record<string, unknown> = { ...args.payload };
  for (const [index, field] of command.positionals.entries()) {
    // Check every positional against its field here, while a failure is still
    // a usage error and nothing has been sent. A numeric path parameter is the
    // value itself, never a tail of a longer id: the event log numbers its
    // rows, and `42` is row 42.
    // A list positional is the last one and takes every word left.
    const value = field.repeated
      ? args.positionals.slice(index).map((text) => coerceFieldValue(field, text, command.spelling))
      : coerceFieldValue(field, args.positionals[index]!, command.spelling);
    // A positional is a route parameter or a payload field, and is sent in
    // the part of the request its field declares.
    if (field.carriedIn === "payload") writtenPayload[field.name] = value;
    else writtenParams[field.name] = value;
  }
  // A path parameter is resolved through a list of its own, never one read
  // within another record, so it needs no scope.
  const params = (await resolveTails(client, command, inPath, writtenParams, {})) as Record<
    string,
    string | number
  >;
  const payloadFields = [
    ...command.payload,
    ...command.positionals.filter((field) => field.carriedIn === "payload"),
  ];
  const payload = await resolveTails(client, command, payloadFields, writtenPayload, params);
  // Upload only once every id tail has resolved, so a mistyped session id
  // fails before any image is sent.
  await uploadImages(client, images, payload);
  const query: Record<string, unknown> = await resolveTails(
    client,
    command,
    command.query,
    { ...args.query },
    params,
  );

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
