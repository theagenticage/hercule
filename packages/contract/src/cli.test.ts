import { describe, expect, it } from "vitest";
import { CLI, NOUNS } from "./cli";
import { OPERATIONS } from "./operations";

/**
 * The CLI table, read structurally.
 *
 * The test names the shape it depends on rather than importing the table's
 * own types, so what it asserts is the behaviour of the values: a row is
 * hidden, or it carries a spelling, help, examples and a line per field.
 */
interface FieldRow {
  readonly positional?: true;
  readonly stdin?: true;
  readonly flag?: string;
  readonly help?: string;
  readonly resolves?: string;
}

interface Row {
  readonly hidden?: true;
  readonly command?: string;
  readonly help?: string;
  readonly examples?: ReadonlyArray<{
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
  }>;
  readonly fields?: Record<string, FieldRow>;
  readonly errors?: Record<string, string | undefined>;
}

const table: Record<string, Row> = CLI;
const nouns: Record<string, { readonly summary?: string; readonly flow?: string }> = NOUNS;

const rows = Object.entries(table);
const visible = rows.filter(([, row]) => row.hidden !== true);

/** Every field of every visible row, addressed the way a failure should read. */
const fields = (): ReadonlyArray<[string, string, FieldRow]> =>
  visible.flatMap(([id, row]) =>
    Object.entries(row.fields ?? {}).map(
      ([name, field]) => [id, name, field] as [string, string, FieldRow],
    ),
  );

/** The `resolves` every visible field declares, keyed `<operation> <field>`. */
const resolvers = (): Record<string, string | undefined> =>
  Object.fromEntries(fields().map(([id, name, field]) => [`${id} ${name}`, field.resolves]));

/** The three operations a programmatic client calls and a terminal never does. */
const HIDDEN = ["auth.login", "auth.logout", "auth.wsTicket"];

/** The Command table of the SPEC, one line per visible operation. */
const COMMANDS: Record<string, string> = {
  "setup.read": "setup read",
  "setup.complete": "setup complete",

  "apiKey.query": "api-key list",
  "apiKey.create": "api-key create",
  "apiKey.revoke": "api-key revoke",

  "user.setPassword": "user set-password",

  "settings.read": "settings read",
  "settings.update": "settings update",

  "profile.query": "profile list",
  "profile.read": "profile read",
  "profile.create": "profile create",
  "profile.update": "profile update",
  "profile.delete": "profile delete",

  "secret.query": "secret list",
  "secret.set": "secret set",
  "secret.delete": "secret delete",

  "task.query": "task list",
  "task.read": "task read",
  "task.create": "task create",
  "task.update": "task update",
  "task.delete": "task delete",

  "project.query": "project list",
  "project.read": "project read",
  "project.create": "project create",
  "project.update": "project update",
  "project.delete": "project delete",

  "event.query": "event list",
  "event.read": "event read",

  "runner.query": "runner list",
  "runner.read": "runner read",
  "runner.update": "runner update",
  "runner.drain": "runner drain",
  "runner.undrain": "runner undrain",
  "runner.retire": "runner retire",
  "runner.probe": "runner probe",
  "runner.refreshFacts": "runner refresh-facts",
  "runner.installHarness": "runner install-harness",
  "runner.createJoinToken": "runner join-token create",
  "runner.queryJoinTokens": "runner join-token list",
  "runner.revokeJoinToken": "runner join-token revoke",

  "plugin.query": "plugin list",
  "plugin.read": "plugin read",
  "plugin.enable": "plugin enable",
  "plugin.disable": "plugin disable",
  "plugin.retry": "plugin retry",
  "plugin.resetState": "plugin reset-state",
  "plugin.configure": "plugin configure",

  "provider.query": "provider list",
  "provider.read": "provider read",
  "provider.create": "provider create",
  "provider.update": "provider update",
  "provider.delete": "provider delete",
  "provider.login": "provider login",
  "provider.submitLoginCode": "provider submit-login-code",

  "connection.query": "connection list",
  "connection.read": "connection read",
  "connection.create": "connection create",
  "connection.update": "connection update",
  "connection.delete": "connection delete",
  "connection.setCredentials": "connection set-credentials",
  "connection.startOAuth": "connection start-oauth",

  "session.query": "session list",
  "session.read": "session read",
  "session.spawn": "session spawn",
  "session.update": "session update",
  "session.input": "session input",
  "session.interrupt": "session interrupt",
  "session.respond": "session respond",
  "session.stop": "session stop",
  "session.continue": "session continue",

  "input.query": "input list",
  "input.update": "input update",
  "input.cancel": "input cancel",
  "input.steer": "input steer",

  "transcript.read": "transcript read",

  "controller.read": "controller read",
  "controller.update": "controller update",
};

