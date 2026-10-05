import { CLI, NOUNS } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { parseArguments } from "./args";
import { COMMANDS, findCommandByWords, findMentions } from "./tree";

/**
 * The CLI table's rows, typed loosely so these tests check the values the
 * contract publishes rather than the shape of its types.
 */
interface RowField {
  readonly positional?: true;
  readonly hidden?: true;
  readonly stdin?: true;
  readonly flag?: string;
  readonly help?: string;
  readonly resolves?: string;
}

interface Row {
  readonly hidden?: true;
  readonly command?: string;
  readonly examples?: ReadonlyArray<{
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
  }>;
  readonly fields?: Record<string, RowField>;
}

const table: Record<string, Row> = CLI;
const visible = Object.entries(table).filter(([, row]) => row.hidden !== true);
const hidden = Object.entries(table).filter(([, row]) => row.hidden === true);

const readRow = (id: string): Row => table[id]!;
const readSpelling = (command: { readonly spelling: string }): string => command.spelling;

/** Returns the `:name` path parameters of a route, in order. */
const listPathParams = (path: string): ReadonlyArray<string> =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);

/** The flag names the CLI reserves everywhere; no command may use one for a field. */
const RESERVED_FLAGS = ["json", "help", "home", "all", "limit", "cursor", "sort", "setup-token"];

const KEBAB = /^[a-z]+(-[a-z]+)*$/;

// Commands and visible operations match one to one.
describe("the command tree", () => {
  it("has exactly one command per visible operation", () => {
    expect(COMMANDS.map((command) => command.id).sort()).toEqual(visible.map(([id]) => id).sort());
  });

  it("maps each command to exactly one operation, with a unique spelling", () => {
    const spellings = COMMANDS.map(readSpelling);
    expect(new Set(spellings).size).toBe(spellings.length);
    expect(new Set(COMMANDS.map((command) => command.id)).size).toBe(COMMANDS.length);
  });

  it("finds every command by its words, and no hidden operation", () => {
    for (const command of COMMANDS) {
      expect(findCommandByWords(command.words)?.id, readSpelling(command)).toBe(command.id);
    }
    for (const [id] of hidden) {
      const [entity = "", verb = ""] = id.split(".");
      expect(findCommandByWords([entity, verb]), `${id} is hidden`).toBeUndefined();
    }
    expect(findCommandByWords(["auth", "ws-ticket"])).toBeUndefined();
    // The operation id is not a second way to call a command.
    expect(findCommandByWords(["apiKey", "query"])).toBeUndefined();
    expect(findCommandByWords(["task", "query"])).toBeUndefined();
    expect(findCommandByWords(["runner", "create-join-token"])).toBeUndefined();
  });
});

// How every visible command is spelled.
describe("the spelling of a command", () => {
  it("is the spelling in the table", () => {
    const spelled = Object.fromEntries(
      COMMANDS.map((command) => [command.id, readSpelling(command)]),
    );
    const written = Object.fromEntries(visible.map(([id, row]) => [id, row.command]));
    expect(spelled).toEqual(written);
  });

  it("never makes a query parameter positional", () => {
    // Building the tree throws for such a row, so this always holds. The test
    // checks that the rule is applied at all.
    for (const command of COMMANDS) {
      for (const field of command.query) {
        expect(field.positional, `${readSpelling(command)}: --${field.spelling}`).toBe(false);
      }
    }
  });

  it("spells every word in kebab-case", () => {
    for (const command of COMMANDS) {
      for (const word of command.words) {
        expect(word, `${readSpelling(command)}: ${word}`).toMatch(KEBAB);
      }
    }
  });

  it("spells every flag in kebab-case, unique within the command", () => {
    for (const command of COMMANDS) {
      const flags = [...command.payload, ...command.query].map((field) => field.spelling);
      for (const flag of flags) {
        expect(flag, `${readSpelling(command)}: --${flag}`).toMatch(KEBAB);
      }
      expect(new Set(flags).size, `${readSpelling(command)} repeats a flag`).toBe(flags.length);
    }
  });

  it("never uses a global or paging flag name for a field", () => {
    for (const command of COMMANDS) {
      for (const field of [...command.payload, ...command.query]) {
        expect(
          RESERVED_FLAGS.includes(field.spelling),
          `${readSpelling(command)}: --${field.spelling} is reserved`,
        ).toBe(false);
      }
    }
  });

  it("takes the path parameters as positionals, in route order, before any other positional", () => {
    for (const command of COMMANDS) {
      const inPath = command.positionals.filter((field) => field.carriedIn === "path");
      expect(
        inPath.map((field) => field.name),
        readSpelling(command),
      ).toEqual(listPathParams(command.path));
      // A payload positional comes after them, and no other field is ever
      // positional.
      const rest = command.positionals.slice(inPath.length);
      expect(
        rest.every((field) => field.carriedIn === "payload"),
        `${readSpelling(command)}: ${rest.map((field) => field.name).join(", ")}`,
      ).toBe(true);
    }
  });
});

