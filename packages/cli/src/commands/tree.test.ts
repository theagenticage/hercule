import { CLI, NOUNS } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { parseArguments } from "./args";
import { COMMANDS, commandAt, mentionsIn } from "./tree";

/**
 * The table, read structurally, so this test asserts the values the contract
 * publishes rather than the shape of its types.
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

const rowOf = (id: string): Row => table[id]!;
const spelling = (command: { readonly spelling: string }): string => command.spelling;

/** `:name` path parameters, in the order the route writes them. */
const pathParams = (path: string): ReadonlyArray<string> =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);

/** The words the CLI reserves everywhere; no command may spell a flag with one. */
const RESERVED_FLAGS = ["json", "help", "home", "all", "limit", "cursor", "sort", "setup-token"];

const KEBAB = /^[a-z]+(-[a-z]+)*$/;

// commands and non-hidden operations are one-to-one.
describe("the command tree", () => {
  it("has exactly one command per visible operation", () => {
    expect(COMMANDS.map((command) => command.id).sort()).toEqual(visible.map(([id]) => id).sort());
  });

  it("names exactly one operation per command, and spells each one once", () => {
    const spellings = COMMANDS.map(spelling);
    expect(new Set(spellings).size).toBe(spellings.length);
    expect(new Set(COMMANDS.map((command) => command.id)).size).toBe(COMMANDS.length);
  });

  it("answers at every command's words, and nowhere for a hidden operation", () => {
    for (const command of COMMANDS) {
      expect(commandAt(command.words)?.id, spelling(command)).toBe(command.id);
    }
    for (const [id] of hidden) {
      const [entity = "", verb = ""] = id.split(".");
      expect(commandAt([entity, verb]), `${id} is hidden`).toBeUndefined();
    }
    expect(commandAt(["auth", "ws-ticket"])).toBeUndefined();
    // The id spelling is not a second way in.
    expect(commandAt(["apiKey", "query"])).toBeUndefined();
    expect(commandAt(["task", "query"])).toBeUndefined();
    expect(commandAt(["runner", "create-join-token"])).toBeUndefined();
  });
});

// how every visible command is spelled.
describe("the spelling of a command", () => {
  it("is the spelling the table writes", () => {
    const spelled = Object.fromEntries(COMMANDS.map((command) => [command.id, spelling(command)]));
    const written = Object.fromEntries(visible.map(([id, row]) => [id, row.command]));
    expect(spelled).toEqual(written);
  });

  it("never takes a query parameter as a bare word", () => {
    // The tree refuses such a row while it builds, so this holds for every
    // command there is; what it asserts is that the rule is applied at all.
    for (const command of COMMANDS) {
      for (const field of command.query) {
        expect(field.positional, `${spelling(command)}: --${field.spelling}`).toBe(false);
      }
    }
  });

  it("writes every word in kebab-case", () => {
    for (const command of COMMANDS) {
      for (const word of command.words) {
        expect(word, `${spelling(command)}: ${word}`).toMatch(KEBAB);
      }
    }
  });

  it("writes every flag in kebab-case, unique within the command", () => {
    for (const command of COMMANDS) {
      const flags = [...command.payload, ...command.query].map((field) => field.spelling);
      for (const flag of flags) {
        expect(flag, `${spelling(command)}: --${flag}`).toMatch(KEBAB);
      }
      expect(new Set(flags).size, `${spelling(command)} repeats a flag`).toBe(flags.length);
    }
  });

  it("never spells a flag with a global or paging name", () => {
    for (const command of COMMANDS) {
      for (const field of [...command.payload, ...command.query]) {
        expect(
          RESERVED_FLAGS.includes(field.spelling),
          `${spelling(command)}: --${field.spelling} is reserved`,
        ).toBe(false);
      }
    }
  });

  it("takes the path parameters positionally, in route order, before any other bare word", () => {
    for (const command of COMMANDS) {
      const inPath = command.positionals.filter((field) => field.carriedIn === "path");
      expect(
        inPath.map((field) => field.name),
        spelling(command),
      ).toEqual(pathParams(command.path));
      // A payload field the table writes as a bare word stands after them, and
      // nothing else is ever a bare word.
      const rest = command.positionals.slice(inPath.length);
      expect(
        rest.every((field) => field.carriedIn === "payload"),
        `${spelling(command)}: ${rest.map((field) => field.name).join(", ")}`,
      ).toBe(true);
    }
  });
});