/**
 * Every field whose value is read from stdin rather than given inline, keyed
 * `<operation> <field>`. A command has one stdin channel, so `user.setPassword`
 * is left out here and checked on its own below: it is the one command that
 * reads two fields, one per line.
 */
const STDIN_FIELDS = [
  "setup.complete password",
  "secret.set value",
  "connection.create credentials",
  "connection.setCredentials credentials",
  "task.create description",
  "task.update description",
  "project.create description",
  "project.update description",
  "session.spawn prompt",
  "session.continue prompt",
  "session.input text",
  "input.update text",
  "plugin.configure config",
  "provider.create config",
];

/** Every positional whose id tail is resolved, and the listing that resolves it. */
const RESOLVES: Record<string, string> = {
  "apiKey.revoke id": "apiKey.query",

  "profile.read id": "profile.query",
  "profile.update id": "profile.query",
  "profile.delete id": "profile.query",

  "task.read id": "task.query",
  "task.update id": "task.query",
  "task.delete id": "task.query",

  "project.read id": "project.query",
  "project.update id": "project.query",
  "project.delete id": "project.query",

  "runner.read id": "runner.query",
  "runner.update id": "runner.query",
  "runner.drain id": "runner.query",
  "runner.undrain id": "runner.query",
  "runner.retire id": "runner.query",
  "runner.probe id": "runner.query",
  "runner.refreshFacts id": "runner.query",
  "runner.installHarness id": "runner.query",
  "runner.revokeJoinToken id": "runner.queryJoinTokens",

  "provider.read id": "provider.query",
  "provider.update id": "provider.query",
  "provider.delete id": "provider.query",
  "provider.login id": "provider.query",
  "provider.submitLoginCode id": "provider.query",

  "connection.read id": "connection.query",
  "connection.update id": "connection.query",
  "connection.delete id": "connection.query",
  "connection.setCredentials id": "connection.query",

  "session.read id": "session.query",
  "session.update id": "session.query",
  "session.input id": "session.query",
  "session.interrupt id": "session.query",
  "session.respond id": "session.query",
  "session.stop id": "session.query",
  "session.continue id": "session.query",

  "input.query id": "session.query",
  "input.update id": "session.query",
  "input.cancel id": "session.query",
  "input.steer id": "session.query",

  "transcript.read id": "session.query",
};

/**
 * The one command help may name that no row spells: `hydra login` is
 * hand-written, outside the operation table, and has no row to be found by.
 */
const ALLOWED_MENTIONS = ["login"];

/** Every prose string a mention can hide in. */
const prose = (): ReadonlyArray<[string, string]> => {
  const found: Array<[string, string]> = [];
  for (const [id, row] of visible) {
    if (row.help !== undefined) found.push([`${id} help`, row.help]);
    for (const [code, meaning] of Object.entries(row.errors ?? {})) {
      if (meaning !== undefined) found.push([`${id} errors.${code}`, meaning]);
    }
    for (const [name, field] of Object.entries(row.fields ?? {})) {
      if (field.help !== undefined) found.push([`${id} fields.${name}`, field.help]);
    }
  }
  for (const [noun, entry] of Object.entries(nouns)) {
    if (entry.summary !== undefined) found.push([`${noun} summary`, entry.summary]);
    if (entry.flow !== undefined) found.push([`${noun} flow`, entry.flow]);
  }
  return found;
};

/** `hydra` followed by kebab-case words: a flag, a `<placeholder>` or any other punctuation ends it. */
const mentionsIn = (text: string): ReadonlyArray<ReadonlyArray<string>> =>
  [...text.matchAll(/\bhydra((?:\s+[a-z][a-z-]*)+)/g)].map((match) =>
    match[1]!.trim().split(/\s+/),
  );