// The row and the schema list the same fields. If a row lists a field that the
// operation does not have, hidden or not, building the command tree throws, so
// every test in this package fails.
describe("a command's fields against the schema", () => {
  it("has exactly the fields of the schema, minus the ones the row hides", () => {
    for (const command of COMMANDS) {
      const reflected = [...command.positionals, ...command.payload, ...command.query].map(
        (field) => field.name,
      );
      const shown = Object.entries(readRow(command.id).fields ?? {})
        .filter(([, field]) => field.hidden !== true)
        .map(([name]) => name);
      expect(reflected.sort(), readSpelling(command)).toEqual(shown.sort());
    }
  });

  it("gives every paged command a non-empty sort field list", () => {
    const paged = COMMANDS.filter((command) => command.paged);
    expect(paged.length).toBeGreaterThan(0);
    for (const command of paged) {
      expect(command.sortFields, readSpelling(command)).not.toEqual([]);
    }
  });

  /**
   * A list read within one record, such as a session's subagents, can only
   * resolve a tail when the command names that same record: its route starts
   * with the list's route up to the list's last path parameter. The command
   * then fills the list's path parameters with its own of the same names.
   */
  it("resolves a tail through a list operation that is global, or read within the command's own record", () => {
    const targets = COMMANDS.flatMap((command) =>
      [...command.positionals, ...command.payload, ...command.query]
        .filter((field) => field.resolves !== undefined)
        .map((field) => [command, field] as const),
    );
    expect(targets.length).toBeGreaterThan(0);
    let scoped = 0;
    for (const [command, field] of targets) {
      const where = `${readSpelling(command)} <${field.name}>`;
      const target = field.resolves!;
      const listing = COMMANDS.find((each) => each.id === target);
      expect(listing, `${where} resolves through ${target}, which is not a command`).toBeDefined();
      expect(target.split(".")[1], `${target} is not a listing`).toMatch(/^query/);
      // An error about a tail names what is listed by the word before `list`.
      expect(listing!.words.at(-1), `${target} is not spelled <noun> list`).toBe("list");
      const listingParams = listPathParams(listing!.path);
      expect(
        listing!.positionals.map((positional) => positional.name),
        `${target} takes an argument that is not a path parameter`,
      ).toEqual(listingParams);
      if (listingParams.length === 0) continue;
      scoped += 1;
      // The command's path parameters fill the list's, so the field must not
      // be one of them, and the command must name the same record.
      expect(field.carriedIn, `${where} is a path parameter`).not.toBe("path");
      // The list's route cut just after its last path parameter, such as
      // `/sessions/:id` for `/sessions/:id/subagents`.
      const recordRoute = listing!.path.slice(
        0,
        listing!.path.indexOf(`:${listingParams.at(-1)!}`) + listingParams.at(-1)!.length + 1,
      );
      expect(
        command.path === recordRoute || command.path.startsWith(`${recordRoute}/`),
        `${where} resolves through ${target}, which is read within ${recordRoute}, a record ${command.path} does not name`,
      ).toBe(true);
    }
    expect(scoped, "no field resolves through a list read within a record").toBeGreaterThan(0);
  });

  /**
   * Deleting a Permission Profile fails while a session uses it or an Agent
   * refers to it. Both list operations filter by profile, so the user can see
   * what is blocking the delete.
   */
  it("lets both session list and agent list filter by profile", () => {
    for (const words of [
      ["session", "list"],
      ["agent", "list"],
    ]) {
      const listing = findCommandByWords(words)!;
      const field = listing.query.find((queryField) => queryField.name === "permissionProfileId");
      expect(field, words.join(" ")).toBeDefined();
      expect(field!.spelling).toBe("profile");
      expect(field!.resolves).toBe("profile.query");
    }
  });

  it("lets conversation list filter by assistant", () => {
    const field = findCommandByWords(["conversation", "list"])?.query.find(
      (queryField) => queryField.name === "assistantId",
    );
    expect(field).toBeDefined();
    expect(field!.spelling).toBe("assistant");
    expect(field!.resolves).toBe("assistant.query");
  });

  it("lets session list filter by conversation", () => {
    const field = findCommandByWords(["session", "list"])?.query.find(
      (queryField) => queryField.name === "conversationId",
    );
    expect(field).toBeDefined();
    expect(field!.spelling).toBe("conversation");
    expect(field!.resolves).toBe("conversation.query");
  });

  it("reads the text conversation send sends from stdin", () => {
    const send = findCommandByWords(["conversation", "send"]);
    expect(send).toBeDefined();
    expect(send!.payload.find((field) => field.name === "text")?.stdin).toBe(true);
  });

  it("takes at most one field from stdin, except the two passwords", () => {
    for (const command of COMMANDS) {
      const stdin = [...command.positionals, ...command.payload, ...command.query].filter(
        (field) => field.stdin,
      );
      const expected = command.id === "user.setPassword" ? 2 : 1;
      expect(
        stdin.length,
        `${readSpelling(command)} reads ${stdin.length} fields from stdin`,
      ).toBeLessThanOrEqual(expected);
    }
    expect(
      findCommandByWords(["user", "set-password"])!.payload.filter((field) => field.stdin).length,
    ).toBe(2);
  });

  it("reads a field's kind, whether it repeats, whether it is optional, and its choices", () => {
    const create = findCommandByWords(["profile", "create"])!;
    expect(create.payload.find((field) => field.name === "name")).toMatchObject({
      kind: "string",
      repeated: false,
      optional: false,
    });
    const grants = create.payload.find((field) => field.name === "grants")!;
    expect(grants.repeated).toBe(true);
    expect(grants.choices).toContain("permission.write");

    expect(
      findCommandByWords(["profile", "update"])!.payload.every((field) => field.optional),
    ).toBe(true);

    expect(findCommandByWords(["secret", "set"])!.positionals[0]?.choices).toEqual([
      "connection",
      "plugin",
      "runner",
      "core",
      "provider-instance",
    ]);
  });
});