// the row and the schema say the same thing about the fields. A row that names
// a field the operation does not take, hidden or not, stops the tree from being
// built at all, so every test of this package fails on it.
describe("a command's fields against the schema", () => {
  it("names exactly the fields the schema reflects, and leaves out the ones the row hides", () => {
    for (const command of COMMANDS) {
      const reflected = [...command.positionals, ...command.payload, ...command.query].map(
        (field) => field.name,
      );
      const shown = Object.entries(rowOf(command.id).fields ?? {})
        .filter(([, field]) => field.hidden !== true)
        .map(([name]) => name);
      expect(reflected.sort(), spelling(command)).toEqual(shown.sort());
    }
  });

  it("gives every paged command a non-empty sort field list", () => {
    const paged = COMMANDS.filter((command) => command.paged);
    expect(paged.length).toBeGreaterThan(0);
    for (const command of paged) {
      expect(command.sortFields, spelling(command)).not.toEqual([]);
    }
  });

  it("resolves a tail only through a listing that needs no argument of its own", () => {
    const targets = COMMANDS.flatMap((command) =>
      [...command.positionals, ...command.payload, ...command.query]
        .filter((field) => field.resolves !== undefined)
        .map((field) => [spelling(command), field.name, field.resolves!] as const),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const [where, name, target] of targets) {
      const listing = COMMANDS.find((command) => command.id === target);
      expect(
        listing,
        `${where} <${name}> resolves through ${target}, which is not a command`,
      ).toBeDefined();
      expect(target.split(".")[1], `${target} is not a listing`).toMatch(/^query/);
      expect(listing!.positionals, `${target} takes an argument of its own`).toEqual([]);
    }
  });

  /**
   * Deleting a Permission Profile is refused while a session carries it or an
   * Agent names it. Both listings take the profile, so the user can read back
   * what the refusal is about.
   */
  it("narrows both the session listing and the agent listing by a profile", () => {
    for (const words of [
      ["session", "list"],
      ["agent", "list"],
    ]) {
      const listing = commandAt(words)!;
      const field = listing.query.find((one) => one.name === "permissionProfileId");
      expect(field, words.join(" ")).toBeDefined();
      expect(field!.spelling).toBe("profile");
      expect(field!.resolves).toBe("profile.query");
    }
  });

  it("takes at most one field from stdin, except the two passwords", () => {
    for (const command of COMMANDS) {
      const stdin = [...command.positionals, ...command.payload, ...command.query].filter(
        (field) => field.stdin,
      );
      const expected = command.id === "user.setPassword" ? 2 : 1;
      expect(
        stdin.length,
        `${spelling(command)} reads ${stdin.length} fields from stdin`,
      ).toBeLessThanOrEqual(expected);
    }
    expect(commandAt(["user", "set-password"])!.payload.filter((field) => field.stdin).length).toBe(
      2,
    );
  });

  it("reads a field's kind, its repetition, its optionality and its closed value set", () => {
    const create = commandAt(["profile", "create"])!;
    expect(create.payload.find((field) => field.name === "name")).toMatchObject({
      kind: "string",
      repeated: false,
      optional: false,
    });
    const grants = create.payload.find((field) => field.name === "grants")!;
    expect(grants.repeated).toBe(true);
    expect(grants.choices).toContain("permission.write");

    expect(commandAt(["profile", "update"])!.payload.every((field) => field.optional)).toBe(true);

    expect(commandAt(["secret", "set"])!.positionals[0]?.choices).toEqual([
      "connection",
      "plugin",
      "runner",
      "core",
      "provider-instance",
    ]);
  });
});

describe("the placeholders a usage line shows", () => {
  const shapeOf = (spelled: string): string =>
    commandAt(spelled.split(" "))!
      .positionals.map((field) => `<${field.spelling}>`)
      .join(" ");

  /** Every command whose positionals are not one plain `<id>`. */
  const NAMED: Record<string, string> = {
    "secret set": "<owner-kind> <owner-id> <name>",
    "subscription create": "<target>",
    "secret delete": "<owner-kind> <owner-id> <name>",
    "input list": "<session-id>",
    "input update": "<session-id> <input-id>",
    "input cancel": "<session-id> <input-id>",
    "input steer": "<session-id> <input-id>",
    "transcript read": "<session-id>",
  };

  it("says whose id a positional holds where its own name would not", () => {
    expect(
      Object.fromEntries(Object.keys(NAMED).map((spelled) => [spelled, shapeOf(spelled)])),
    ).toEqual(NAMED);
  });

  it("spells every other positional <id>, and takes none where the table takes none", () => {
    for (const command of COMMANDS) {
      const spelled = spelling(command);
      if (spelled in NAMED) continue;
      expect(shapeOf(spelled), spelled).toMatch(/^(<id>)?$/);
    }
  });
});

// the half the contract's own test leaves to the parser.
describe("every example in the table", () => {
  it("parses through the argument parser it is written for", async () => {
    for (const [id, row] of visible) {
      const command = commandAt((row.command ?? "").split(" "))!;
      for (const [index, example] of (row.examples ?? []).entries()) {
        await expect(
          parseArguments(command, example.args, () => Promise.resolve(example.stdin ?? "")),
          `${id} example ${index}: hercule ${row.command} ${example.args.join(" ")}`,
        ).resolves.toBeDefined();
      }
    }
  });
});

// help that names a command the tree cannot answer to teaches a misspelling.
describe("every command the table's prose names", () => {
  /** Every string a mention can hide in, addressed the way a failure should read. */
  const prose = (): ReadonlyArray<[string, string]> => {
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

  it("resolves against the tree", () => {
    for (const [where, text] of prose()) {
      for (const mention of mentionsIn(text)) {
        expect(
          mention.names,
          `${where} names "hercule ${mention.words.join(" ")}", which is not a command`,
        ).toBeDefined();
      }
    }
  });
});