describe("the CLI table", () => {
  it("has a row for every operation and no row for anything else", () => {
    expect(Object.keys(table).sort()).toEqual(Object.keys(OPERATIONS).sort());
  });

  it("hides exactly the three operations with no command", () => {
    const hidden = rows.filter(([, row]) => row.hidden === true).map(([id]) => id);
    expect(hidden.sort()).toEqual([...HIDDEN].sort());
  });

  it("spells every visible command the way the command table does", () => {
    const spelled = Object.fromEntries(visible.map(([id, row]) => [id, row.command]));
    expect(spelled).toEqual(COMMANDS);
  });
});

describe("what a visible row says", () => {
  it("gives every row a non-empty purpose", () => {
    for (const [id, row] of visible) {
      expect(row.help?.trim(), `${id} has no help`).toBeTruthy();
    }
  });

  it("gives every row at least one example", () => {
    for (const [id, row] of visible) {
      expect(row.examples?.length ?? 0, `${id} has no example`).toBeGreaterThan(0);
    }
  });

  it("gives every example a command line", () => {
    for (const [id, row] of visible) {
      for (const [index, example] of (row.examples ?? []).entries()) {
        expect(Array.isArray(example.args), `${id} example ${index} has no args`).toBe(true);
      }
    }
  });

  it("gives every field a non-empty line", () => {
    for (const [id, name, field] of fields()) {
      expect(field.help?.trim(), `${id} field ${name} has no help`).toBeTruthy();
    }
  });
});

describe("the nouns", () => {
  it("summarises every root noun of a visible command", () => {
    for (const [id, row] of visible) {
      const noun = (row.command ?? "").split(" ")[0] ?? "";
      expect(nouns[noun], `${id} is under the noun ${noun}, which has no entry`).toBeDefined();
      expect(nouns[noun]?.summary?.trim(), `the noun ${noun} has no summary`).toBeTruthy();
    }
  });
});

describe("the stdin fields", () => {
  it("marks exactly the fields the spec names", () => {
    const marked = fields()
      .filter(([id, , field]) => field.stdin === true && id !== "user.setPassword")
      .map(([id, name]) => `${id} ${name}`);
    expect(marked.sort()).toEqual([...STDIN_FIELDS].sort());
  });

  it("reads both passwords of user set-password from stdin", () => {
    const marked = Object.entries(table["user.setPassword"]?.fields ?? {})
      .filter(([, field]) => field.stdin === true)
      .map(([name]) => name);
    expect(marked.sort()).toEqual(["current", "next"]);
  });
});

describe("the resolvers", () => {
  it("names the listing every resolvable positional resolves through", () => {
    const named = Object.fromEntries(
      Object.entries(resolvers()).filter(([, target]) => target !== undefined),
    );
    expect(named).toEqual(RESOLVES);
  });

  it("leaves an id with no listing of its own unresolved", () => {
    for (const name of ["event.read id", "plugin.configure id", "input.update inputId"]) {
      expect(resolvers()[name], `${name} should take a full id`).toBeUndefined();
    }
  });
});

describe("the commands help names", () => {
  /** Every word sequence the tree answers to: a command, or a prefix of one. */
  const nodes = (): ReadonlySet<string> => {
    const found = new Set<string>();
    const commands = [...visible.map(([, row]) => row.command ?? ""), ...ALLOWED_MENTIONS];
    for (const command of commands) {
      const words = command.split(" ").filter((word) => word.length > 0);
      for (let index = 1; index <= words.length; index += 1) {
        found.add(words.slice(0, index).join(" "));
      }
    }
    return found;
  };

  const commands = (): ReadonlySet<string> =>
    new Set([...visible.map(([, row]) => row.command ?? ""), ...ALLOWED_MENTIONS]);

  it("mentions no command the tree does not answer to", () => {
    const tree = nodes();
    const whole = commands();
    for (const [where, text] of prose()) {
      for (const words of mentionsIn(text)) {
        // The longest prefix the tree knows. Prose may run on after a command,
        // so a mention passes when the tree knows all of it, or when what it
        // knows of it is a whole command.
        let known = 0;
        for (let index = 1; index <= words.length; index += 1) {
          if (tree.has(words.slice(0, index).join(" "))) known = index;
        }
        const named = words.slice(0, known).join(" ");
        const ok = known > 0 && (known === words.length || whole.has(named));
        expect(ok, `${where} names "hydra ${words.join(" ")}", which is not a command`).toBe(true);
      }
    }
  });
});
