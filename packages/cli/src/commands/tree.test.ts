import { CLI, OPERATIONS } from "@hydra/contract";
import { describe, expect, it } from "vitest";
import { parseArguments } from "./args";
import { COMMANDS, commandAt } from "./tree";

/**
 * The table, read structurally, so this test asserts the values the contract
 * publishes rather than the shape of its types.
 */
interface RowField {
  readonly positional?: true;
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
const spelling = (command: { readonly words: ReadonlyArray<string> }): string =>
  command.words.join(" ");

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

  it("writes every word in kebab-case", () => {
    for (const command of COMMANDS) {
      for (const word of command.words) {
        expect(word, `${spelling(command)}: ${word}`).toMatch(KEBAB);
      }
    }
  });

  it("writes every flag in kebab-case, unique within the command", () => {
    for (const command of COMMANDS) {
      const flags = [...command.payload, ...command.query].map((field) => field.flag);
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
          RESERVED_FLAGS.includes(field.flag),
          `${spelling(command)}: --${field.flag} is reserved`,
        ).toBe(false);
      }
    }
  });

  it("takes each flag's name from the table", () => {
    for (const command of COMMANDS) {
      const row = rowOf(command.id);
      for (const field of [...command.payload, ...command.query]) {
        expect(field.flag, `${spelling(command)}: ${field.name}`).toBe(
          row.fields?.[field.name]?.flag,
        );
      }
    }
  });

  it("takes the path parameters positionally, in route order", () => {
    for (const command of COMMANDS) {
      expect(
        command.positionals.map((field) => field.name),
        spelling(command),
      ).toEqual(pathParams(command.path));
    }
  });
});

// the row and the schema say the same thing about the fields.
describe("a command's fields against the schema", () => {
  it("names exactly the fields the schema reflects", () => {
    for (const command of COMMANDS) {
      const reflected = [...command.positionals, ...command.payload, ...command.query].map(
        (field) => field.name,
      );
      expect(reflected.sort(), spelling(command)).toEqual(
        Object.keys(rowOf(command.id).fields ?? {}).sort(),
      );
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
      command.positionals
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

  it("marks stdin exactly where the table does", () => {
    for (const command of COMMANDS) {
      const row = rowOf(command.id);
      for (const field of [...command.positionals, ...command.payload, ...command.query]) {
        expect(field.stdin, `${spelling(command)}: ${field.name}`).toBe(
          row.fields?.[field.name]?.stdin === true,
        );
      }
    }
  });

  it("keeps each operation's grant and route as the contract writes them", () => {
    for (const command of COMMANDS) {
      expect({ requires: command.requires, method: command.method, path: command.path }).toEqual(
        OPERATIONS[command.id],
      );
    }
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
      .positionals.map((field) => `<${field.flag}>`)
      .join(" ");

  /** Every command whose positionals are not one plain `<id>`. */
  const NAMED: Record<string, string> = {
    "secret set": "<owner-kind> <owner-id> <name>",
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
          `${id} example ${index}: hydra ${row.command} ${example.args.join(" ")}`,
        ).resolves.toBeDefined();
      }
    }
  });
});