describe("the placeholders a usage line shows", () => {
  const buildUsageShape = (spelled: string): string =>
    findCommandByWords(spelled.split(" "))!
      .positionals.map((field) => `<${field.spelling}>`)
      .join(" ");

  /** Every command whose positionals are not a single plain `<id>`. */
  const NAMED: Record<string, string> = {
    "secret set": "<owner-kind> <owner-id> <name>",
    "subscription create": "<target>",
    "secret delete": "<owner-kind> <owner-id> <name>",
    "input list": "<session-id>",
    "input update": "<session-id> <input-id>",
    "input cancel": "<session-id> <input-id>",
    "input steer": "<session-id> <input-id>",
    "transcript read": "<session-id>",
    "session subagent list": "<session-id>",
    "assistant read": "<assistant-id>",
    "assistant update": "<assistant-id>",
    "assistant delete": "<assistant-id>",
    "conversation read": "<conversation-id>",
    "conversation message list": "<conversation-id>",
    "conversation send": "<conversation-id>",
    "trigger pause": "<workflow-id> <trigger-id>",
    "trigger resume": "<workflow-id> <trigger-id>",
  };

  it("names whose id a positional holds when the field name alone would not", () => {
    expect(
      Object.fromEntries(Object.keys(NAMED).map((spelled) => [spelled, buildUsageShape(spelled)])),
    ).toEqual(NAMED);
  });

  it("spells every other positional <id>, and has none when the table has none", () => {
    for (const command of COMMANDS) {
      const spelled = readSpelling(command);
      if (spelled in NAMED) continue;
      expect(buildUsageShape(spelled), spelled).toMatch(/^(<id>)?$/);
    }
  });
});

// The contract's own test checks the examples' shape; this checks that the parser accepts them.
describe("every example in the table", () => {
  it("is accepted by the argument parser", async () => {
    for (const [id, row] of visible) {
      const command = findCommandByWords((row.command ?? "").split(" "))!;
      for (const [index, example] of (row.examples ?? []).entries()) {
        await expect(
          parseArguments(command, example.args, () => Promise.resolve(example.stdin ?? "")),
          `${id} example ${index}: hercule ${row.command} ${example.args.join(" ")}`,
        ).resolves.toBeDefined();
      }
    }
  });

  // An optional stdin field is read only with its `--<flag>-stdin` marker. An
  // example that pipes content without the marker teaches a command whose
  // input is dropped without a word.
  it("reads the stdin of every example that pipes one", async () => {
    for (const [id, row] of visible) {
      const command = findCommandByWords((row.command ?? "").split(" "))!;
      for (const [index, example] of (row.examples ?? []).entries()) {
        if (example.stdin === undefined) continue;
        let read = false;
        await parseArguments(command, example.args, () => {
          read = true;
          return Promise.resolve(example.stdin ?? "");
        });
        expect(read, `${id} example ${index} pipes stdin that is never read`).toBe(true);
      }
    }
  });
});

// Help that mentions a command that is not in the tree teaches a misspelling.
describe("every command mentioned in the table's text", () => {
  /** Returns every text that can mention a command, each labelled with where it comes from. */
  const collectProse = (): ReadonlyArray<[string, string]> => {
    const found: Array<[string, string]> = [];
    for (const [id, row] of visible) {
      found.push([`${id} help`, (row as { help?: string }).help ?? ""]);
      for (const [code, meaning] of Object.entries(
        (row as { errors?: Record<string, string> }).errors ?? {},
      )) {
        found.push([`${id} errors.${code}`, meaning]);
      }
      for (const [name, field] of Object.entries(row.fields ?? {})) {
        found.push([`${id} fields.${name}`, field.help ?? ""]);
      }
    }
    for (const [noun, entry] of Object.entries(
      NOUNS as Record<string, { summary?: string; flow?: string }>,
    )) {
      found.push([`${noun} summary`, entry.summary ?? ""]);
      if (entry.flow !== undefined) found.push([`${noun} flow`, entry.flow]);
    }
    return found;
  };

  it("is in the tree", () => {
    for (const [where, text] of collectProse()) {
      for (const mention of findMentions(text)) {
        expect(
          mention.names,
          `${where} names "hercule ${mention.words.join(" ")}", which is not a command`,
        ).toBeDefined();
      }
    }
  });
});
